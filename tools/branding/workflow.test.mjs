import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { transform, config } from './apply.mjs';
import { references } from './check-upstream.mjs';
import { prepare } from './merge-upstream.mjs';

test('publication is isolated, pinned, non-forcing and limited to rebranding', () => {
	const workflow = fs.readFileSync(new URL('../../.github/workflows/epilib-upstream.yml', import.meta.url), 'utf8');
	assert.ok(workflow.includes(`ref: ${config.targetBranch}`));
	assert.ok(workflow.includes(`git fetch --no-tags ${config.upstream.repository} ${config.upstream.branch}:`));
	const publish = workflow.slice(workflow.indexOf('\n  publish:'));
	assert.match(publish, /needs: integrate/);
	assert.match(publish, /git merge-base --is-ancestor "\$BASE" "\$CANDIDATE"/);
	assert.match(publish, /test "\$\(git rev-parse FETCH_HEAD\)" = "\$BASE"/);
	assert.match(publish, /git push origin "\$CANDIDATE:refs\/heads\/rebranding"/);
	assert.doesNotMatch(publish, /git push .*--force|npm |node |bash tools\//);
	for (const file of ['epilib-upstream.yml', 'epilib-branding.yml']) {
		const text = fs.readFileSync(new URL(`../../.github/workflows/${file}`, import.meta.url), 'utf8');
		for (const action of text.matchAll(/uses: ([^\s]+)/g)) {
			assert.match(action[1], /@[a-f0-9]{40}$/, 'Pin Actions to reviewed commits');
		}
		assert.ok(text.includes('test/runtests.sh -f -b epilibBranding epilibSyncIsolation recognitionEngine preferences_account storageLocal webdav syncLocal syncEngine syncRunner'));
		assert.ok(text.includes("-g 'standalone PDF by ISBN' recognizeDocument"));
		assert.ok(text.includes('TEST_DATABASE_URL:'));
	}
});

test('resource overlay preserves keys, endpoints, namespaces, external services and credits', () => {
	const fixtures = {
		'chrome/locale/en-US/zotero/test.ftl': '# Copyright Zotero Contributors\nwelcome = Welcome to Zotero\nlink = https://www.zotero.org/\nstorage = Zotero Storage\n',
		'chrome/locale/en-US/zotero/test.properties': 'app.title=Zotero\nabout.createdBy=Zotero was created by Contributors\nurl=https://www.zotero.org/\n',
		'chrome/locale/en-US/zotero/test.dtd': '<!ENTITY zotero.title "Zotero Library">\n',
		'resource/config.mjs': "const ZOTERO_CONFIG = { CLIENT_NAME: 'Zotero', ID: 'zotero', API_URL: 'https://api.zotero.org/' };",
		'app/assets/branding/locale/brand.ftl': '-brand-full-name = Zotero\n-subscription-name = Zotero Storage\ntrademarkInfo = Zotero is a trademark.\n'
	};
	for (const [file, source] of Object.entries(fixtures)) {
		const result = transform(file, source);
		assert.notEqual(result, source);
		assert.equal(transform(file, result), result, `${file}: not idempotent`);
		assert.equal(result.match(/https:\/\/[^\s'\"]+/)?.[0], source.match(/https:\/\/[^\s'\"]+/)?.[0]);
		if (source.includes('Zotero Storage')) assert.ok(result.includes('Zotero Storage'));
		if (source.includes('trademarkInfo')) assert.ok(result.includes('trademarkInfo = Zotero is a trademark.'));
	}
	assert.equal(transform('chrome/content/example.js', 'Zotero.API.call();'), 'Zotero.API.call();');
	assert.equal(config.targetBranch, 'rebranding');
	// The external recognition provider is not the application's display brand.
	const provider = 'preferences-recognition-zotero =\n    .label = Zotero\n';
	assert.equal(transform('chrome/locale/en-US/zotero/preferences.ftl', provider), provider);
});

test('new string scanner distinguishes display names from code, URLs and actual services', () => {
	assert.deepEqual([...references('test.js', `// Zotero namespace\nZotero.run(); const url = 'https://zotero.org/'; const service = 'Zotero Storage';`)], []);
	assert.deepEqual([...references('test.js', `const heading = 'Welcome to Zotero';`)], ['Welcome to Zotero']);
	assert.deepEqual([...references('test.js', 'const heading = `Zotero ${version}`;')], ['Zotero ']);
});

function fixture(t) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'epilib-merge-test-'));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
	git('init', '-b', 'rebranding');
	git('config', 'user.name', 'EpiLib Test');
	git('config', 'user.email', 'test@example.invalid');
	fs.writeFileSync(path.join(dir, 'file'), 'initial\n');
	git('add', '.');
	git('commit', '-m', 'initial');
	const initial = git('rev-parse', 'HEAD');
	function commit(file, value, message) {
		fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
		fs.writeFileSync(path.join(dir, file), value);
		git('add', '.');
		git('commit', '-m', message);
		return git('rev-parse', 'HEAD');
	}
	return { dir, git, commit, initial };
}

test('merge prepares a detached candidate without moving the target branch', t => {
	const { dir, git, commit, initial } = fixture(t);
	git('checkout', '--detach');
	const upstream = commit('upstream', 'new feature', 'upstream');
	git('checkout', 'rebranding');
	const base = commit('branding', 'EpiLib', 'branding');
	git('checkout', '--detach');
	assert.deepEqual(prepare(dir, base, upstream), { base, upstream, changed: true });
	assert.equal(git('rev-parse', 'refs/heads/rebranding'), base);
	assert.equal(git('rev-parse', 'MERGE_HEAD'), upstream);
	git('merge', '--abort');
	assert.deepEqual(prepare(dir, base, initial), { base, upstream: initial, changed: false });
});

test('conflicts abort, preserve both branches and do not choose ours/theirs', t => {
	const { dir, git, commit } = fixture(t);
	git('checkout', '--detach');
	const upstream = commit('file', 'Zotero\n', 'upstream');
	git('checkout', 'rebranding');
	const base = commit('file', 'EpiLib\n', 'brand');
	git('checkout', '--detach');
	assert.throws(() => prepare(dir, base, upstream), /merge failed/);
	assert.equal(git('status', '--porcelain'), '');
	assert.equal(git('rev-parse', 'rebranding'), base);
	assert.equal(fs.readFileSync(path.join(dir, 'file'), 'utf8'), 'EpiLib\n');
});

test('dirty, attached and policy-modifying merges are refused', t => {
	const { dir, git, commit, initial } = fixture(t);
	assert.throws(() => prepare(dir, initial, initial), /detached/);
	git('checkout', '--detach');
	const upstream = commit('tools/branding/config.json', '{}', 'alter policy');
	git('checkout', '--detach', initial);
	assert.throws(() => prepare(dir, initial, upstream), /manual review/);
	fs.writeFileSync(path.join(dir, 'untracked'), 'private data');
	assert.throws(() => prepare(dir, initial, initial), /clean/);
});
