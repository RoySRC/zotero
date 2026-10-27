import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import test from 'node:test';
import { ZOTERO_CONFIG } from '../../resource/config.mjs';

const { parse } = createRequire(import.meta.url)('acorn');
const source = fs.readFileSync(new URL('../../chrome/content/zotero/xpcom/zotero.js', import.meta.url), 'utf8');
const functions = {};

/** Extract complete production functions by AST boundaries, never by copied logic. */
function collect(node) {
	if (!node || typeof node !== 'object') return;
	if (node.type === 'AssignmentExpression' && node.left.object?.type === 'ThisExpression'
			&& ['getTempDirectory', 'removeTempDirectory'].includes(node.left.property?.name)) {
		functions[node.left.property.name] = source.slice(node.right.start, node.right.end);
	}
	for (const child of Object.values(node)) {
		if (Array.isArray(child)) child.forEach(collect);
		else if (child && typeof child === 'object') collect(child);
	}
}
collect(parse(source, { ecmaVersion: 'latest' }));
assert.deepEqual(Object.keys(functions).sort(), ['getTempDirectory', 'removeTempDirectory']);

/**
 * Run creation and the actual shutdown callback on real disposable files.
 * nsIFile is adapted to Node; each platform uses the same production functions.
 */
function fixture(t, platform, failSystemTemp = false) {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), 'epilib-scratch-isolation-'));
	t.after(() => fs.rmSync(home, { recursive: true, force: true }));
	const blockers = [];
	const warnings = [];
	const file = location => ({ path: location, append(name) { this.path = path.join(this.path, name); } });
	const context = vm.createContext({
		ZOTERO_CONFIG, Ci: { nsIFile: {} },
		Services: { dirsvc: { get() {
			if (failSystemTemp) throw new Error('System temporary directory unavailable');
			return file(home);
		} } },
		IOUtils: { remove: async dir => fs.rmSync(dir, { recursive: true }) },
		AsyncShutdown: { profileBeforeChange: { addBlocker: (name, action) => blockers.push(action) } },
		Zotero: {
			isWin: platform === 'win', isMac: platform === 'mac',
			debug() {}, warn: error => warnings.push(error), logError(error) { throw error; },
			File: { pathToFile: file, createDirectoryIfMissing: dir => fs.mkdirSync(dir.path, { recursive: true }) },
			DataDirectory: { getSubdirectory(name) {
				const dir = path.join(home, 'library', 'EpiLib', name);
				fs.mkdirSync(dir, { recursive: true });
				return dir;
			} }
		}
	});
	vm.runInContext(`var _tmpDir;\n${Object.entries(functions).map(([name, body]) => `Zotero.${name} = ${body};`).join('\n')}`, context);
	return { home, blockers, warnings, zotero: context.Zotero };
}

for (const [platform, expected, official] of [
	['mac', 'org.epilib.epilib', 'org.zotero.zotero'],
	['win', 'EpiLib', 'Zotero'],
	['linux', 'epilib', 'zotero']
]) {
	test(`${platform}: scratch creation, caching and shutdown cannot delete Zotero files`, async t => {
		const f = fixture(t, platform);
		const old = path.join(f.home, official);
		fs.mkdirSync(old);
		fs.writeFileSync(path.join(old, 'in-use.pdf'), 'official data');
		const scratch = f.zotero.getTempDirectory();
		assert.equal(scratch.path, path.join(f.home, expected));
		fs.writeFileSync(path.join(scratch.path, 'temporary.pdf'), 'EpiLib temporary data');
		const second = f.zotero.getTempDirectory();
		assert.equal(second.path, scratch.path);
		second.append('caller-local-path');
		assert.equal(f.zotero.getTempDirectory().path, scratch.path, 'Callers must receive independent nsIFile objects');
		assert.equal(f.blockers.length, 1, 'Register cleanup once');
		await f.blockers[0]();
		assert.equal(fs.existsSync(scratch.path), false);
		assert.equal(fs.readFileSync(path.join(old, 'in-use.pdf'), 'utf8'), 'official data');
		assert.equal(f.warnings.length, 0);
	});

	test(`${platform}: unavailable system temp falls back only within EpiLib's selected library`, async t => {
		const f = fixture(t, platform, true);
		const scratch = f.zotero.getTempDirectory();
		assert.equal(scratch.path, path.join(f.home, 'library', 'EpiLib', 'tmp'));
		assert.equal(f.warnings.length, 1);
		await f.blockers[0]();
		assert.equal(fs.existsSync(scratch.path), false);
	});
}
