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

test('public product links use EpiLib without redirecting services or attribution', () => {
	for (const key of ['START_URL', 'QUICK_START_URL', 'SUPPORT_URL', 'SYNC_INFO_URL',
		'TROUBLESHOOTING_URL', 'FEEDBACK_URL', 'NEW_FEATURES_URL']) {
		assert.equal(ZOTERO_CONFIG[key], 'https://epilib.org/', key);
	}
	for (const key of ['DOWNLOAD_URL', 'CONNECTORS_URL']) {
		assert.equal(ZOTERO_CONFIG[key], 'https://epilib.org/downloads', key);
	}
	for (const [key, value] of Object.entries({
		REPOSITORY_URL: 'https://repo.zotero.org/repo/',
		STREAMING_URL: 'wss://stream.zotero.org/',
		SERVICES_URL: 'https://services.zotero.org/',
		BASE_URI: 'http://zotero.org/',
		CREDITS_URL: 'https://www.zotero.org/support/credits_and_acknowledgments',
		CHANGELOG_URL: 'https://www.zotero.org/support/changelog'
	})) assert.equal(ZOTERO_CONFIG[key], value, key);
});

test('metadata login errors use a separate localization key instead of stale cloud translations', () => {
	const source = fs.readFileSync(new URL('../../chrome/content/zotero/xpcom/sync/syncRunner.js', import.meta.url), 'utf8');
	assert.ok(source.includes("formatValueSync('account-epilib-not-logged-in-text')"));
	assert.ok(!source.includes("formatValueSync('account-not-logged-in-text')"));
	const messages = fs.readFileSync(new URL('../../chrome/locale/en-US/zotero/zotero.ftl', import.meta.url), 'utf8');
	assert.match(messages, /^account-epilib-not-logged-in-text = .*EpiLib account.*configured metadata server/m);
});

test('report submission remains on the existing endpoint pending an EpiLib reporting service', () => {
	for (const file of ['errorReport.xhtml', 'debugViewer.js', 'standalone/standalone.js']) {
		const source = fs.readFileSync(new URL(`../../chrome/content/zotero/${file}`, import.meta.url), 'utf8');
		assert.match(source, /ZOTERO_CONFIG.REPOSITORY_URL \+ "report/);
	}
});

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

test('runtime profile identity is preserved but the upstream binary feed is removed', () => {
	const ini = fs.readFileSync(new URL('../../app/assets/application.ini', import.meta.url), 'utf8');
	assert.match(ini, /^Name=Zotero$/m);
	assert.match(ini, /^Vendor=Zotero$/m);
	assert.match(ini, /^ID=zotero@zotero.org$/m);
	assert.match(ini, /^URL=$/m);
	assert.equal(ZOTERO_CONFIG.REPOSITORY_URL, 'https://repo.zotero.org/repo/');
});

test('error dispatch keeps its compatibility name across the display-name change', () => {
	const context = vm.createContext({ Zotero: {} });
	vm.runInContext(fs.readFileSync(new URL('../../chrome/content/zotero/xpcom/error.js', import.meta.url), 'utf8'), context);
	const error = new context.Zotero.Error('Expired key', context.Zotero.Error.ERROR_API_KEY_INVALID);
	assert.equal(error.name, 'Zotero Error');
	assert.equal(error.error, context.Zotero.Error.ERROR_API_KEY_INVALID);
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
		// Standalone desktop CI does not check out the separate mobile repository.
		if (fs.existsSync(script)) {
			execFileSync('bash', [script.pathname, folder]);
			execFileSync('bash', [script.pathname, folder]);
			assert.equal(fs.readFileSync(file, 'utf8'), expected);
		}
	}
	finally { fs.rmSync(folder, { recursive: true, force: true }); }
});
