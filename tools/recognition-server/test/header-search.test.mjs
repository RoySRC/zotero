import assert from 'node:assert/strict';
import test from 'node:test';
import { getHints, recognizeExtraction } from '../src/extraction.mjs';
import { createProviders } from '../src/providers.mjs';
import { createEngine } from '../src/engine.mjs';
import { createStore } from '../src/store.mjs';
import { fromArxiv, rankCandidates } from '../src/metadata.mjs';

/**
 * Model the desktop worker's positional word arrays without storing a user's PDF.
 * Each fixture line controls its font/bold state; vertical positions are regular
 * so wrapped-title tests can distinguish a byline by typography, not test magic.
 */
function extraction(lines, metadata = {}) {
	return { metadata, totalPages: 1, pages: [[612, 792, lines.map(([text, size = 11, bold = 0], index) =>
		[text.split(' ').map(word => [50, 40 + index * 18, 100, 52 + index * 18,
			size, 1, 0, 0, 0, bold, 0, 0, 0, word])])]] };
}

// Only the public title/byline are used. Affiliation/email/body lines are synthetic
// and deliberately must not appear in outbound provider requests.
const title = 'Label-Free Concept Bottleneck Models';
const authors = ['Tuomas Oikarinen', 'Subhro Das', 'Lam M. Nguyen', 'Tsui-Wei Weng'];
const header = [
	['Published as a conference paper at ICLR 2023'],
	[title.toUpperCase(), 14, 1],
	[authors[0]], ['Example University'], ['private@example.test'],
	[authors[1]], ['Example Research Lab'],
	[authors[2]], [authors[3]], ['ABSTRACT'], ['Private body prose must never leave the worker.']
];
const entry = { id: 'http://arxiv.org/abs/2304.06129v3', title,
	author: authors.map(name => ({ name })), published: '2023-04-12T00:00:00Z', summary: 'Public provider abstract.' };
const item = fromArxiv(entry);

/** Minimal valid Atom response; tests never depend on a live public API. */
function atom(record = entry) {
	return '<feed xmlns="http://www.w3.org/2005/Atom"><entry>'
		+ `<id>${record.id}</id><title>${record.title}</title><published>${record.published}</published>`
		+ record.author.map(author => `<author><name>${author.name}</name></author>`).join('')
		+ `<summary>${record.summary}</summary></entry></feed>`;
}

test('ICLR banner and empty PDF fields yield the actual title and all four author hints', () => {
	let data = extraction(header, { Title: '  ', Author: '' });
	assert.equal(recognizeExtraction(data), null);
	assert.deepEqual(getHints(data), { title: title.toUpperCase(), author: authors.join('; '),
		year: '2023', source: 'layout' });
});

test('wrapped mixed-case titles join without swallowing the byline or affiliations', () => {
	let hints = getHints(extraction([
		['Under review as a conference paper at ICLR 2025'],
		['Learning Reliable', 16, 1], ['Representations Without Labels', 16, 1],
		['Ada Example and Grace Hopper'], ['Example University'], ['Abstract'], ['Unrelated prose.']
	]));
	assert.equal(hints.title, 'Learning Reliable Representations Without Labels');
	assert.equal(hints.author, 'Ada Example; Grace Hopper');
	assert.equal(hints.year, '');
});

test('headers, body prose and reference titles alone do not become search hints', () => {
	for (let lines of [[], [['Published as a conference paper at ICLR 2023']],
		[['Abstract'], ['A convincing but unrelated long body sentence.']],
		[['References'], [title]]]) {
		assert.equal(getHints(extraction(lines)).title, '');
	}
});

test('explicit title and author fields keep precedence; inferred authors keep review required', () => {
	assert.deepEqual(getHints(extraction(header, { Title: title, Author: authors[0] })),
		{ title, author: authors[0], year: '', source: 'pdf-metadata' });
	assert.equal(getHints(extraction(header, { Title: title })).source, 'layout');
	let hints = { title, author: authors[0], year: '2023' };
	assert.deepEqual(getHints({ ...extraction(header), hints }), { ...hints, source: 'local-grobid' });
});

test('Crossref near-miss falls back to arXiv and requires review despite exact corroboration', async () => {
	let requests = [];
	let providers = createProviders({ interval: 0, fetchImpl: async (url, options) => {
		requests.push({ url: String(url), options });
		if (String(url).includes('openreview')) return Response.json({ notes: [] });
		return String(url).includes('crossref') ? Response.json({ message: { items: [{
			type: 'journal-article', DOI: '10.1234/unrelated', title: ['Unrelated article']
		}] } }) : new Response(atom());
	} });
	let recognize = createEngine({ store: await createStore(), providers });
	let result = await recognize(extraction(header));
	assert.equal(result.status, 'needs_review');
	assert.equal(result.candidates.length, 1);
	assert.deepEqual(result.candidates[0].item, item);
	assert.equal(result.candidates[0].evidence.authorMatch, true);
	assert.equal(result.candidates[0].evidence.yearMatch, true);
	assert.equal(requests.length, 5);
	let url = new URL(requests[1].url);
	assert.equal(url.searchParams.get('search_query'), 'ti:"label free concept bottleneck models"');
	assert.equal(url.searchParams.get('max_results'), '5');
	assert.ok(requests.every(request => !request.options.body && !request.options.headers.Authorization));
	assert.ok(!JSON.stringify(requests).includes('private'));
});

test('convincing Crossref results avoid unnecessary arXiv requests', async () => {
	let requests = [];
	let providers = createProviders({ interval: 0, fetchImpl: async url => {
		requests.push(String(url));
		return Response.json({ message: { items: [{ type: 'proceedings-article', DOI: '10.1234/test',
			title: [title], author: [{ given: 'Tuomas', family: 'Oikarinen' }], published: { 'date-parts': [[2023]] } }] } });
	} });
	let hints = { title, author: authors[0], year: '2023', source: 'layout' };
	let items = await providers.search(hints);
	assert.equal(requests.length, 1);
	assert.equal(rankCandidates(items, hints).status, 'needs_review');
});

test('arXiv query syntax from PDF text is removed and returned IDs are validated', async () => {
	let query;
	let providers = createProviders({ interval: 0, fetchImpl: async url => {
		if (String(url).includes('crossref')) return Response.json({ message: { items: [] } });
		query = new URL(url).searchParams.get('search_query');
		return new Response(atom({ ...entry, id: 'https://untrusted.example/abs/2304.06129' }));
	} });
	assert.deepEqual(await providers.search({ title: 'A title" OR all:* (author:Name)' }), []);
	assert.equal(query, 'ti:"a title or all author name"');
	for (let id of ['http://arxiv.org/api/errors#bad_query', 'http://arxiv.org/abs/not-an-id',
		'https://arxiv.org.evil.test/abs/2304.06129']) assert.equal(fromArxiv({ ...entry, id }), null);
});

test('provider outage can be recovered by a real candidate but cannot masquerade as no match', async () => {
	let hints = { title, author: authors[0], source: 'layout' };
	let providers = createProviders({ interval: 0, fetchImpl: async url => String(url).includes('crossref')
		? new Response('', { status: 503 }) : new Response(atom()) });
	assert.equal((await providers.search(hints))[0].archiveID, '2304.06129');
	for (let response of ['<feed/>', '<html>Not an Atom feed</html>',
		atom({ ...entry, id: 'http://arxiv.org/api/errors#bad_query' })]) {
		providers = createProviders({ interval: 0, fetchImpl: async url => String(url).includes('crossref')
			? new Response('', { status: 503 }) : new Response(response) });
		await assert.rejects(providers.search(hints));
	}
});

test('successful empty searches return no match and an arXiv failure is not hidden as a miss', async () => {
	for (let fail of [false, true]) {
		let providers = createProviders({ interval: 0, fetchImpl: async url => String(url).includes('crossref')
			? Response.json({ message: { items: [] } })
			: fail ? new Response('', { status: 503 })
				: new Response('<feed><title>arXiv Query</title><totalResults>0</totalResults></feed>') });
		let recognize = createEngine({ store: await createStore(), providers });
		if (fail) await assert.rejects(recognize(extraction(header)));
		else assert.equal((await recognize(extraction(header))).status, 'no_match');
	}
});

test('missing authors, conflicting years and competing titles never auto-match', () => {
	let hints = { title, author: authors[0], year: '2023', source: 'pdf-metadata' };
	for (let candidate of [{ ...item, creators: [] }, { ...item, date: '2024-01-01' }]) {
		assert.equal(rankCandidates([candidate], hints).status, 'needs_review');
	}
	assert.equal(rankCandidates([item, { ...item, archiveID: '2304.00001' }], hints).status, 'needs_review');
	assert.equal(rankCandidates([{ ...item, title: 'Completely unrelated article' }], hints).status, 'no_match');
});
