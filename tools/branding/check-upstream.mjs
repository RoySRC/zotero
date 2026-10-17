import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { apply, root, config, assets, git } from './apply.mjs';
import { brandText } from './rebrand-workspace.mjs';
const { parse } = createRequire(import.meta.url)('@babel/parser');
const fluent = createRequire(import.meta.url)('@fluent/syntax');

// Only string values are examined in JS, not namespaces, comments or object keys.
export function references(file, source) {
	const values = [];
	if (/\.(js|jsx|mjs)$/.test(file)) {
		const ast = parse(source, { sourceType: 'unambiguous', allowReturnOutsideFunction: true, plugins: ['jsx'] });
		function visit(node, parent, key) {
			if (!node || typeof node !== 'object') return;
			if (node.type === 'StringLiteral' && !(key === 'key' && !parent.computed)) values.push(node.value);
			if (node.type === 'TemplateElement') values.push(node.value.raw);
			for (const [k, v] of Object.entries(node)) {
				if (k === 'loc' || k === 'extra') continue;
				if (Array.isArray(v)) v.forEach(x => visit(x, node, k));
				else if (v && typeof v === 'object') visit(v, node, k);
			}
		}
		visit(ast);
	}
	else values.push(...source.split('\n').map(x => x.trim()));
	return new Set(values.filter(value => /\bZotero\b/.test(value) && brandText(value) !== value));
}

export function check(directory, base) {
	apply(directory, { check: true });
	for (const [file, patterns] of Object.entries(config.requiredSourcePatterns)) {
		const text = fs.readFileSync(path.join(directory, file), 'utf8');
		for (const pattern of patterns) assert.match(text, new RegExp(pattern, 'm'), `${file}: missing ${pattern}`);
	}
	const prefs = fs.readFileSync(path.join(directory, 'app/assets/prefs.js'), 'utf8');
	const autoUpdates = [...prefs.matchAll(/^pref\("app\.update\.auto",\s*(true|false)\);/gm)];
	assert.equal(autoUpdates.length, 1, 'Expected exactly one automatic-update default');
	assert.equal(autoUpdates[0][1], 'false');
	for (const exception of config.referenceExceptions) {
		assert.ok(exception.file && exception.value && exception.reason, 'Reference exceptions require file, value and reason');
	}
	if (!base) {
		console.log('Branding, assets and compatibility invariants passed (no upstream diff requested)');
		return;
	}
	const errors = [];
	const files = git(directory, 'diff', '--name-only', '--diff-filter=ACMR', '-z', base, '--').split('\0').filter(Boolean);
	for (const file of files) {
		if (Object.hasOwn(assets, file) || file.startsWith('tools/branding/')) continue;
		if (/\.(png|svg|ico|icns)$/.test(file) && /brand|logo|icon|zotero/i.test(file)
				&& /^(app|chrome\/skin)\//.test(file)) {
			errors.push(`${file}: new/changed artwork needs review and an explicit approved-assets entry`);
			continue;
		}
		if (!/^(chrome\/(content|locale)|resource|app|tools\/postgresql-sync-server\/src)\//.test(file)
				|| !/\.(js|jsx|mjs|ftl|properties|dtd|xhtml|html|plist|nsi|nsh|desktop|tag|ini|sh)$/.test(file)) continue;
		let before = '';
		try { before = git(directory, 'show', `${base}:${file}`); }
		catch { /* Newly introduced upstream file. */ }
		const after = fs.readFileSync(path.join(directory, file), 'utf8');
		if (file.endsWith('.ftl')) {
			const junk = value => fluent.parse(value).body.filter(node => node.type === 'Junk').map(node => node.content);
			assert.deepEqual(junk(after), junk(before), `${file}: newly invalid Fluent content`);
		}
		const existing = references(file, before);
		for (const value of references(file, after)) {
			if (existing.has(value)) continue;
			if (config.referenceExceptions.some(x => x.file === file && x.value === value)) continue;
			errors.push(`${file}: review new upstream reference ${JSON.stringify(value)}`);
		}
	}
	assert.equal(errors.length, 0, errors.join('\n'));
	console.log(`Upstream branding review passed for ${files.length} changed files`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	const index = process.argv.indexOf('--base');
	if (index >= 0 && !process.argv[index + 1]) throw new Error('--base requires a commit');
	check(root, index >= 0 ? process.argv[index + 1] : undefined);
}
