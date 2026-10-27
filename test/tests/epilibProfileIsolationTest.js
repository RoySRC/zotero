"use strict";

describe("EpiLib profile and library isolation", function () {
	let home, profile, settings, scope;

	/**
	 * Load the shipped startup modules into a separate scope, substituting only
	 * home/profile paths and preferences. File I/O, profile discovery and SQLite
	 * remain native. Never replace the running app's DataDirectory singleton or
	 * open a user's real library, login database or OS-keychain secrets.
	 */
	function startup() {
		const testOS = {
			...OS,
			Constants: { ...OS.Constants, Path: { ...OS.Constants.Path, homeDir: home, profileDir: profile } }
		};
		const isolated = {
			File: Zotero.File,
			debug: Zotero.debug,
			logError(error) { throw error; },
			Prefs: {
				get(key) { return settings[key]; },
				set(key, value) { settings[key] = value; },
				clear(key) { delete settings[key]; }
			}
		};
		const target = {
			Zotero: isolated, ZOTERO_CONFIG, PathUtils, IOUtils, DOMException,
			CommandLineOptions: { test: false },
			ChromeUtils: {
				importESModule(url) {
					return url.endsWith('/osfile.mjs') ? { OS: testOS } : ChromeUtils.importESModule(url);
				}
			}
		};
		for (const name of ['profile', 'dataDirectory']) {
			Services.scriptloader.loadSubScript(`chrome://zotero/content/xpcom/${name}.js`, target);
		}
		return isolated;
	}

	/** Write a disposable sentinel, preserving its exact bytes for later assertions. */
	async function write(file, contents) {
		await IOUtils.makeDirectory(PathUtils.parent(file), { createAncestors: true });
		await Zotero.File.putContentsAsync(file, contents);
	}

	/** Open a real test database and always close it, including when an assertion fails. */
	async function withDatabase(file, action) {
		const db = new Zotero.DBConnection(file);
		try {
			return await action(db);
		}
		finally {
			await db.closeDatabase();
		}
	}

	beforeEach(async function () {
		home = await getTempDirectory();
		profile = PathUtils.join(home, 'EpiLibProfiles', 'Profiles', 'abcdefgh.default');
		await IOUtils.makeDirectory(profile, { createAncestors: true });
		settings = {};
		scope = startup();
	});

	afterEach(async function () {
		await IOUtils.remove(home, { recursive: true });
	});

	it("leaves an existing Zotero database, PDF and credential stores byte-for-byte untouched", async function () {
		const oldData = PathUtils.join(home, 'Zotero');
		const oldProfile = PathUtils.join(home, 'ZoteroProfiles', 'Profiles', '12345678.default');
		await IOUtils.makeDirectory(oldData);
		const oldDB = PathUtils.join(oldData, 'zotero.sqlite');
		await withDatabase(oldDB, async db => {
			await db.queryAsync('CREATE TABLE sentinel (value TEXT)');
			await db.queryAsync('INSERT INTO sentinel VALUES (?)', ['official library']);
		});
		const paths = [oldDB];
		for (const [file, value] of [
			[PathUtils.join(oldData, 'storage', 'ABCDEFGH', 'paper.pdf'), '%PDF-1.7 synthetic sentinel'],
			[PathUtils.join(profile, 'zotero', 'zotero.sqlite'), 'legacy database'],
			...['prefs.js', 'logins.json', 'logins.db', 'key4.db', 'cert9.db'].map(name =>
				[PathUtils.join(oldProfile, name), 'synthetic credential sentinel'])
		]) {
			await write(file, value);
			paths.push(file);
		}
		const before = await Promise.all(paths.map(file => IOUtils.read(file)));
		await scope.DataDirectory.init();
		assert.equal(scope.DataDirectory.dir, PathUtils.join(home, 'EpiLib'));
		assert.isFalse(scope.DataDirectory.canMigrate());
		assert.isFalse(await IOUtils.exists(scope.DataDirectory.getDatabase()));
		assert.sameMembers(Object.keys(settings), ['dataDir', 'useDataDir']);
		assert.deepEqual(await IOUtils.getChildren(profile), [PathUtils.join(profile, 'zotero')]);
		for (let i = 0; i < paths.length; i++) {
			assert.deepEqual(Array.from(await IOUtils.read(paths[i])), Array.from(before[i]), paths[i]);
		}
	});

	it("reopens only the selected EpiLib SQLite library after restart", async function () {
		await scope.DataDirectory.init();
		const dbPath = scope.DataDirectory.getDatabase();
		await withDatabase(dbPath, async db => {
			await db.queryAsync('CREATE TABLE sentinel (value TEXT)');
			await db.queryAsync('INSERT INTO sentinel VALUES (?)', ['EpiLib-only']);
		});
		// Serialize preferences and reload both production modules to avoid an
		// in-memory directory cache hiding a failure on the next launch.
		settings = JSON.parse(JSON.stringify(settings));
		scope = startup();
		await scope.DataDirectory.init();
		assert.equal(scope.DataDirectory.getDatabase(), dbPath);
		await withDatabase(dbPath, async db => {
			assert.equal(await db.valueQueryAsync('SELECT value FROM sentinel'), 'EpiLib-only');
		});
		assert.isFalse(await IOUtils.exists(PathUtils.join(home, 'Zotero')));
	});

	it("keeps imported PDF bytes and database paths in the runner's isolated EpiLib library", async function () {
		// Exercise the actual attachment importer and application singleton, not
		// the fixture scope. runtests.sh owns this disposable profile and database.
		const expected = PathUtils.join(PathUtils.parent(OS.Constants.Path.profileDir), 'EpiLib');
		assert.equal(Zotero.DataDirectory.dir, expected);
		assert.equal(Zotero.DB.path, PathUtils.join(expected, 'zotero.sqlite'));
		const source = getTestDataDirectory();
		source.append('test.pdf');
		const attachment = await Zotero.Attachments.importFromFile({ file: source });
		try {
			const destination = await attachment.getFilePathAsync();
			assert.equal(PathUtils.parent(destination), PathUtils.join(expected, 'storage', attachment.key));
			assert.deepEqual(Array.from(await IOUtils.read(destination)), Array.from(await IOUtils.read(source.path)));
		}
		finally {
			await attachment.eraseTx();
		}
	});

	it("selects the epilib profile subdirectory without adopting a zotero subdirectory", async function () {
		const oldDB = PathUtils.join(profile, 'zotero', 'zotero.sqlite');
		await write(oldDB, 'untouched');
		scope.forceDataDir = 'profile';
		await scope.DataDirectory.init();
		assert.equal(scope.DataDirectory.dir, PathUtils.join(profile, 'epilib'));
		assert.equal(await Zotero.File.getContentsAsync(oldDB), 'untouched');
		assert.isFalse(await IOUtils.exists(scope.DataDirectory.getDatabase()));
		assert.isFalse(scope.DataDirectory.canMigrate());
	});

	it("honors explicit paths for one launch and preserves the saved path for the next", async function () {
		const saved = PathUtils.join(home, 'saved-library');
		const override = PathUtils.join(home, 'explicit library');
		await IOUtils.makeDirectory(saved);
		settings = { dataDir: saved, useDataDir: true };
		scope = startup();
		scope.forceDataDir = override;
		await scope.DataDirectory.init();
		assert.equal(scope.DataDirectory.dir, override);
		assert.equal(settings.dataDir, saved);
		scope = startup();
		await scope.DataDirectory.init();
		assert.equal(scope.DataDirectory.dir, saved);
		assert.isFalse(await IOUtils.exists(PathUtils.join(home, 'EpiLib')));
	});

	it("fails a missing saved path without silently opening any other library", async function () {
		settings = { dataDir: PathUtils.join(home, 'missing'), useDataDir: true };
		scope = startup();
		let caught;
		try { await scope.DataDirectory.init(); }
		catch (error) { caught = error; }
		assert.ok(caught, 'Startup must reject a missing explicit library');
		assert.equal(caught.name, 'NotFoundError');
		assert.throws(() => scope.DataDirectory.dir, /not initialized/);
		assert.isFalse(await IOUtils.exists(PathUtils.join(home, 'EpiLib')));
	});

	it("discovers only EpiLib sibling profiles and assigns a separate default library", async function () {
		const prefs = `user_pref("extensions.zotero.useDataDir", true);\n`
			+ `user_pref("extensions.zotero.dataDir", ${JSON.stringify(PathUtils.join(home, 'EpiLib'))});`;
		await write(PathUtils.join(home, 'ZoteroProfiles', 'Profiles', '12345678.default', 'prefs.js'), prefs);
		await scope.DataDirectory.init();
		assert.equal(scope.DataDirectory.dir, PathUtils.join(home, 'EpiLib'));
		await write(PathUtils.join(PathUtils.parent(profile), '87654321.other', 'prefs.js'), prefs);
		settings = {};
		scope = startup();
		await scope.DataDirectory.init();
		assert.equal(scope.DataDirectory.dir, PathUtils.join(home, 'EpiLib default'));
	});
});
