/* global describe, beforeEach, afterEach, it, assert, sinon, loadPrefPane */
"use strict";

describe('Shared recognition repository', function () {
	this.timeout(45000);
	let sandbox, client, cachePath, saved, preferences;
	const names = ['recognize.engine', 'recognize.epilib.url', 'sync.metadata.postgresql.url',
		'recognize.repository.enabled', 'recognize.repository.contribute'];
	const item = { itemType: 'journalArticle', title: 'Reliable shared metadata recognition',
		creators: [{ creatorType: 'author', firstName: 'Ada', lastName: 'Example' }], DOI: '10.1234/shared-desktop',
		date: '2025', libraryCatalog: 'Crossref' };
	const payload = { metadata: { DOI: item.DOI }, totalPages: 0, pages: [], fileName: 'private-file.pdf' };
	const query = { schema: 1, identifiers: [{ kind: 'doi', value: item.DOI }], title: '', author: '', year: '' };
	const hit = () => ({ schema: 1, records: [{ item, source: 'Crossref', id: 'a'.repeat(64), expiresAt: Date.now() + 60000 }] });
	const response = (status, data) => ({ status, response: new TextEncoder().encode(JSON.stringify(data)).buffer,
		getResponseHeader: name => name == 'Content-Type' ? 'application/json' : '' });

	beforeEach(function () {
		sandbox = sinon.createSandbox(); saved = names.map(name => [name, Zotero.Prefs.get(name)]);
		Zotero.Prefs.set('recognize.engine', 'epilib-local');
		Zotero.Prefs.set('recognize.epilib.url', '');
		Zotero.Prefs.set('sync.metadata.postgresql.url', 'https://repository.example.invalid/');
		Zotero.Prefs.set('recognize.repository.enabled', true);
		Zotero.Prefs.set('recognize.repository.contribute', false);
		sandbox.stub(Zotero.Users, 'getCurrentUserID').returns(123);
		sandbox.stub(Zotero.Sync.Metadata, 'getPostgreSQLAPIKey').resolves('synthetic-account-token');
		cachePath = PathUtils.join(PathUtils.tempDir, 'epilib-shared-' + Zotero.Utilities.randomString() + '.sqlite');
		client = new Zotero.LocalRecognitionClient({ cachePath });
	});

	afterEach(async function () {
		preferences?.close(); preferences = null;
		await client.close(); sandbox.restore();
		for (const [name, value] of saved) {
			if (value === undefined) Zotero.Prefs.clear(name); else Zotero.Prefs.set(name, value);
		}
		for (const suffix of ['', '-wal', '-shm']) await IOUtils.remove(cachePath + suffix, { ignoreAbsent: true });
	});

	/** Real worker/SQLite path, with only the network boundary replaced by fixtures. */
	it('queries the account repository before providers, preserves review, and reuses SQLite after restart', async function () {
		const http = sandbox.stub(Zotero.HTTP, 'request').callsFake(async (method, url, options) => {
			assert.equal(method, 'POST');
			assert.equal(url, 'https://repository.example.invalid/metadata-repository/v1/query');
			assert.deepEqual(JSON.parse(options.body), query);
			assert.equal(options.headers['Zotero-API-Key'], 'synthetic-account-token');
			assert.isTrue(options.anon); assert.isFalse(options.followRedirects);
			assert.equal(options.logBodyLength, 0); assert.equal(options.errorDelayMax, 0);
			return response(200, hit());
		});
		sandbox.stub(Zotero.LocalRecognition, 'recognize').callsFake((...args) => client.recognize(...args));
		sandbox.stub(Zotero.RecognizeDocument, 'getProviderCredentials').resolves({});
		const result = await Zotero.RecognizeDocument.queryPDFMetadata(payload);
		assert.equal(result.status, 'needs_review');
		assert.equal(result.candidates[0].item.title, item.title);
		assert.include(JSON.stringify(result.review), 'EpiLib repository (unverified): Crossref');
		assert.isTrue(http.calledOnce);
		await client.close(); client = new Zotero.LocalRecognitionClient({ cachePath });
		assert.equal((await Zotero.RecognizeDocument.queryPDFMetadata(payload)).status, 'needs_review');
		assert.isTrue(http.calledOnce);
		await client.close();
		const raw = new TextDecoder().decode(await IOUtils.read(cachePath));
		assert.notInclude(raw, 'synthetic-account-token'); assert.notInclude(raw, payload.fileName);
	});

	/** Catalog fixtures let us verify opt-in transport without external providers. */
	function mockMiss(status = 200) {
		return sandbox.stub(Zotero.HTTP, 'request').callsFake(async (_method, url, options) => {
			if (url.includes('/metadata-repository/')) {
				assert.notInclude(options.body, payload.fileName);
				return url.endsWith('/records') ? response(201, { schema: 1, id: 'b'.repeat(64) })
					: response(status, { schema: 1, records: [] });
			}
			assert.isUndefined(options.headers['Zotero-API-Key']);
			const crossref = url.startsWith('https://api.crossref.org/works/');
			return response(crossref ? 200 : 404, crossref ? { message: { type: 'journal-article',
				DOI: item.DOI, title: [item.title], author: [{ given: 'Ada', family: 'Example' }],
				published: { 'date-parts': [[2025]] } } } : {});
		});
	}

	it('falls back on old-server 404 and never submits without opt-in', async function () {
		const http = mockMiss(404);
		assert.equal((await client.recognize(payload)).status, 'matched');
		assert.include(http.firstCall.args[1], '/metadata-repository/v1/query');
		assert.isFalse(http.getCalls().some(call => call.args[1].endsWith('/records')));
	});

	it('submits public catalog metadata when opted in without forwarding provider keys', async function () {
		Zotero.Prefs.set('recognize.repository.contribute', true);
		const http = mockMiss();
		assert.equal((await client.recognize(payload, { crossref: 'synthetic-catalog-token' })).status, 'matched');
		await Promise.allSettled(client._contributions);
		const write = http.getCalls().find(call => call.args[1].endsWith('/records'));
		assert.isOk(write);
		assert.equal(JSON.parse(write.args[2].body).record.item.DOI, item.DOI);
		assert.notInclude(write.args[2].body, 'synthetic-catalog-token');
		assert.notInclude(write.args[2].body, payload.fileName);
	});

	it('disabling repository lookup uses local catalogs without an account token lookup', async function () {
		Zotero.Prefs.set('recognize.repository.enabled', false);
		const http = mockMiss();
		assert.equal((await client.recognize(payload)).status, 'matched');
		assert.isFalse(Zotero.Sync.Metadata.getPostgreSQLAPIKey.called);
		assert.isFalse(http.getCalls().some(call => call.args[1].includes('/metadata-repository/')));
	});

	it('rejects remote plaintext, embedded credentials and Zotero destinations', function () {
		for (const url of ['http://remote.invalid/', 'https://user:password@remote.invalid/', 'https://api.zotero.org/', 'https://remote.invalid/?token=secret']) {
			Zotero.Prefs.set('sync.metadata.postgresql.url', url);
			assert.isNull(client._repositoryConfiguration());
		}
		Zotero.Prefs.set('sync.metadata.postgresql.url', 'http://127.0.0.1:23129/');
		assert.isNotNull(client._repositoryConfiguration());
	});

	it('drops pending token reads on account switch or cancellation', async function () {
		const http = sandbox.stub(Zotero.HTTP, 'request').rejects(new Error('Must not send stale credentials'));
		for (const cancel of [false, true]) {
			let resolve;
			Zotero.Sync.Metadata.getPostgreSQLAPIKey.callsFake(() => new Promise(done => { resolve = done; }));
			const pending = client._requestRepository(client._repositoryConfiguration(), 'query', query, 'test-token');
			if (cancel) client.cancelAll();
			else Zotero.Users.getCurrentUserID.returns(456);
			resolve('old-account-token');
			assert.isNull(await pending);
		}
		assert.isFalse(http.called);
	});

	it('rejects redirects, malformed JSON and oversized replies without forwarding a token', async function () {
		const http = sandbox.stub(Zotero.HTTP, 'request');
		for (const reply of [response(302, {}), { status: 200, response: new TextEncoder().encode('<html>').buffer },
			{ status: 200, response: new ArrayBuffer(129 * 1024) }]) {
			http.resolves(reply);
			assert.isNull(await client._requestRepository(client._repositoryConfiguration(), 'query', query, 'test-bad-reply'));
		}
		assert.equal(http.callCount, 3);
		assert.isTrue(http.getCalls().every(call => call.args[2].followRedirects === false));
	});

	it('shows labelled opt-in controls only for local EpiLib recognition', async function () {
		preferences = await loadPrefPane('general');
		const doc = preferences.document;
		const group = doc.getElementById('pdf-recognition-repository-settings');
		await doc.l10n.translateFragment(group);
		assert.isAbove(group.getBoundingClientRect().height, 0);
		assert.isNotEmpty(doc.getElementById('pdf-recognition-repository').label);
		assert.isNotEmpty(doc.getElementById('pdf-recognition-contribute').label);
		assert.isFalse(doc.getElementById('pdf-recognition-contribute').checked);
		Zotero.Prefs.set('recognize.engine', 'zotero');
		preferences.Zotero_Preferences.General._updateRecognitionUI();
		assert.equal(group.getBoundingClientRect().height, 0);
	});
});
