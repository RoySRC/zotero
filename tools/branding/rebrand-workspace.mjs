// One-time, value-only migration for the sibling EpiLib application repositories.
// Resource identifiers, URLs, copyright notices and wire/storage formats are not renamed.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parse } = require('@fluent/syntax');
const workspace = path.resolve(import.meta.dirname, '../../..');
const write = process.argv.includes('--write');
const repositories = ['zotero-desktop', 'zotero-connectors', 'zotero-ios', 'zotero-android'];
const externalProperties = new Set([
	'install.quickStartGuide', 'upgrade.nonupgradeableDB2', 'dataDir.incompatibleDbVersion.text',
	'errorReport.advanceMessage', 'zotero.preferences.sync.purgeStorage.title',
	'zotero.preferences.sync.reset.restoreFromServer', 'sync.error.usernameNotSet.text',
	'sync.error.invalidClock', 'standalone.corruptInstallation', 'addons.emptyListMessage'
]);

export function brandText(value) {
	const protectedText = [];
	// These are external services, file formats or compatibility paths, not our product.
	value = value.replace(/(?:https?|chrome|resource):\/\/[^\s<>"']+|\b[^\s<>"']+@[^\s<>"']+|online Zotero library|Zotero\s+(?:Storage|Forums|RDF|API|for Firefox|sync server|servers|services|account)\b|[\w./-]*\/Zotero(?:[\/\w.-]*)/g,
		match => `\u0000${protectedText.push(match) - 1}\u0000`);
	value = value.replace(/Zotero(?![\w:/@-]|\.[\w])/g, 'EpiLib');
	value = value.replace(/\b([Aa]) EpiLib\b/g, '$1n EpiLib');
	return value.replace(/\u0000(\d+)\u0000/g, (_, index) => protectedText[index]);
}

function fluent(source) {
	const ast = parse(source, { withSpans: true });
	const edits = [];
	function visit(node) {
		if (!node || typeof node !== 'object') return;
		if (['import-mendeley-cannot-decrypt', 'import-mendeley-unsupported'].includes(node.id?.name)) return;
		if (node.type === 'TextElement') {
			const value = brandText(node.value);
			if (value !== node.value) edits.push([node.span.start, node.span.end, value]);
		}
		else if (!['Comment', 'GroupComment', 'ResourceComment', 'Junk'].includes(node.type)) {
			for (const value of Object.values(node)) {
				if (Array.isArray(value)) value.forEach(visit);
				else visit(value);
			}
		}
	}
	visit(ast);
	for (const [start, end, value] of edits.sort((a, b) => b[0] - a[0])) {
		source = source.slice(0, start) + value + source.slice(end);
	}
	return source;
}

for (const repo of repositories) {
	const root = path.join(workspace, repo);
	const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0');
	let changed = 0;
	for (const file of files) {
		const desktop = repo === 'zotero-desktop' && file.startsWith('chrome/locale/');
		const connector = repo === 'zotero-connectors' && (file === 'src/messages.json' || file.startsWith('src/_locales/'));
		const ios = repo === 'zotero-ios' && /\.lproj\/(?:Localizable|InfoPlist)\.strings$/.test(file);
		const android = repo === 'zotero-android' && /^app\/src\/main\/res\/values[^/]*\/.*\.xml$/.test(file);
		if (!desktop && !connector && !ios && !android) continue;
		const filename = path.join(root, file);
		const original = fs.readFileSync(filename, 'utf8');
		let result = original;
		if (file.endsWith('.ftl')) result = fluent(original);
		else if (file.endsWith('.properties')) {
			result = original.replace(/^([^#!\s][^=\n]*=)(.*)$/gm,
				(_, key, value) => key + (key.startsWith('about.') || key.startsWith('sync.storage.error.zfs.')
					|| externalProperties.has(key.slice(0, -1).trim()) ? value : brandText(value)));
		}
		else if (file.endsWith('.dtd')) {
			result = original.replace(/(<!ENTITY\s+[^\s]+\s+")([^"]*)("\s*>)/g,
				(_, prefix, value, suffix) => prefix + brandText(value) + suffix);
		}
		else if (file.endsWith('.json')) {
			JSON.parse(original);
			result = original.replace(/("message"\s*:\s*)("(?:\\.|[^"\\])*")/g,
				(_, prefix, value) => prefix + JSON.stringify(brandText(JSON.parse(value))));
		}
		else if (ios) {
			result = original.replace(/^("(?:\\.|[^"\\])*"\s*=\s*")((?:\\.|[^"\\])*)(";)/gm,
				(_, prefix, value, suffix) => prefix + brandText(value) + suffix);
		}
		else if (android) {
			result = original.replace(/(<string\b[^>]*>)([\s\S]*?)(<\/string>)/g,
				(_, prefix, value, suffix) => prefix + brandText(value) + suffix);
		}
		if (result !== original) {
			changed++;
			if (write) fs.writeFileSync(filename, result);
		}
	}
	console.log(`${repo}: ${changed} resource files ${write ? 'updated' : 'would change'}`);
}
