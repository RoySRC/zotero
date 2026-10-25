import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import express from 'express';
import { createRecognizerRouter } from '../src/recognizer-routes.mjs';

/** Mount the real gateway with a synthetic authenticated account, never live credentials. */
async function gateway(t, options) {
	let app = express();
	app.use((req, _res, next) => { if (req.get('Zotero-API-Key') == 'user-token') req.authUser = { id: 1 }; next(); });
	app.use('/recognizer', createRecognizerRouter(options));
	let server = app.listen(0, '127.0.0.1');
	await once(server, 'listening');
	t.after(() => new Promise(resolve => server.close(resolve)));
	return `http://127.0.0.1:${server.address().port}/recognizer/`;
}

test('gateway authenticates locally and substitutes a separate service credential', async t => {
	let calls = [];
	let key = 'test-worker-secret-not-real-00000';
	let base = await gateway(t, { url: 'http://worker:8080/', key, fetchImpl: async (url, options) => {
		calls.push({ url, options });
		return Response.json({ engine: 'epilib', version: 2, status: 'no_match' });
	} });
	assert.equal((await fetch(base + 'health')).status, 403);
	assert.equal(calls.length, 0);
	let response = await fetch(base + 'recognize', { method: 'POST', headers: {
		'Zotero-API-Key': 'user-token', 'Content-Type': 'application/json' }, body: '{"pages":[]}' });
	assert.equal(response.status, 200);
	assert.equal(calls[0].url.href, 'http://worker:8080/recognize');
	assert.equal(calls[0].options.headers.Authorization, `Bearer ${key}`);
	assert.equal(calls[0].options.redirect, 'error');
	assert.ok(!JSON.stringify(calls[0]).includes('user-token'));
	assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('unconfigured, failed, redirected and malformed workers never fall back to Zotero', async t => {
	let headers = { 'Zotero-API-Key': 'user-token' };
	let missing = await gateway(t, { url: '', key: '' });
	assert.equal((await fetch(missing + 'health', { headers })).status, 503);
	for (let response of [new Response('private response', { status: 302 }),
		new Response('private response'), new Response('x'.repeat(1024 * 1024 + 1))]) {
		let url = await gateway(t, { url: 'http://worker:8080/', key: '0'.repeat(32), fetchImpl: async () => response });
		let result = await fetch(url + 'health', { headers });
		assert.equal(result.status, 502);
		assert.ok(!(await result.text()).includes('private'));
	}
});

test('gateway forwards per-request provider keys only to its authenticated worker', async t => {
	const bodies = [];
	const base = await gateway(t, { url: 'http://worker:8080/', key: '0'.repeat(32),
		fetchImpl: async (_url, options) => {
			bodies.push(options.body && JSON.parse(options.body));
			return Response.json({ engine: 'epilib', version: 2, providerCredentials: 1 });
		} });
	const headers = { 'Zotero-API-Key': 'user-token', 'Content-Type': 'application/json' };
	assert.equal((await (await fetch(base + 'health', { headers })).json()).providerCredentials, 1);
	for (const providerKeys of [{ crossref: 'synthetic-personal-key' }, undefined]) {
		const payload = { pages: [], ...(providerKeys ? { providerKeys } : {}) };
		const response = await fetch(base + 'recognize', { method: 'POST', headers, body: JSON.stringify(payload) });
		assert.equal(response.status, 200);
		assert.deepEqual(bodies.at(-1), payload);
		assert.ok(!(await response.text()).includes('synthetic-personal-key'));
	}
	assert.equal(bodies.length, 3);
	assert.equal(bodies[0], undefined);
});
