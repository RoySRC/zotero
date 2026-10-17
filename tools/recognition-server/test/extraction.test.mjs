import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { recognizeExtraction } from '../src/extraction.mjs';
import { createApp } from '../src/app.mjs';

/** Build the actual positional PDF-worker format, including word spacing. */
function extraction(lines = [], metadata = {}) {
	let words = lines.map(line => [line.split(' ').map(text =>
		[0, 0, 10, 10, 12, true, 0, 0, false, false, false, 0, 0, text])]);
	return { metadata, totalPages: 1, pages: [[600, 800, [[[[0, 0, 0, 0, words]]]]]] };
}

test('explicit DOI metadata wins over a citation on the page', () => {
	assert.deepEqual(recognizeExtraction(extraction(['doi:10.1000/citation'], { 'prism:doi': '10.1234/PRIMARY' })),
		{ doi: '10.1234/primary' });
});

test('labelled DOI and DOI URL preserve balanced punctuation', () => {
	for (let label of ['DOI: ', 'https://doi.org/', 'http://dx.doi.org/']) {
		assert.deepEqual(recognizeExtraction(extraction([label + '10.1234/Example(test).'])),
			{ doi: '10.1234/example(test)' });
	}
	assert.deepEqual(recognizeExtraction(extraction(['(doi:10.1234/example).'])), { doi: '10.1234/example' });
});

test('arXiv labels support new/old identifiers and strip revision numbers', () => {
	for (let id of ['2401.12345', '0704.0001', 'hep-th/9901001', 'math.GT/0309136']) {
		assert.deepEqual(recognizeExtraction(extraction([`arXiv:${id}v2`])), { arxiv: id });
	}
});

test('ISBN checksums accept ISBN-10 and ISBN-13 and reject corrupt values', () => {
	for (let value of ['978-3-0346-0289-1', '0-8044-2957-X']) {
		assert.deepEqual(recognizeExtraction(extraction([`ISBN: ${value}`])), { isbn: value.replaceAll('-', '') });
	}
	assert.equal(recognizeExtraction(extraction(['ISBN: 9783034602892'])), null);
});

test('ISBN can be found on the copyright page', () => {
	let data = extraction(['A book title']);
	data.totalPages = 2;
	data.pages.push(extraction(['ISBN-13: 978-3-0346-0289-1']).pages[0]);
	assert.deepEqual(recognizeExtraction(data), { isbn: '9783034602891' });
});

test('ambiguous identifiers, bibliography entries, and unlabelled body text abstain', () => {
	for (let lines of [
		['doi:10.1234/one', 'doi:10.1234/two'],
		['doi:10.1234/one', 'arXiv:2401.12345'],
		['Abstract', 'doi:10.1234/citation'],
		['1. Introduction', 'doi:10.1234/citation'],
		['References', 'doi:10.1234/citation'],
		['Bibliography', 'ISBN: 9783034602891'],
		['See 10.1234/citation for details'],
		['A title without identifiers'], []
	]) assert.equal(recognizeExtraction(extraction(lines)), null);
	assert.equal(recognizeExtraction(extraction([], { DOI: '10.1234/a 10.1234/b' })), null);
});

test('malformed or excessively nested payloads are rejected without echoing contents', () => {
	for (let value of [null, [], {}, { pages: 'secret PDF text' }, { totalPages: 1, pages: [], metadata: [] }]) {
		assert.throws(() => recognizeExtraction(value), { status: 400, message: 'Invalid PDF extraction data' });
	}
	let data = extraction();
	let deep = [];
	for (let i = 0; i < 20; i++) deep = [deep];
	data.pages[0][2] = deep;
	assert.throws(() => recognizeExtraction(data), { status: 400 });
});

test('HTTP routes enforce auth, protocol and body limits without retaining documents', async (t) => {
	let key = 'test-service-key-not-a-real-secret';
	let app = createApp({ key, recognize: recognizeExtraction });
	let server = app.listen(0, '127.0.0.1');
	await once(server, 'listening');
	t.after(() => new Promise(resolve => server.close(resolve)));
	let baseURL = `http://127.0.0.1:${server.address().port}/`;
	let headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
	for (let route of ['health', 'recognize', 'report']) {
		let denied = await fetch(baseURL + route, { method: route == 'health' ? 'GET' : 'POST' });
		assert.equal(denied.status, 403);
	}
	let health = await fetch(baseURL + 'health', { headers });
	assert.equal(health.headers.get('cache-control'), 'no-store');
	assert.deepEqual(await health.json(), {
		engine: 'epilib', version: 2, protocol: 'epilib-recognition-v2', reports: false
	});
	let result = await fetch(baseURL + 'recognize', {
		method: 'POST', headers, body: JSON.stringify(extraction(['doi:10.1234/test']))
	});
	assert.deepEqual(await result.json(), { doi: '10.1234/test' });
	let noMatch = await fetch(baseURL + 'recognize', {
		method: 'POST', headers, body: JSON.stringify(extraction())
	});
	assert.equal(noMatch.status, 200);
	assert.equal(await noMatch.json(), null);
	for (let body of ['{"secret PDF text":', JSON.stringify({ pages: 'secret PDF text' })]) {
		let bad = await fetch(baseURL + 'recognize', { method: 'POST', headers, body });
		assert.equal(bad.status, 400);
		assert.deepEqual(await bad.json(), { error: 'invalid_extraction' });
	}
	let large = await fetch(baseURL + 'recognize', {
		method: 'POST', headers, body: JSON.stringify({ text: 'x'.repeat(5 * 1024 * 1024) })
	});
	assert.equal(large.status, 413);
	assert.deepEqual(await large.json(), { error: 'extraction_too_large' });
	let report = await fetch(baseURL + 'report', { method: 'POST', headers, body: '{}' });
	assert.equal(report.status, 404);
});
