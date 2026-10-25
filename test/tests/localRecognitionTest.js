/* global describe, beforeEach, afterEach, it, assert, sinon, loadPrefPane, getPromiseError */
"use strict";

describe('Bundled local recognition', function () {
	this.timeout(45000);
	let sandbox, client, cachePath, saved, preferences;
	const names = ['recognize.engine', 'recognize.epilib.url', 'sync.metadata.postgresql.url'];
	const work = { type: 'journal-article', DOI: '10.1234/desktop', title: ['Reliable local metadata recognition'],
		author: [{ given: 'Ada', family: 'Example' }], published: { 'date-parts': [[2025]] },
		'container-title': ['Synthetic Journal'], volume: '1', page: '1-10' };
	const payload = { metadata: { DOI: work.DOI }, totalPages: 0, pages: [], fileName: 'private-test-file.pdf' };

	beforeEach(function () {
		sandbox = sinon.createSandbox();
		saved = names.map(name => [name, Zotero.Prefs.get(name)]);
		Zotero.Prefs.set('recognize.engine', 'epilib-local');
		Zotero.Prefs.set('recognize.epilib.url', '');
		Zotero.Prefs.set('sync.metadata.postgresql.url', '');
		cachePath = PathUtils.join(PathUtils.tempDir, 'epilib-recognition-' + Zotero.Utilities.randomString() + '.sqlite');
		client = new Zotero.LocalRecognitionClient({ cachePath });
	});

	afterEach(async function () {
		preferences?.close();
		preferences = null;
		await client.close();
		sandbox.restore();
		for (const [name, value] of saved) {
			if (value === undefined) Zotero.Prefs.clear(name);
			else Zotero.Prefs.set(name, value);
		}
		for (const suffix of ['', '-wal', '-shm']) await IOUtils.remove(cachePath + suffix, { ignoreAbsent: true });
	});

	/** Network fixtures still traverse the actual packaged worker and native SQLite. */
	function mockCatalogs() {
		return sandbox.stub(Zotero.HTTP, 'request').callsFake(async (method, url, options) => {
			assert.isTrue(options.anon);
			assert.isFalse(options.followRedirects);
			assert.equal(options.logBodyLength, 0);
			assert.isUndefined(options.headers['Zotero-API-Key']);
			assert.notInclude(JSON.stringify([url, options.body]), payload.fileName);
			const crossref = url.startsWith('https://api.crossref.org/works/');
			return { status: crossref ? 200 : 404,
				response: new TextEncoder().encode(JSON.stringify(crossref ? { message: work } : {})).buffer,
				getResponseHeader: name => name == 'Content-Type' ? 'application/json' : '' };
		});
	}

	it('runs the real worker, persists public records, and reuses them offline after reopening', async function () {
		const http = mockCatalogs();
		const result = await client.recognize(payload, { crossref: 'synthetic-plus-key' }, 'account-a');
		assert.equal(result.status, 'matched');
		assert.equal(result.item.title, work.title[0]);
		assert.isTrue(http.called);
		for (const call of http.getCalls()) {
			assert.equal(call.args[2].headers['Crossref-Plus-API-Token'],
				call.args[1].startsWith('https://api.crossref.org/') ? 'Bearer synthetic-plus-key' : undefined);
		}
		await client.close();
		assert.isTrue(await IOUtils.exists(cachePath));
		const raw = new TextDecoder().decode(await IOUtils.read(cachePath));
		assert.notInclude(raw, payload.fileName);
		assert.notInclude(raw, 'synthetic-plus-key');
		client = new Zotero.LocalRecognitionClient({ cachePath });
		const offline = sandbox.stub(client, '_fetchProvider').rejects(new Error('Offline'));
		const cached = await client.recognize(payload, {}, 'account-a');
		assert.equal(cached.status, 'matched');
		assert.equal(cached.item.title, work.title[0]);
		assert.isNotNull(await (await client._openCache()).get('account-a', 'bibliography-v4:doi:' + work.DOI));
		assert.isNull(await (await client._openCache()).get('account-b', 'bibliography-v4:doi:' + work.DOI));
		assert.isTrue(offline.called); // Enrichment remains retryable instead of caching outages.
	});

	it('routes desktop recognition locally with no account login or recognition server request', async function () {
		const recognize = sandbox.stub(Zotero.LocalRecognition, 'recognize').resolves({ engine: 'epilib', version: 2, status: 'no_match' });
		const login = sandbox.stub(Zotero.Sync.Metadata, 'getPostgreSQLAPIKey').rejects(new Error('Must not authenticate'));
		const http = sandbox.stub(Zotero.HTTP, 'request').rejects(new Error('Must not contact server'));
		sandbox.stub(Zotero.RecognizeDocument, 'getProviderCredentials').resolves({ pubmed: 'synthetic-key' });
		const configuration = Zotero.RecognizeDocument.getRecognitionConfiguration();
		assert.equal(configuration.execution, 'local');
		await Zotero.RecognizeDocument.queryPDFMetadata({ ...payload, providerKeys: { crossref: 'untrusted' } }, configuration);
		assert.isTrue(recognize.calledOnce);
		assert.deepEqual(recognize.firstCall.args[0], payload);
		assert.deepEqual(recognize.firstCall.args[1], { pubmed: 'synthetic-key' });
		assert.isFalse(http.called);
		assert.isFalse(login.called);
	});

	it('cancels pending work and permits a fresh worker without reusing request identifiers', async function () {
		let started;
		const ready = new Promise(resolve => { started = resolve; });
		const pending = sandbox.stub(client, '_fetchProvider').callsFake(() => { started(); return new Promise(() => {}); });
		const result = getPromiseError(client.recognize(payload));
		await ready;
		client.cancelAll();
		assert.include((await result).message, 'cancelled');
		const firstID = pending.firstCall.args[0];
		pending.restore();
		mockCatalogs();
		const requests = sandbox.spy(client, '_fetchProvider');
		assert.equal((await client.recognize(payload)).status, 'matched');
		assert.notEqual(requests.firstCall.args[0], firstID);
	});

	it('continues recognition when the cache cannot open and rejects oversized input', async function () {
		await client.close();
		client = new Zotero.LocalRecognitionClient({ cachePath: PathUtils.join(cachePath, 'missing', 'cache.sqlite') });
		mockCatalogs();
		assert.equal((await client.recognize(payload)).status, 'matched');
		assert.include((await getPromiseError(client.recognize({ text: 'x'.repeat(6 * 1024 * 1024) }))).message, 'too large');
	});

	it('migrates the old EpiLib transport without changing explicit Zotero selection', function () {
		Zotero.Prefs.set('recognize.engine', 'epilib');
		Zotero.Prefs.migrateLocalRecognition();
		assert.equal(Zotero.Prefs.get('recognize.engine'), 'epilib-local');
		Zotero.Prefs.set('recognize.engine', 'zotero');
		Zotero.Prefs.migrateLocalRecognition();
		assert.equal(Zotero.Prefs.get('recognize.engine'), 'zotero');
	});

	it('releases a job immediately if structured cloning rejects its input', async function () {
		const error = await getPromiseError(client.recognize(payload, { invalid: () => {} }));
		assert.include(error.message, 'Invalid local recognition input');
		assert.equal(client._jobs.size, 0);
	});

	it('creates a bibliographic parent through the existing PDF workflow using the bundled engine', async function () {
		const attachment = await importPDFAttachment();
		let parent;
		mockCatalogs();
		sandbox.stub(Zotero.LocalRecognition, 'recognize').callsFake((...args) => client.recognize(...args));
		sandbox.stub(Zotero.RecognizeDocument, 'getProviderCredentials').resolves({});
		sandbox.stub(Zotero.PDFWorker, 'getRecognizerData').resolves({ ...payload,
			totalPages: 1, pages: [[600, 800, ['DOI: ' + work.DOI]]] });
		try {
			parent = await Zotero.RecognizeDocument._recognize(attachment);
			assert.equal(parent.getField('title'), work.title[0]);
			assert.equal(parent.getField('DOI'), work.DOI);
			assert.equal(parent.libraryID, attachment.libraryID);
			assert.equal(parent.getCreators()[0].lastName, 'Example');
		}
		finally {
			await attachment.eraseTx();
			if (parent) await parent.eraseTx();
		}
	});

	it('hides remote configuration but leaves labelled API-key controls available', async function () {
		preferences = await loadPrefPane('general');
		const doc = preferences.document;
		await preferences.Zotero_Preferences.General._loadProviderKeysUI(true);
		await doc.l10n.translateFragment(doc.getElementById('recognition-provider-keys'));
		assert.equal(doc.getElementById('pdf-recognition-engine').value, 'epilib-local');
		assert.equal(doc.getElementById('pdf-recognition-url').getBoundingClientRect().width, 0);
		assert.isAbove(doc.getElementById('recognition-provider-key-pubmed').getBoundingClientRect().width, 100);
		assert.isNotEmpty(doc.querySelector('label[for="recognition-provider-key-pubmed"]').textContent);
	});
});
