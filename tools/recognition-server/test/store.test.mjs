import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import pg from 'pg';
import { createStore } from '../src/store.mjs';
import { createEngine } from '../src/engine.mjs';
import { fromCrossref } from '../src/metadata.mjs';
import { evaluate } from '../src/evaluate-crossref.mjs';

/** Integration uses a fresh database, never tables in the supplied operator database. */
test('PostgreSQL cache, local index, re-import and evaluation persist correctly', {
	skip: !process.env.TEST_DATABASE_URL
}, async t => {
	let admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
	let name = 'recognition_test_' + randomBytes(8).toString('hex');
	let store, created = false;
	let dir = await mkdtemp(join(tmpdir(), 'epilib-index-test-'));
	t.after(async () => {
		await store?.close();
		if (created) await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
		await admin.end();
		await rm(dir, { recursive: true, force: true });
	});
	await admin.query(`CREATE DATABASE ${name}`);
	created = true;
	let url = new URL(process.env.TEST_DATABASE_URL);
	url.pathname = '/' + name;
	store = await createStore(url.href);
	let works = Array.from({ length: 100 }, (_unused, index) => ({
		type: 'journal-article', DOI: `10.1234/test-${index}`,
		title: [`Reliable sample metadata experiment ${index}`], author: [{ family: 'Example' }]
	}));
	let file = join(dir, 'sample.json');
	await writeFile(file, JSON.stringify({ items: works }));
	let report = await evaluate({ file, store });
	assert.equal(report.index.records, 100);
	assert.ok(Number(report.index.bytes) > 0);
	assert.equal(report.lookupPairMilliseconds.count, 100);
	let record = fromCrossref(works[0]);
	await store.put('doi:' + record.DOI, record);
	assert.deepEqual(await store.get('doi:' + record.DOI), record);
	await store.importRecord({ ...record, title: 'Updated title' });
	assert.equal((await store.stats()).records, 100);
	assert.equal((await store.localDOI(record.DOI)).title, 'Updated title');
	assert.equal((await store.search('Updated title'))[0].DOI, record.DOI);
	let offline = createEngine({ store, providers: {}, mode: 'local' });
	assert.equal((await offline({ pages: [], totalPages: 0, metadata: { DOI: record.DOI } })).item.title, 'Updated title');
	assert.equal((await offline({ pages: [], totalPages: 0, metadata: { DOI: '10.1234/missing' } })).status, 'no_match');
	// Public, synthetic benchmark diagnostics contain no account or PDF data.
	t.diagnostic(JSON.stringify(report));
});
