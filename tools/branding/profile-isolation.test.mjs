import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import { ZOTERO_CONFIG } from '../../resource/config.mjs';
import { transform } from './apply.mjs';

/**
 * Load the real directory selector and profile discovery code with a temporary
 * home. Only OS adapters and preferences are substituted: profile enumeration,
 * precedence, migration decisions and filesystem reads exercise production code.
 * reload() models a second process using the same persisted preference values.
 */
function fixture(t, prefs = {}) {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), 'epilib-profile-isolation-'));
	t.after(() => fs.rmSync(home, { recursive: true, force: true }));
	const profile = path.join(home, 'EpiLibProfiles', 'Profiles', 'abcdefgh.default');
	fs.mkdirSync(profile, { recursive: true });
	const osAdapter = { Path: path, Constants: { Path: { homeDir: home, profileDir: profile } },
		File: { exists: async file => fs.existsSync(file) } };
	const context = vm.createContext({
		ZOTERO_CONFIG, CommandLineOptions: { test: false },
		DOMException,
		ChromeUtils: { importESModule: () => ({ OS: osAdapter }) },
		PathUtils: { parent: path.dirname, filename: path.basename, isAbsolute: path.isAbsolute },
		OS: osAdapter,
		IOUtils: { stat: async file => {
			try { return { lastModified: fs.statSync(file).mtimeMs }; }
			catch (e) { if (e.code === 'ENOENT') e.name = 'NotFoundError'; throw e; }
		} },
		Zotero: {
			debug() {}, logError(e) { throw e; },
			Prefs: { get: key => prefs[key], set: (key, value) => { prefs[key] = value; },
				clear: key => { delete prefs[key]; } },
			File: {
				createDirectoryIfMissingAsync: async dir => fs.mkdirSync(dir, { recursive: true }),
				createDirectoryIfMissing: dir => fs.mkdirSync(dir, { recursive: true }),
				getContentsAsync: async file => fs.readFileSync(file, 'utf8'),
				iterateDirectory: async (dir, callback) => {
					for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
						await callback({ path: path.join(dir, entry.name), isDir: entry.isDirectory() });
					}
				}
			}
		}
	});
	const reload = () => {
		for (const module of ['profile', 'dataDirectory']) {
			vm.runInContext(fs.readFileSync(new URL(`../../chrome/content/zotero/xpcom/${module}.js`, import.meta.url), 'utf8'), context);
		}
	};
	reload();
	return { home, profile, prefs, zotero: context.Zotero, context, reload };
}

/** Write a sentinel fixture, including its parents, without accessing real user data. */
function write(file, value = 'existing data') {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, value);
}

/** Capture bytes and directory entries so missing, changed and newly copied files fail. */
function snapshot(dir) {
	return fs.readdirSync(dir).sort().map(name => {
		const file = path.join(dir, name);
		return [name, fs.statSync(file).isDirectory() ? snapshot(file) : fs.readFileSync(file).toString('hex')];
	});
}

test('fresh startup leaves existing Zotero libraries and profile databases untouched', async t => {
	const { home, profile, prefs, zotero } = fixture(t);
	const originals = [path.join(home, 'Zotero', 'zotero.sqlite'), path.join(profile, 'zotero', 'zotero.sqlite')];
	for (const file of originals) {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, 'existing library; never import or move automatically');
	}
	await zotero.DataDirectory.init();
	assert.equal(zotero.DataDirectory.dir, path.join(home, 'EpiLib'));
	assert.equal(prefs.dataDir, path.join(home, 'EpiLib'));
	assert.equal(fs.existsSync(path.join(home, 'EpiLib', 'zotero.sqlite')), false);
	for (const file of originals) assert.equal(fs.readFileSync(file, 'utf8'), 'existing library; never import or move automatically');
});

test('explicit custom data paths remain authoritative, without copying or renaming them', async t => {
	const { home, prefs, zotero } = fixture(t);
	const custom = path.join(home, 'chosen-library');
	fs.mkdirSync(custom);
	zotero.forceDataDir = custom;
	await zotero.DataDirectory.init();
	assert.equal(zotero.DataDirectory.dir, custom);
	assert.equal(fs.existsSync(path.join(home, 'EpiLib')), false);
	delete zotero.forceDataDir;
	prefs.useDataDir = true;
	prefs.dataDir = custom;
	await zotero.DataDirectory.init();
	assert.equal(zotero.DataDirectory.dir, custom);
});

test('profile-relative data stays in epilib instead of reusing a zotero subdirectory', async t => {
	const { profile, zotero } = fixture(t);
	zotero.forceDataDir = 'profile';
	await zotero.DataDirectory.init();
	assert.equal(zotero.DataDirectory.dir, path.join(profile, 'epilib'));
});

test('fresh startup and restart never import databases, PDFs, preferences or credentials', async t => {
	const f = fixture(t);
	const official = path.join(f.home, 'Zotero');
	const oldProfile = path.join(f.home, 'ZoteroProfiles', 'Profiles', '12345678.default');
	for (const file of ['zotero.sqlite', 'zotero.sqlite.bak', 'storage/ABCDEFGH/paper.pdf']) {
		write(path.join(official, file), `official ${file}`);
	}
	for (const file of ['prefs.js', 'logins.json', 'logins.db', 'key4.db', 'cert9.db']) {
		write(path.join(oldProfile, file), `private synthetic ${file}`);
	}
	write(path.join(f.profile, 'zotero', 'zotero.sqlite'), 'old profile-local database');
	const before = [snapshot(official), snapshot(oldProfile), snapshot(f.profile)];
	for (let launch = 0; launch < 2; launch++) {
		f.reload();
		await f.zotero.DataDirectory.init();
		assert.equal(f.zotero.DataDirectory.dir, path.join(f.home, 'EpiLib'));
		assert.equal(f.zotero.DataDirectory.canMigrate(), false);
		assert.deepEqual(fs.readdirSync(f.zotero.DataDirectory.dir), []);
		assert.deepEqual([snapshot(official), snapshot(oldProfile), snapshot(f.profile)], before);
		assert.deepEqual(Object.keys(f.prefs).sort(), ['dataDir', 'useDataDir']);
	}
});

test('an existing EpiLib database is reused without being overwritten or migrated', async t => {
	const f = fixture(t);
	write(path.join(f.home, 'EpiLib', 'zotero.sqlite'), 'EpiLib library');
	write(path.join(f.profile, 'epilib', 'zotero.sqlite'), 'older profile-local EpiLib library');
	const before = snapshot(f.home);
	await f.zotero.DataDirectory.init();
	assert.equal(f.zotero.DataDirectory.getDatabase(), path.join(f.home, 'EpiLib', 'zotero.sqlite'));
	assert.equal(f.prefs.useDataDir, true);
	assert.deepEqual(snapshot(f.home), before);
});

test('profile-local EpiLib discovery ignores a coexisting Zotero database', async t => {
	const f = fixture(t);
	write(path.join(f.profile, 'epilib', 'zotero.sqlite'), 'EpiLib');
	write(path.join(f.profile, 'zotero', 'zotero.sqlite'), 'Zotero');
	const before = snapshot(f.home);
	await f.zotero.DataDirectory.init();
	assert.equal(f.zotero.DataDirectory.dir, path.join(f.profile, 'epilib'));
	assert.deepEqual(snapshot(f.home), before);
});

test('test-mode defaults stay beside the disposable profile, not in the user home', async t => {
	const f = fixture(t);
	f.context.CommandLineOptions.test = true;
	await f.zotero.DataDirectory.init();
	assert.equal(f.zotero.DataDirectory.dir, path.join(path.dirname(f.profile), 'EpiLib'));
	assert.equal(fs.existsSync(path.join(f.home, 'EpiLib')), false);
});

test('command-line override wins over saved preferences without overwriting them', async t => {
	const f = fixture(t);
	const saved = path.join(f.home, 'saved-library');
	const override = path.join(f.home, 'explicit library with spaces');
	fs.mkdirSync(saved);
	Object.assign(f.prefs, { useDataDir: true, dataDir: saved });
	f.zotero.forceDataDir = override;
	await f.zotero.DataDirectory.init();
	assert.equal(f.zotero.DataDirectory.dir, override);
	assert.equal(f.prefs.dataDir, saved);
	assert.equal(f.zotero.DataDirectory.canMigrate(), false);
	delete f.zotero.forceDataDir;
	f.reload();
	await f.zotero.DataDirectory.init();
	assert.equal(f.zotero.DataDirectory.dir, saved);
});

test('a disabled saved path cannot silently select the official library', async t => {
	const f = fixture(t);
	f.prefs.dataDir = path.join(f.home, 'Zotero');
	f.prefs.useDataDir = false;
	write(path.join(f.prefs.dataDir, 'zotero.sqlite'));
	await f.zotero.DataDirectory.init();
	assert.equal(f.zotero.DataDirectory.dir, path.join(f.home, 'EpiLib'));
});

for (const selection of ['command-line', 'saved']) {
	test(`an explicitly selected Zotero path is preserved but never auto-migrated (${selection})`, async t => {
		const f = fixture(t);
		const chosen = path.join(f.home, 'ZoteroProfiles', 'Profiles', '12345678.default', 'zotero');
		write(path.join(chosen, 'zotero.sqlite'));
		if (selection === 'command-line') f.zotero.forceDataDir = chosen;
		else Object.assign(f.prefs, { useDataDir: true, dataDir: chosen });
		await f.zotero.DataDirectory.init();
		assert.equal(f.zotero.DataDirectory.dir, chosen);
		assert.equal(f.zotero.DataDirectory.canMigrate(), false);
		assert.equal(await f.zotero.DataDirectory.checkForMigration(chosen, path.join(f.home, 'EpiLib')), false);
		assert.equal(fs.existsSync(path.join(f.home, 'EpiLib')), false);
	});
}

for (const invalid of ['relative', 'missing-parent', 'missing-saved']) {
	test(`invalid ${invalid} selection fails without falling back to another library`, async t => {
		const f = fixture(t);
		write(path.join(f.home, 'Zotero', 'zotero.sqlite'));
		if (invalid === 'missing-saved') {
			Object.assign(f.prefs, { useDataDir: true, dataDir: path.join(f.home, 'missing') });
		}
		else f.zotero.forceDataDir = invalid === 'relative' ? 'relative/library' : path.join(f.home, 'missing', 'library');
		const before = snapshot(f.home);
		await assert.rejects(f.zotero.DataDirectory.init(), error => {
			assert.match(String(error), /absolute path|not found/);
			return true;
		});
		assert.throws(() => f.zotero.DataDirectory.dir, /not initialized/);
		assert.deepEqual(snapshot(f.home), before);
	});
}

test('real profile discovery only examines EpiLib siblings and separates their defaults', async t => {
	const f = fixture(t);
	const defaultDir = path.join(f.home, 'EpiLib');
	const prefs = `user_pref("extensions.zotero.useDataDir", true);\nuser_pref("extensions.zotero.dataDir", ${JSON.stringify(defaultDir)});`;
	write(path.join(f.home, 'ZoteroProfiles', 'Profiles', '12345678.default', 'prefs.js'), prefs);
	await f.zotero.DataDirectory.init();
	assert.equal(f.zotero.DataDirectory.dir, defaultDir, 'Official profile must not influence discovery');
	const sibling = path.join(path.dirname(f.profile), '87654321.other');
	write(path.join(sibling, 'prefs.js'), prefs);
	delete f.prefs.dataDir;
	delete f.prefs.useDataDir;
	f.reload();
	await f.zotero.DataDirectory.init();
	assert.equal(f.zotero.DataDirectory.dir, defaultDir + ' default');
	assert.equal(fs.readFileSync(path.join(sibling, 'prefs.js'), 'utf8'), prefs);
});

test('database, backups and supporting directories stay within the selected EpiLib library', async t => {
	const f = fixture(t);
	await f.zotero.DataDirectory.init();
	const directory = f.zotero.DataDirectory;
	assert.equal(directory.getDatabase(), path.join(f.home, 'EpiLib', 'zotero.sqlite'));
	assert.equal(directory.getDatabase(undefined, 'bak'), path.join(f.home, 'EpiLib', 'zotero.sqlite.bak'));
	assert.equal(directory.getDatabase('fulltext'), path.join(f.home, 'EpiLib', 'fulltext.sqlite'));
	for (const name of ['storage', 'styles', 'translators', 'tmp']) {
		const dir = directory.getSubdirectory(name, true);
		assert.equal(dir, path.join(f.home, 'EpiLib', name));
		assert.ok(fs.statSync(dir).isDirectory());
	}
});

test('upstream rebranding restores EpiLib profile and data names idempotently', () => {
	for (const [file, source, expected] of [
		['app/assets/application.ini', '[App]\nVendor=Zotero\nName=Zotero\nID=zotero@zotero.org\n', '[App]\nVendor=EpiLib\nName=EpiLib\nID=zotero@zotero.org\n'],
		['resource/config.mjs', "DATA_DIRECTORY_NAME: 'Zotero'", "DATA_DIRECTORY_NAME: 'EpiLib'"]
	]) {
		assert.equal(transform(file, source), expected);
		assert.equal(transform(file, expected), expected);
	}
});
