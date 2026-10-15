// Explicitly reviewed literal replacements. Never apply a source-wide name replacement.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const root = path.resolve(import.meta.dirname, '../../..');

function replace(repo, file, replacements) {
	const filename = path.join(root, repo, file);
	const original = fs.readFileSync(filename, 'utf8');
	let text = original;
	for (const [before, after] of replacements) text = text.replaceAll(before, after);
	if (text !== original) fs.writeFileSync(filename, text);
}
const desktop = 'zotero-desktop';
replace(desktop, 'app/assets/branding/locale/brand.dtd', [['"Zotero"', '"EpiLib"']]);
replace(desktop, 'chrome/content/zotero/locateMenu.js', [['Zotero Locate Engine Manager', 'EpiLib Locate Engine Manager']]);
replace(desktop, 'chrome/content/zotero/zoteroPane.js', [
	['Zotero Restore', 'EpiLib Restore'], ['local Zotero database', 'local EpiLib database']
]);
replace(desktop, 'chrome/content/zotero/xpcom/error.js', [['"Zotero Error"', '"EpiLib Error"']]);
replace(desktop, 'chrome/content/zotero/xpcom/sync/syncRunner.js', [['"Zotero Error"', '"EpiLib Error"']]);
replace(desktop, 'chrome/content/zotero/xpcom/storage/storageLocal.js', [
	['your Zotero data', 'your EpiLib data']
]);
replace(desktop, 'chrome/content/zotero/xpcom/integration.js', [['your Zotero library', 'your EpiLib library']]);
replace(desktop, 'chrome/content/zotero/xpcom/plugins.js', [
	['prevent Zotero from closing', 'prevent EpiLib from closing'], ['the Zotero user interface', 'the EpiLib user interface']
]);
replace(desktop, 'tools/postgresql-sync-server/src/server.mjs', [['Zotero PostgreSQL sync server listening', 'EpiLib PostgreSQL sync server listening']]);
replace(desktop, 'tools/postgresql-sync-server/README.md', [
	['# Zotero PostgreSQL Sync Server', '# EpiLib PostgreSQL Sync Server'],
	['custom Zotero', 'custom EpiLib'], ["Zotero's Account", "EpiLib's Account"],
	["Zotero's PostgreSQL", "EpiLib's PostgreSQL"], ["In Zotero's Run", "In EpiLib's Run"]
]);
replace(desktop, 'package.json', [['"description": "Zotero"', '"description": "EpiLib research library"']]);
for (const file of execFileSync('git', ['ls-files', '-z', 'src'], { cwd: path.join(root, 'zotero-connectors'), encoding: 'utf8' }).split('\0')) {
	if (!file.endsWith('.html') || file.includes('/test/')) continue;
	replace('zotero-connectors', file, [
		['Zotero Connector', 'EpiLib Connector'], ['Zotero - ', 'EpiLib - '],
		['Zotero Item Selector', 'EpiLib Item Selector'], ['Zotero Status', 'EpiLib Status'],
		['Zotero Translator Tester', 'EpiLib Translator Tester']
	]);
}
replace('safari-web-extension', 'ExtensionApp/ExtensionApp/Resources/Base.lproj/Main.html', [
	['ExtensionApp Icon', 'EpiLib Connector Icon'], ['ExtensionApp’s extension', 'EpiLib Connector']
]);
replace('zotero-android', 'app/src/main/java/org/zotero/android/androidx/content/Context.kt', [['"Zotero",', '"EpiLib",']]);

// These buttons open the upstream website, not an EpiLib About dialog.
for (const repo of ['zotero-ios', 'zotero-android']) {
	const files = execFileSync('git', ['ls-files', '-z'], { cwd: path.join(root, repo), encoding: 'utf8' }).split('\0');
	for (const file of files) {
		if (repo === 'zotero-ios' && file.endsWith('/Localizable.strings')) {
			const filename = path.join(root, repo, file);
			fs.writeFileSync(filename, fs.readFileSync(filename, 'utf8').replace(/^("about_zotero" = ".*)(EpiLib)(.*";)$/gm, '$1Zotero$3'));
		}
		if (repo === 'zotero-android' && file.endsWith('/imported_strings.xml')) {
			const filename = path.join(root, repo, file);
			fs.writeFileSync(filename, fs.readFileSync(filename, 'utf8').replace(/(<string name="about_zotero">[^<]*)EpiLib([^<]*<\/string>)/g, '$1Zotero$2'));
		}
	}
}
console.log('Reviewed display labels updated; external service names preserved');
