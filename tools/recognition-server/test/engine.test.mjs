import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import test from 'node:test';
import { fromCrossref, rankCandidates } from '../src/metadata.mjs';
import { createProviders } from '../src/providers.mjs';
import { createEngine } from '../src/engine.mjs';
import { createStore } from '../src/store.mjs';
import { createApp } from '../src/app.mjs';
import { evaluate } from '../src/evaluate-crossref.mjs';

const work = { type: 'journal-article', DOI: '10.1234/test', title: ['A study of reliable metadata matching'],
	author: [{ given: 'Ada', family: 'Example' }], published: { 'date-parts': [[2025]] } };
const item = fromCrossref(work);
const extraction = { metadata: { DOI: work.DOI }, totalPages: 0, pages: [] };

test('exact lookup returns a full item and caches only the public record', async () => {
	let calls = 0;
	let store = await createStore();
	let recognize = createEngine({ store, providers: { resolve: async () => { calls++; return item; } } });
	for (let i = 0; i < 2; i++) {
		let result = await recognize({ ...extraction, fileName: 'private.pdf' });
		assert.equal(result.status, 'matched');
		assert.deepEqual(result.item, item);
		assert.equal(result.evidence.method, 'identifier');
	}
	assert.equal(calls, 1);
	let cached = await store.get('bibliography-v3:doi:' + work.DOI);
	assert.deepEqual(cached, item);
	assert.ok(!JSON.stringify(cached).includes('private'));
});

test('older incomplete cache entries do not mask newly available bibliographic fields', async () => {
	let store = await createStore();
	await store.put('doi:' + work.DOI, item);
	let complete = { ...item, abstractNote: 'Provider abstract.', language: 'en' };
	let calls = 0;
	let recognize = createEngine({ store, providers: { resolve: async () => { calls++; return complete; } } });
	assert.deepEqual((await recognize(extraction)).item, complete);
	assert.deepEqual((await recognize(extraction)).item, complete);
	assert.equal(calls, 1);
});

test('local mode never calls remote providers; hybrid uses imported DOI first', async () => {
	for (let mode of ['local', 'hybrid']) {
		let store = { localDOI: async () => item, get: async () => null, search: async () => [item] };
		let providers = { resolve: () => { throw new Error('Network must not be used'); }, search: () => { throw new Error('Network must not be used'); } };
		assert.equal((await createEngine({ store, providers, mode })(extraction)).status, 'matched');
	}
});

test('title matches require corroboration; close matches and explicit conflicts require review', async () => {
	let hints = { title: item.title, author: 'Ada Example', year: '2025', source: 'pdf-metadata' };
	assert.equal(rankCandidates([item], hints).status, 'matched');
	for (let extra of [{ author: '' }, { year: '2020' }, { source: 'layout' }]) {
		assert.equal(rankCandidates([item], { ...hints, ...extra }).status, 'needs_review');
	}
	assert.equal(rankCandidates([item, { ...item, DOI: '10.1234/another' }], hints).status, 'needs_review');
	let recognize = createEngine({ store: await createStore(), providers: { resolve: async () => item } });
	assert.equal((await recognize({ ...extraction, metadata: { DOI: work.DOI, Title: 'Completely different unrelated research' } })).status, 'needs_review');
});

test('provider requests contain identifiers or bounded hints, never PDF text or user tokens', async () => {
	let requests = [];
	let providers = createProviders({ interval: 0, fetchImpl: async (url, options) => {
		requests.push({ url: String(url), options });
		return Response.json({ message: String(url).includes('?') ? { items: [work] } : work });
	} });
	assert.deepEqual(await providers.resolve('doi', work.DOI), item);
	assert.deepEqual(await providers.search({ title: item.title, author: 'Example', year: '2025' }), [item]);
	assert.ok(requests.every(req => req.options.redirect == 'error' && !req.options.body && !req.options.headers.Authorization));
});

test('conflicting identifiers cannot be promoted to an automatic title match', async () => {
	let recognize = createEngine({ store: await createStore(), providers: { search: async () => [item] } });
	let result = await recognize({ pages: [], totalPages: 0,
		metadata: { DOI: '10.1234/one 10.1234/two', Title: item.title, Author: 'Ada Example' } });
	assert.equal(result.status, 'needs_review');
});

test('provider errors, rate limits, unexpected identifiers and large bodies fail safely', async () => {
	let providers = createProviders({ interval: 0, fetchImpl: async () => Response.json({ message: { ...work, DOI: '10.9999/wrong' } }) });
	assert.equal(await providers.resolve('doi', work.DOI), null);
	let calls = 0;
	providers = createProviders({ interval: 0, fetchImpl: async () => { calls++; return new Response('', { status: 429, headers: { 'Retry-After': '60' } }); } });
	await assert.rejects(providers.resolve('doi', work.DOI));
	await assert.rejects(providers.resolve('doi', work.DOI));
	assert.equal(calls, 1);
	providers = createProviders({ interval: 0, fetchImpl: async () => new Response('x'.repeat(2 * 1024 * 1024 + 1)) });
	await assert.rejects(providers.resolve('doi', work.DOI));
});

test('DataCite, arXiv and ISBN adapters return supported complete records', async () => {
	let providers = createProviders({ interval: 0, fetchImpl: async url => {
		if (String(url).includes('crossref')) return new Response('', { status: 404 });
		return Response.json({ data: { attributes: { doi: work.DOI, titles: [{ title: item.title }],
			types: { resourceTypeGeneral: 'JournalArticle' }, creators: [{ name: 'Ada Example' }], publicationYear: 2025 } } });
	} });
	assert.equal((await providers.resolve('doi', work.DOI)).libraryCatalog, 'DataCite');
	providers = createProviders({ interval: 0, fetchImpl: async () => new Response(
		'<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>http://arxiv.org/abs/2401.12345v2</id><title>Test paper</title><summary>Full abstract.</summary><author><name>Ada Example</name></author><published>2024-01-01</published></entry></feed>') });
	let preprint = await providers.resolve('arxiv', '2401.12345');
	assert.equal(preprint.itemType, 'preprint');
	assert.equal(preprint.abstractNote, 'Full abstract.');
	providers = createProviders({ interval: 0, fetchImpl: async () => Response.json({ 'ISBN:9783034602891': { title: 'Book', authors: [{ name: 'Ada Example' }] } }) });
	assert.equal((await providers.resolve('isbn', '9783034602891')).itemType, 'book');
});

test('worker saturation is bounded and an active slot is released after completion', async t => {
	let finish;
	let app = createApp({ key: '0'.repeat(32), concurrency: 1, recognize: () => new Promise(resolve => { finish = resolve; }) });
	let server = app.listen(0, '127.0.0.1');
	await once(server, 'listening');
	t.after(() => new Promise(resolve => server.close(resolve)));
	let url = `http://127.0.0.1:${server.address().port}/recognize`;
	let options = { method: 'POST', headers: { Authorization: 'Bearer ' + '0'.repeat(32), 'Content-Type': 'application/json' }, body: '{}' };
	let first = fetch(url, options);
	while (!finish) await new Promise(resolve => setTimeout(resolve, 1));
	assert.equal((await fetch(url, options)).status, 503);
	finish({ status: 'no_match' });
	assert.equal((await first).status, 200);
});

test('Crossref evaluation streams a bounded gzipped sample and rejects bad configuration', async t => {
	let dir = await mkdtemp(join(tmpdir(), 'epilib-crossref-test-'));
	t.after(() => rm(dir, { recursive: true, force: true }));
	let file = join(dir, 'sample.json.gz');
	await writeFile(file, gzipSync(JSON.stringify({ items: [work, work, work] })));
	let result = await evaluate({ file, limit: 2 });
	assert.equal(result.seen, 2);
	assert.equal(result.supported, 2);
	assert.ok(result.peakRSSKiB > 0);
	assert.equal(result.index, null);
	await assert.rejects(evaluate({ file, limit: 100001 }));
	await writeFile(file, gzipSync('invalid JSON'));
	await assert.rejects(evaluate({ file }));
});
