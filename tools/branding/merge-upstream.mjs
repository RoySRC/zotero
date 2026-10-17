// Run only in a clean, detached integration checkout. Never merge in a user's worktree.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
// Preparation must work before npm ci in a fresh CI checkout.
const config = JSON.parse(fs.readFileSync(new URL('./config.json', import.meta.url)));
const root = path.resolve(import.meta.dirname, '../..');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trimEnd();

export function prepare(directory, baseRef, upstreamRef) {
	assert.equal(git(directory, 'status', '--porcelain'), '', 'Integration checkout must be clean');
	assert.notEqual(spawnSync('git', ['symbolic-ref', '--quiet', 'HEAD'], { cwd: directory }).status, 0,
		'Use a detached checkout, not a local development branch');
	const base = git(directory, 'rev-parse', '--verify', `${baseRef}^{commit}`);
	const upstream = git(directory, 'rev-parse', '--verify', `${upstreamRef}^{commit}`);
	assert.equal(git(directory, 'rev-parse', 'HEAD'), base, 'HEAD must match the target branch snapshot');
	if (spawnSync('git', ['merge-base', '--is-ancestor', upstream, base], { cwd: directory }).status === 0) {
		return { base, upstream, changed: false };
	}
	const ancestor = git(directory, 'merge-base', base, upstream);
	const incoming = git(directory, 'diff', '--name-only', ancestor, upstream).split('\n');
	assert.ok(!incoming.some(file => file.startsWith('tools/branding/')
		|| file === '.github/workflows/epilib-upstream.yml'
		|| file === '.github/workflows/epilib-branding.yml'), 'Upstream modified integration policy; manual review required');
	const merged = spawnSync('git', ['merge', '--no-ff', '--no-commit', upstream], { cwd: directory, encoding: 'utf8' });
	if (merged.status !== 0) {
		const conflicts = git(directory, 'diff', '--name-only', '--diff-filter=U');
		git(directory, 'merge', '--abort');
		throw new Error(`Upstream merge failed; target unchanged. Resolve manually:\n${conflicts}\n${merged.stderr}`);
	}
	return { base, upstream, changed: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	const result = prepare(root, `refs/remotes/origin/${config.targetBranch}`, 'refs/remotes/epilib-upstream/main');
	console.log(JSON.stringify(result));
	if (process.env.GITHUB_OUTPUT) {
		fs.appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(result).map(([k, v]) => `${k}=${v}\n`).join(''));
	}
}
