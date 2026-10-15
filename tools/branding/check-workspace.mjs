// Validate the rebrand diff against HEAD in each sibling repository.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const fluent = require('@fluent/syntax');
const babel = require('@babel/parser');
const root = path.resolve(import.meta.dirname, '../../..');
const repos = ['zotero-desktop', 'zotero-connectors', 'zotero-ios', 'zotero-android', 'safari-app-extension', 'safari-web-extension'];
const urls = source => source.match(/(?:https?|chrome|resource):\/\/[^\s<>"'`)]+/g) || [];
let checked = 0;

for (const repo of repos) {
	const cwd = path.join(root, repo);
	const files = execFileSync('git', ['diff', '--name-only', '--diff-filter=M', '-z'], { cwd, encoding: 'utf8' }).split('\0').filter(Boolean);
	for (const file of files) {
		const data = fs.readFileSync(path.join(cwd, file));
		if (data.includes(0)) continue;
		const after = data.toString('utf8');
		const before = execFileSync('git', ['show', `HEAD:${file}`], { cwd, encoding: 'utf8', maxBuffer: 20e6 });
		const label = `${repo}/${file}`;
		// Newly drawn SVGs need not keep Inkscape/RDF editor metadata from the old artwork.
		if (!file.endsWith('.svg')) assert.deepEqual(urls(after), urls(before), `${label}: a URL changed`);
		const copyright = source => source.split('\n').filter(line => /copyright\s*(?:©|\(c\)|\d)|all rights reserved/i.test(line));
		// CFBundleGetInfoString contains both the product display name and the old credit.
		assert.deepEqual(copyright(after).map(x => x.replaceAll('EpiLib', 'Zotero')), copyright(before), `${label}: attribution changed`);
		if (file.endsWith('.ftl')) {
			const oldAST = fluent.parse(before), newAST = fluent.parse(after);
			assert.equal(newAST.body.filter(n => n.type === 'Junk').length, oldAST.body.filter(n => n.type === 'Junk').length, `${label}: invalid Fluent`);
			assert.deepEqual(newAST.body.map(n => n.id?.name), oldAST.body.map(n => n.id?.name), `${label}: Fluent keys changed`);
		}
		if (/\.(properties|dtd|strings)$/.test(file)) {
			const pattern = file.endsWith('.properties') ? /^([^#!\s][^=\n]*)=/gm
				: file.endsWith('.dtd') ? /<!ENTITY\s+([^\s]+)/g : /^"((?:\\.|[^"\\])*)"\s*=/gm;
			const keys = source => [...source.matchAll(pattern)].map(x => x[1].trim())
				.filter(x => !['about.epilibFork', 'about.upstreamChangelog', 'about.upstreamGetInvolved'].includes(x));
			assert.deepEqual(keys(after), keys(before), `${label}: resource keys changed`);
		}
		if (/\.(mjs|js|jsx)$/.test(file)) {
			babel.parse(after, { sourceType: 'unambiguous', allowReturnOutsideFunction: true, plugins: ['jsx'] });
		}
		if (file.endsWith('.json') && !/manifest(-v3)?\.json$/.test(file)) {
			JSON.parse(after);
		}
		if (file.endsWith('.plist') || file.endsWith('.strings') || file.endsWith('.pbxproj')) {
			execFileSync('plutil', ['-lint', path.join(cwd, file)], { stdio: 'pipe' });
		}
		if (file.endsWith('.xml')) {
			execFileSync('xmllint', ['--nonet', '--noout', path.join(cwd, file)], { stdio: 'pipe' });
			const names = source => [...source.matchAll(/<string\s+name="([^"]+)"/g)].map(x => x[1]);
			assert.deepEqual(names(after), names(before), `${label}: Android resource keys changed`);
		}
		if (/\.sh$/.test(file)) execFileSync('bash', ['-O', 'extglob', '-n', path.join(cwd, file)]);
		checked++;
	}
	console.log(`${repo}: checked ${files.length} modified files`);
}
console.log(`${checked} text files passed URL, attribution and format checks`);
