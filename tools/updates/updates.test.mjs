import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import * as contract from '../../resource/epilibUpdates.mjs';
import { manifest, verify, preflight } from './release.mjs';

/** Synthetic archives exercise the real hashing/manifest code without building five runtimes. */
async function artifacts(t, version = '1.10.0') {
	let directory = await fs.mkdtemp(path.join(os.tmpdir(), 'epilib-release-test-'));
	t.after(() => fs.rm(directory, { recursive: true, force: true }));
	for (let platform of Object.keys(contract.PLATFORMS)) {
		await fs.writeFile(path.join(directory, contract.assetName(version, platform)), `fixture ${platform}`);
	}
	let feed = await manifest(directory, version, 'a'.repeat(40));
	return { directory, feed };
}

/** Execute the actual desktop module against narrow service doubles, not a rewritten checker. */
async function client(t, { version = '1.9.0', channel = 'stable' } = {}) {
	let { feed } = await artifacts(t);
	let calls = [], notifications = [], opened = [], prefs = new Map([
		['epilib.updates.enabled', true], ['epilib.updates.lastAttempt', '0']
	]);
	let Zotero = {
		File: { getResourceAsync: async () => JSON.stringify({ version, channel }) },
		HTTP: { request: async (...args) => { calls.push(args); return { responseText: JSON.stringify(feed) }; } },
		Prefs: { get: key => prefs.get(key), set: (key, value) => prefs.set(key, value) },
		getMainWindow: () => ({}), openCheckForUpdatesWindow: data => notifications.push(data),
		launchURL: url => opened.push(url), debug() {}, logError() {}
	};
	vm.runInNewContext(await fs.readFile(new URL('../../chrome/content/zotero/xpcom/epilibUpdates.js', import.meta.url), 'utf8'),
		{ Zotero, ChromeUtils: { importESModule: () => contract }, setTimeout, clearTimeout });
	return { api: Zotero.EpiLibUpdates, Zotero, feed, calls, prefs, notifications, opened };
}

test('numeric versions reject development tags, prereleases, leading zeros and unsafe values', () => {
	assert.equal(contract.compareVersions('1.10.0', '1.9.0'), 1);
	assert.equal(contract.compareVersions('1.0.0', '1.0.0'), 0);
	assert.equal(contract.compareVersions('1.0.0', '2.0.0'), -1);
	for (let version of ['01.0.0', '1.0', '1.0.0-beta', '11.0.SOURCE.abc', '../v1', '1.0.0\n', '99999999999999999999.0.0']) {
		assert.throws(() => contract.parseVersion(version));
	}
});

test('manifest requires all platforms and verifies the actual archive bytes', async t => {
	let { directory, feed } = await artifacts(t);
	await verify(directory, feed);
	let file = path.join(directory, feed.assets[0].name);
	await fs.appendFile(file, 'corruption');
	await assert.rejects(verify(directory, feed), /changed/);
	await fs.rm(file);
	await assert.rejects(manifest(directory, '1.10.0', 'a'.repeat(40)), /ENOENT/);
});

test('rejects upstream repositories, prerelease channels, incomplete feeds and traversal filenames', async t => {
	let { feed } = await artifacts(t);
	for (let mutate of [
		f => { f.repository = 'zotero/zotero'; },
		f => { f.channel = 'beta'; },
		f => { f.tag = 'v1.10.0'; },
		f => { f.commit = 'HEAD'; },
		f => { f.assets.pop(); },
		f => { f.assets[0] = f.assets[1]; },
		f => { f.assets[0].name = '../Zotero.zip'; },
		f => { f.assets[0].sha256 = 'bad'; },
		f => { f.assets[0].size = 0; }
	]) {
		let invalid = structuredClone(feed);
		mutate(invalid);
		assert.throws(() => contract.validateFeed(invalid));
	}
});

test('desktop requests the EpiLib feed anonymously, coalesces checks and opens only our release page', async t => {
	let { api, calls, opened } = await client(t);
	let first = api.check();
	assert.equal(api.check(), first);
	assert.equal((await first).available, true);
	assert.equal(calls.length, 1);
	let [method, url, options] = calls[0];
	assert.equal(method, 'GET');
	assert.equal(url, contract.FEED_URL);
	assert.equal(options.anon, true);
	assert.equal(options.timeout, 20000);
	assert.deepEqual(Object.keys(options.headers), ['Accept']);
	api.openReleasePage('1.10.0');
	assert.deepEqual(opened, [contract.releaseURL('1.10.0')]);
	assert.throws(() => api.openReleasePage('https://www.zotero.org/download'));
});

test('equal and older releases never become upgrade offers', async t => {
	for (let version of ['1.10.0', '2.0.0']) {
		let { api } = await client(t, { version });
		assert.equal((await api.check()).available, false);
	}
});

test('source builds and opt-outs never check automatically; manual checks still work', async t => {
	let source = await client(t, { version: null, channel: 'development' });
	await source.api.checkInBackground();
	assert.equal(source.calls.length, 0);
	assert.equal((await source.api.check()).development, true);
	let disabled = await client(t);
	disabled.prefs.set('epilib.updates.enabled', false);
	await disabled.api.checkInBackground();
	assert.equal(disabled.calls.length, 0);
	await disabled.api.check();
	assert.equal(disabled.calls.length, 1);
});

test('background checks throttle across restarts and notify once per version', async t => {
	let { api, prefs, calls, notifications } = await client(t);
	await api.checkInBackground();
	await api.checkInBackground();
	assert.equal(calls.length, 1);
	assert.equal(notifications.length, 1);
	prefs.set('epilib.updates.lastAttempt', '0');
	await api.checkInBackground();
	assert.equal(calls.length, 2);
	assert.equal(notifications.length, 1);
	// A backwards clock adjustment must not disable checks indefinitely.
	prefs.set('epilib.updates.lastAttempt', String(Date.now() + 100000));
	await api.checkInBackground();
	assert.equal(calls.length, 3);
});

test('network and malformed-feed failures are not reported as up-to-date and can be retried', async t => {
	let { api, Zotero, notifications, prefs } = await client(t);
	for (let response of ['not JSON', '{}', 'x'.repeat(65537)]) {
		Zotero.HTTP.request = async () => ({ responseText: response });
		await assert.rejects(api.check());
	}
	Zotero.HTTP.request = async () => { throw new Error('404/offline'); };
	await api.checkInBackground();
	assert.equal(notifications.length, 0);
	assert.ok(Number(prefs.get('epilib.updates.lastAttempt')) > 0);
	await assert.rejects(api.check(), /404/);
});

test('publication preflight distinguishes no releases from auth/outage and rejects rollbacks', async () => {
	await preflight('1.0.0', null, async () => ({ status: 404 }));
	await preflight('1.10.0', null, async () => ({ ok: true, json: async () => ({ tag_name: 'epilib-v1.9.0' }) }));
	for (let status of [401, 403, 500]) {
		await assert.rejects(preflight('1.0.0', null, async () => ({ status })), /failed/);
	}
	for (let tag_name of ['epilib-v1.10.0', 'epilib-v2.0.0', '11.0']) {
		await assert.rejects(preflight('1.10.0', null, async () => ({ ok: true, json: async () => ({ tag_name }) })), /newer/);
	}
});

test('release workflow gates every build/publication and never uses Zotero deployment', async () => {
	let text = await fs.readFile(new URL('../../.github/workflows/epilib-release.yml', import.meta.url), 'utf8');
	assert.match(text, /github.repository == 'epilib-org\/epilib-desktop'/);
	assert.match(text, /needs: \[identity, validate\]/);
	assert.match(text, /needs: \[identity, validate, build\]/);
	assert.match(text, /environment: epilib-release/);
	assert.match(text, /group: epilib-release-publication/);
	assert.match(text, /'--is-ancestor', commit, 'origin\/main'/);
	assert.match(text, /--jq .visibility/);
	assert.match(text, /--verify-tag --draft/);
	assert.match(text, /if \[\[ "\$PUBLISH" == true \]\]/);
	assert.match(text, /release.mjs verify release-artifacts/);
	assert.doesNotMatch(text, /--clobber|deploy\.zotero|S3_|secrets\./);
	assert.equal((text.match(/contents: write/g) || []).length, 1);
	for (let action of text.matchAll(/uses: ([^\s]+)/g)) {
		if (!action[1].startsWith('./')) assert.match(action[1], /@[a-f0-9]{40}$/);
	}
});
