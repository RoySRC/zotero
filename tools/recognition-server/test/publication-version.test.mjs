import assert from 'node:assert/strict';
import test from 'node:test';
import { createEngine } from '../src/engine.mjs';
import { createStore } from '../src/store.mjs';
import { fromArxiv, fromOpenReview, rankCandidates, sameWork, publicationConflict } from '../src/metadata.mjs';
import { createProviders } from '../src/providers.mjs';

// Public bibliographic facts only; no user library, PDF, credentials, or network.
// The repository record and accepted conference record describe the same work.
// Sources: https://arxiv.org/abs/2304.06129 and
// https://research.ibm.com/publications/label-free-concept-bottleneck-models
const title = 'Label-Free Concept Bottleneck Models';
const authors = ['Tuomas Oikarinen', 'Subhro Das', 'Lam M. Nguyen', 'Tsui-Wei Weng'];
const preprint = fromArxiv({
	id: 'https://arxiv.org/abs/2304.06129v2', title,
	author: authors.map(name => ({ name })), published: '2023-04-12T00:00:00Z'
});
const published = {
	itemType: 'conferencePaper', title, creators: preprint.creators,
	date: '2023-05-01', proceedingsTitle: 'International Conference on Learning Representations',
	libraryCatalog: 'OpenReview', url: 'https://openreview.net/forum?id=FlCg47MNvBA'
};
const hints = { title, author: authors.join('; '), year: '2023', source: 'pdf-metadata' };
const extraction = {
	metadata: { arxiv: '2304.06129', Title: title, Author: authors.join('; ') },
	totalPages: 0, pages: []
};

/**
 * Supply deterministic, already-validated provider records to isolate the
 * engine's version-selection policy from provider availability and parsing.
 * A warm cache models repeated recognition of a previously identified preprint.
 */
async function recognizeWithPublication(warmCache) {
	let store = await createStore();
	if (warmCache) await store.put('bibliography-v2:arxiv:2304.06129', preprint);
	let recognize = createEngine({ store, providers: {
		resolve: async () => preprint,
		publishedVersions: async () => ({ items: [published] })
	} });
	return recognize(extraction);
}

test('an arXiv identifier must not suppress a verified published-version lookup', async () => {
	let result = await recognizeWithPublication(false);
	assert.equal(result.item?.itemType, 'conferencePaper');
	assert.equal(result.item.proceedingsTitle, published.proceedingsTitle);
	assert.equal(result.item.alternateIdentifiers.arxiv, '2304.06129');
	assert.equal(result.item.date, '2023-05-01');
	assert.equal(result.evidence.provider, 'OpenReview');
});

test('a cached preprint must not suppress a verified published version', async () => {
	let result = await recognizeWithPublication(true);
	assert.equal(result.item?.itemType, 'conferencePaper');
	assert.equal(result.item.proceedingsTitle, published.proceedingsTitle);
});

test('corroborated published and repository versions should prefer the published record', () => {
	let result = rankCandidates([preprint, published], hints);
	assert.equal(result.status, 'matched');
	assert.equal(result.item.itemType, 'conferencePaper');
	assert.equal(result.item.alternateIdentifiers.arxiv, '2304.06129');
});

test('a repository record alone must not be relabeled as a published conference paper', async () => {
	let recognize = createEngine({ store: await createStore(), providers: {
		resolve: async () => preprint, publishedVersions: async () => ({ items: [] })
	} });
	assert.equal((await recognize(extraction)).item.itemType, 'preprint');
});

/** Public OpenReview v1/v2 fixtures model acceptance separately from BibTeX type. */
function note({ wrapped = false, venue = 'ICLR 2023 poster', venueid = 'ICLR.cc/2023/Conference' } = {}) {
	let content = { title, authors, venue, venueid, abstract: 'Conference abstract.' };
	return { id: 'FlCg47MNvBA', forum: 'FlCg47MNvBA', cdate: 1663850227248,
		invitation: 'ICLR.cc/2023/Conference/-/Blind_Submission',
		content: wrapped ? Object.fromEntries(Object.entries(content).map(([k, v]) => [k, { value: v }])) : content };
}

test('both OpenReview APIs yield accepted conference metadata, never submission dates', () => {
	for (let wrapped of [false, true]) {
		let record = fromOpenReview(note({ wrapped }));
		assert.equal(record.itemType, 'conferencePaper');
		assert.equal(record.date, '2023');
		assert.equal(record.proceedingsTitle, 'ICLR 2023');
		assert.equal(record.url, published.url);
		assert.equal(record.creators.length, 4);
	}
});

test('rejected, withdrawn, submitted and mirror records cannot prove publication', () => {
	for (let venue of ['Submitted to ICLR 2023', 'ICLR 2023 Withdrawn Submission', 'ICLR 2023 Rejected']) {
		assert.equal(fromOpenReview(note({ venue })), null);
	}
	for (let venueid of ['ICLR.cc/2023/Conference/Submission', 'ICLR.cc/2023/Conference/Rejected_Submission',
		'dblp.org/conf/ICLR/2023', 'dblp.org/journals/CORR/2023']) {
		assert.equal(fromOpenReview(note({ venueid })), null);
	}
});

test('same-work matching requires all authors and does not confuse two full given names', () => {
	assert.ok(sameWork(preprint, published));
	assert.ok(sameWork(preprint, { ...published, creators: published.creators.map(c =>
		({ ...c, name: c.name.replace('Tuomas ', 'Tuomas P. ') })) }));
	assert.ok(!sameWork(preprint, { ...published, creators: published.creators.slice(0, 3) }));
	assert.ok(!sameWork(preprint, { ...published, creators: published.creators.map(c =>
		({ ...c, name: c.name.replace('Tuomas', 'Thomas') })) }));
});

test('publication DOI and venue hints survive arXiv projection without changing type', () => {
	let record = fromArxiv({ id: preprint.url, title, doi: '10.1234/Paper',
		journal_ref: 'ICLR 2023', comment: 'Published as a conference paper at ICLR 2023' });
	assert.deepEqual(record.publicationHints, { doi: '10.1234/paper', journalReference: 'ICLR 2023',
		comment: 'Published as a conference paper at ICLR 2023' });
	assert.equal(record.itemType, 'preprint');
});

test('title-only recognition enriches preprints but layout guesses still require review', async () => {
	let providers = { search: async () => [preprint], publishedVersions: async () => ({ items: [published] }) };
	let recognize = createEngine({ store: await createStore(), providers });
	let result = await recognize({ ...extraction, metadata: { Title: title, Author: authors.join('; ') } });
	assert.equal(result.item.itemType, 'conferencePaper');
	assert.equal(rankCandidates([preprint, published], { ...hints, source: 'layout' }).status, 'needs_review');
});

test('ambiguous publications require review and unrelated candidates cannot upgrade a preprint', async () => {
	let providers = { resolve: async () => preprint, publishedVersions: async () => ({ items: [published,
		{ ...published, url: 'https://example.org/another-version', date: '2024' }] }) };
	let recognize = createEngine({ store: await createStore(), providers });
	assert.equal((await recognize(extraction)).status, 'needs_review');
	providers.publishedVersions = async () => ({ items: [{ ...published, title: 'Unrelated study' }] });
	assert.equal((await createEngine({ store: await createStore(), providers })(extraction)).item.itemType, 'preprint');
});

test('outages and misses do not poison publication caching; a successful warm lookup does not refetch', async () => {
	let store = await createStore(), calls = 0;
	await store.put('bibliography-v3:arxiv:2304.06129', preprint);
	let recognize = createEngine({ store, providers: {
		resolve: async () => { throw new Error('Warm source cache must be used'); },
		publishedVersions: async () => {
			calls++;
			if (calls == 1) throw new Error('Timeout');
			return { items: calls == 2 ? [] : [published] };
		}
	} });
	assert.equal((await recognize(extraction)).evidence.publicationLookup, 'incomplete');
	assert.equal((await recognize(extraction)).item.itemType, 'preprint');
	assert.equal((await recognize(extraction)).item.itemType, 'conferencePaper');
	assert.equal((await recognize(extraction)).item.itemType, 'conferencePaper');
	assert.equal(calls, 3);
});

test('offline mode never performs publication lookups', async () => {
	let recognize = createEngine({ mode: 'local', store: { search: async () => [preprint] },
		providers: { publishedVersions: () => { throw new Error('Must not contact provider'); } } });
	let result = await recognize({ ...extraction, metadata: { Title: title, Author: authors.join('; ') } });
	assert.equal(result.item.itemType, 'preprint');
});

test('public lookup checks Crossref then accepted OpenReview with bounded, credential-free requests', async () => {
	let requests = [];
	let providers = createProviders({ interval: 0, fetchImpl: async (url, options) => {
		requests.push({ url, options });
		if (url.includes('crossref')) return Response.json({ message: { items: [] } });
		return Response.json({ notes: [note(), note({ venue: 'Submitted to ICLR 2023' })] });
	} });
	let result = await providers.publishedVersions(preprint);
	assert.equal(result.items.length, 1);
	assert.equal(result.items[0].itemType, 'conferencePaper');
	assert.equal(requests.length, 2);
	for (let { url, options } of requests) {
		assert.equal(options.redirect, 'error');
		assert.ok(options.signal);
		assert.equal(options.headers.Authorization, undefined);
		assert.equal(options.body, undefined);
		assert.ok(!url.includes('private'));
	}
});

test('v2 searches recover from a v1 outage, but expired budgets cause no requests', async () => {
	let calls = 0;
	let providers = createProviders({ interval: 0, fetchImpl: async url => {
		calls++;
		if (url.includes('crossref')) return Response.json({ message: { items: [] } });
		if (url.includes('api.openreview')) return new Response('', { status: 503 });
		return Response.json({ notes: [note({ wrapped: true })] });
	} });
	assert.equal((await providers.publishedVersions(preprint)).items[0].itemType, 'conferencePaper');
	assert.equal(calls, 3);
	let result = await providers.publishedVersions(preprint, { deadline: Date.now() - 1 });
	assert.equal(result.items.length, 0);
	assert.equal(result.incomplete, true);
	assert.equal(calls, 3);
});

test('publication DOI resolution verifies identity and never copies the repository date', async () => {
	let calls = [];
	let providers = createProviders({ interval: 0, fetchImpl: async url => {
		calls.push(url);
		return Response.json({ message: { DOI: '10.1234/published', type: 'journal-article', title: [title],
			author: authors.map(name => ({ name })), 'container-title': ['Example Journal'],
			published: { 'date-parts': [[2024, 2, 3]] } } });
	} });
	let result = await providers.publishedVersions({ ...preprint, publicationHints: { doi: '10.1234/published' } });
	assert.equal(result.items[0].itemType, 'journalArticle');
	assert.equal(result.items[0].date, '2024-2-3');
	assert.equal(calls.length, 1);
	assert.ok(calls[0].endsWith('/10.1234%2Fpublished'));
});

test('publication banners require review for a wrong venue/year or an unverified publication', async () => {
	assert.ok(publicationConflict('Published as a conference paper at ICML 2023', { ...published, proceedingsTitle: 'ICLR 2023' }));
	assert.ok(publicationConflict('Accepted at ICLR 2024', published));
	let recognize = createEngine({ store: await createStore(), providers: {
		resolve: async () => ({ ...preprint, publicationHints: { comment: 'Published as a conference paper at ICLR 2023' } }),
		publishedVersions: async () => ({ items: [], incomplete: true })
	} });
	assert.equal((await recognize(extraction)).status, 'needs_review');
});

test('positive publication cache expires without extending lifetime on reads', async t => {
	let now = Date.now(), calls = 0;
	t.mock.method(Date, 'now', () => now);
	let recognize = createEngine({ store: await createStore(), providers: {
		resolve: async () => preprint, publishedVersions: async () => { calls++; return { items: [published] }; }
	} });
	await recognize(extraction);
	now += 12 * 60 * 60 * 1000;
	await recognize(extraction);
	assert.equal(calls, 1);
	now += 13 * 60 * 60 * 1000;
	await recognize(extraction);
	assert.equal(calls, 2);
});

test('jsonb object-key ordering does not bypass the publication relationship cache', async () => {
	let store = await createStore(), calls = 0;
	let recognize = createEngine({ store, providers: {
		resolve: async () => preprint,
		publishedVersions: async () => { calls++; return { items: [published] }; }
	} });
	await recognize(extraction);
	await store.put('bibliography-v3:arxiv:2304.06129', { ...preprint,
		creators: preprint.creators.map(c => ({ name: c.name, creatorType: c.creatorType })) });
	assert.equal((await recognize(extraction)).item.itemType, 'conferencePaper');
	assert.equal(calls, 1);
});

test('a conference record with different authors must not displace an exact preprint match', () => {
	let unrelated = { ...published, creators: [{ creatorType: 'author', name: 'Unrelated Author' }] };
	let result = rankCandidates([preprint, unrelated], hints);
	assert.equal(result.status, 'matched');
	assert.equal(result.item.itemType, 'preprint');
});

test('layout-derived publication candidates still require review', () => {
	let result = rankCandidates([published], { ...hints, source: 'layout' });
	assert.equal(result.status, 'needs_review');
});
