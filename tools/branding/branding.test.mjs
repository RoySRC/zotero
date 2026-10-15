import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import os from 'node:os';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { ZOTERO_CONFIG } from '../../resource/config.mjs';
const require = createRequire(import.meta.url);

test('visible name is independent from on-disk and protocol identities', () => {
	assert.equal(ZOTERO_CONFIG.CLIENT_NAME, 'EpiLib');
	assert.equal(ZOTERO_CONFIG.DATA_DIRECTORY_NAME, 'Zotero');
	assert.equal(ZOTERO_CONFIG.ID, 'zotero');
	assert.equal(ZOTERO_CONFIG.GUID, 'zotero@zotero.org');
	assert.equal(ZOTERO_CONFIG.PREF_BRANCH, 'extensions.zotero.');
});

test('a rebrand does not relocate an existing default or test data directory', () => {
	const context = vm.createContext({
		ZOTERO_CONFIG, Zotero: {},
		ChromeUtils: { importESModule: () => ({}) },
		CommandLineOptions: { test: false },
		PathUtils: { parent: path.dirname },
		OS: { Path: path, Constants: { Path: { homeDir: '/home/test', profileDir: '/test/profile' } } }
	});
	vm.runInContext(fs.readFileSync(new URL('../../chrome/content/zotero/xpcom/dataDirectory.js', import.meta.url), 'utf8'), context);
	assert.equal(context.Zotero.DataDirectory.defaultDir, '/home/test/Zotero');
	assert.equal(context.Zotero.DataDirectory.legacyDirName, 'zotero');
	context.CommandLineOptions.test = true;
	assert.equal(context.Zotero.DataDirectory.defaultDir, '/test/Zotero');
});

test('runtime profile identity and update endpoints remain unchanged', () => {
	const ini = fs.readFileSync(new URL('../../app/assets/application.ini', import.meta.url), 'utf8');
	assert.match(ini, /^Name=Zotero$/m);
	assert.match(ini, /^Vendor=Zotero$/m);
	assert.match(ini, /^ID=zotero@zotero.org$/m);
	assert.match(ini, /^URL=https:\/\/www\.zotero\.org\/download\/client\/update\//m);
});

test('desktop and iOS bundle title overlays preserve script paths and are idempotent', async () => {
	const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'epilib-titles-'));
	try {
		const file = path.join(folder, 'reader.html');
		const original = '<title>Zotero Reader</title><script src="resource://zotero/reader.js"></script>';
		const expected = original.replace('Zotero Reader', 'EpiLib Reader');
		fs.writeFileSync(file, original);
		const brandTitles = require('../../js-build/branding.js');
		await brandTitles(folder);
		await brandTitles(folder);
		assert.equal(fs.readFileSync(file, 'utf8'), expected);
		fs.writeFileSync(file, original);
		const script = new URL('../../../zotero-ios/scripts/rebrand-bundle.sh', import.meta.url);
		// This is a workspace migration test; the sibling iOS source is part of its scope.
		execFileSync('bash', [script.pathname, folder]);
		execFileSync('bash', [script.pathname, folder]);
		assert.equal(fs.readFileSync(file, 'utf8'), expected);
	}
	finally { fs.rmSync(folder, { recursive: true, force: true }); }
});
