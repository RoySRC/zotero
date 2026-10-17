// A standalone, repeatable desktop overlay. No sibling checkouts or rasterizers required.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { desktopResource } from './rebrand-workspace.mjs';

export const root = path.resolve(import.meta.dirname, '../..');
export const config = JSON.parse(fs.readFileSync(new URL('./config.json', import.meta.url)));
export const assets = JSON.parse(fs.readFileSync(new URL('./approved-assets.json', import.meta.url)));
export const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32e6 }).trimEnd();
export const digest = data => createHash('sha256').update(data).digest('hex');

export function transform(file, source) {
	let result = file.startsWith('chrome/locale/') ? desktopResource(file, source) : source;
	for (const [before, after] of config.literalOverrides[file] || []) {
		result = result.replaceAll(before, after.replaceAll('{product}', config.productName));
	}
	// The overlay must never rewrite endpoints, compatibility paths or attribution.
	const urls = text => text.match(/(?:https?|chrome|resource|wss?):\/\/[^\s<>"'`)]+/g) || [];
	assert.deepEqual(urls(result), urls(source), `${file}: overlay changed a URL`);
	const credits = text => text.split('\n').filter(line => /copyright|all rights reserved/i.test(line));
	assert.deepEqual(credits(result), credits(source), `${file}: overlay changed attribution`);
	return result;
}

export function apply(directory, { check = false, base } = {}) {
	const files = git(directory, 'ls-files', '-z').split('\0').filter(Boolean);
	const changes = [];
	for (const file of files) {
		if (!(file.startsWith('chrome/locale/') && /\.(ftl|properties|dtd)$/.test(file))
				&& !Object.hasOwn(config.literalOverrides, file)) continue;
		const filename = path.join(directory, file);
		const source = fs.readFileSync(filename, 'utf8');
		const result = transform(file, source);
		if (result !== source) {
			changes.push(file);
			if (!check) fs.writeFileSync(filename, result);
		}
	}
	for (const [file, hash] of Object.entries(assets)) {
		const filename = path.join(directory, file);
		if (digest(fs.readFileSync(filename)) === hash) continue;
		if (base && !check) {
			const approved = execFileSync('git', ['show', `${base}:${file}`], { cwd: directory, maxBuffer: 32e6 });
			assert.equal(digest(approved), hash, `${file}: target artwork is not approved`);
			fs.writeFileSync(filename, approved);
		}
		else throw new Error(`${file}: artwork differs from approved-assets.json; review it explicitly`);
		changes.push(file);
	}
	if (check && changes.length) throw new Error(`Branding overlay has not been applied:\n${changes.join('\n')}`);
	console.log(`Desktop branding: ${changes.length} files ${check ? 'need changes' : 'updated'}`);
	return changes;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	const args = process.argv.slice(2);
	const baseIndex = args.indexOf('--base');
	if (baseIndex >= 0 && !args[baseIndex + 1]) throw new Error('--base requires a commit');
	apply(root, { check: args.includes('--check'), base: baseIndex >= 0 ? args[baseIndex + 1] : undefined });
}
