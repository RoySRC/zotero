import assert from 'node:assert/strict';
import test from 'node:test';
import { fromCrossref, fromDataCite } from '../src/metadata.mjs';
import { createProviders } from '../src/providers.mjs';

// Synthetic DataCite/arXiv record with the fields that the original adapter lost.
// Tests do not depend on the user's library, PDF text, or a public API being up.
const work = {
	doi: '10.48550/arxiv.2401.12345', url: 'https://arxiv.org/abs/2401.12345',
	titles: [{ title: 'A preprint with complete bibliographic metadata' }],
	types: { resourceTypeGeneral: 'Preprint' }, publicationYear: 2024, publisher: 'arXiv',
	creators: [{ givenName: 'Ada', familyName: 'Example', name: 'Example, Ada' }],
	descriptions: [{ descriptionType: 'Methods', description: 'Not the abstract.' },
		{ descriptionType: 'Abstract', description: '<p>A complete <i>abstract</i> with details.</p>' }],
	dates: [{ dateType: 'Updated', date: '2025-03-02T01:02:03Z' },
		{ dateType: 'Available', date: '2024-01' }, { dateType: 'Submitted', date: '2024-01-14T20:18:42Z' }],
	identifiers: [{ identifierType: 'arXiv', identifier: '2401.12345' }], language: 'en',
	subjects: [{ subject: 'Analysis of PDEs (math.AP)' }, { subject: 'Spectral Theory (math.SP)' },
		{ subject: 'Analysis of PDEs (math.AP)' }],
	rightsList: [{ rights: 'Creative Commons Attribution 4.0 International' }]
};

test('DataCite preprints preserve abstract, precise date, repository, identifiers, rights and subjects', () => {
	let item = fromDataCite(work);
	assert.equal(item.abstractNote, 'A complete abstract with details.');
	assert.equal(item.date, '2024-01-14');
	assert.equal(item.repository, 'arXiv');
	assert.equal(item.archiveID, 'arXiv:2401.12345');
	assert.equal(item.DOI, work.doi);
	assert.equal(item.url, work.url);
	assert.equal(item.language, 'en');
	assert.equal(item.rights, work.rightsList[0].rights);
	assert.deepEqual(item.creators, [{ creatorType: 'author', firstName: 'Ada', lastName: 'Example' }]);
	assert.deepEqual(item.tags, [{ tag: 'Analysis of PDEs (math.AP)', type: 1 }, { tag: 'Spectral Theory (math.SP)', type: 1 }]);
});

test('the DOI fallback path keeps the complete DataCite projection', async () => {
	let providers = createProviders({ interval: 0, fetchImpl: async url => String(url).includes('api.crossref.org')
		? new Response('', { status: 404 }) : Response.json({ data: { attributes: work } }) });
	assert.deepEqual(await providers.resolve('doi', work.doi), fromDataCite(work));
});

test('publication date selection does not confuse submission or update with issue', () => {
	let article = { ...work, types: { resourceTypeGeneral: 'JournalArticle' } };
	assert.equal(fromDataCite(article).date, '2024-01');
	assert.equal(fromDataCite({ ...article, dates: [] }).date, '2024');
	assert.equal(fromDataCite({ ...work, dates: [{ dateType: 'Issued', date: '2024-02-12' }, ...work.dates] }).date, '2024-02-12');
	assert.equal(fromDataCite({ ...work, dates: [{ dateType: 'Updated', date: '2025-01-01' }] }).date, '2024');
});

test('missing optional fields stay missing; structured publishers map to valid type-specific fields', () => {
	let minimal = { doi: work.doi, titles: work.titles, types: work.types };
	let item = fromDataCite(minimal);
	for (let field of ['abstractNote', 'repository', 'archiveID', 'language', 'rights', 'tags']) {
		assert.equal(item[field], undefined);
	}
	for (let [type, field] of [['Preprint', 'repository'], ['Book', 'publisher'], ['Dissertation', 'university'], ['Report', 'institution']]) {
		item = fromDataCite({ ...minimal, types: { resourceTypeGeneral: type }, publisher: { name: 'Example Publisher' } });
		assert.equal(item[field], 'Example Publisher');
	}
});

test('provider metadata is bounded and executable or credential-bearing URLs cannot become landing pages', () => {
	for (let url of ['javascript:alert(1)', 'https://user:secret@example.test/']) {
		assert.equal(fromDataCite({ ...work, url }).url, 'https://doi.org/' + work.doi);
	}
	let item = fromDataCite({ ...work,
		descriptions: [{ descriptionType: 'Abstract', description: 'x'.repeat(25000) }],
		subjects: Array.from({ length: 200 }, (_, index) => ({ subject: index + 'x'.repeat(300) })) });
	assert.equal(item.abstractNote.length, 20000);
	assert.equal(item.tags.length, 100);
	assert.ok(item.tags.every(tag => tag.tag.length <= 255 && tag.type == 1));
});

test('Crossref journal records also preserve abstracts, language and automatic subjects', () => {
	let item = fromCrossref({ type: 'journal-article', DOI: '10.1234/test?value', title: ['Title'],
		abstract: '<jats:p>Full abstract.</jats:p>', language: 'en', subject: ['Physics', 'Physics'],
		published: { 'date-parts': [[2024, 1, 2]] } });
	assert.equal(item.abstractNote, 'Full abstract.');
	assert.equal(item.language, 'en');
	assert.deepEqual(item.tags, [{ tag: 'Physics', type: 1 }]);
	assert.equal(item.date, '2024-1-2');
	assert.equal(item.url, 'https://doi.org/10.1234/test%3Fvalue');
});
