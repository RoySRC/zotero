/* global describe, beforeEach, afterEach, it, assert, sinon, getPromiseError,
	loadPrefPane, importPDFAttachment */
"use strict";

describe('PDF recognition engines', function () {
	let sandbox, saved, preferences;
	let recognizer = Zotero.RecognizeDocument;
	let prefs = ['recognize.engine', 'recognize.url', 'sync.metadata.postgresql.url'];
	const server = 'https://metadata.example.test/api/';
	const payload = { metadata: {}, totalPages: 1, pages: [[600, 800, []]], fileName: 'test.pdf' };

	beforeEach(function () {
		saved = prefs.map(name => [name, Zotero.Prefs.get(name)]);
		sandbox = sinon.createSandbox();
		Zotero.Prefs.set('recognize.engine', 'epilib');
		Zotero.Prefs.set('sync.metadata.postgresql.url', server);
		Zotero.Prefs.set('recognize.url', 'https://zotero-recognizer.example.test/');
		sandbox.stub(Zotero.Sync.Metadata, 'getPostgreSQLAPIKey').resolves('test-token');
	});

	afterEach(function () {
		preferences?.close();
		preferences = null;
		sandbox.restore();
		for (let [name, value] of saved) {
			if (value === undefined) Zotero.Prefs.clear(name);
			else Zotero.Prefs.set(name, value);
		}
	});

	it('sends unchanged extraction only to EpiLib with the PostgreSQL token', async function () {
		let http = sandbox.stub(Zotero.HTTP, 'request').resolves({ status: 200, responseText: '{"doi":"10.1234/test"}' });
		assert.deepEqual(await recognizer.queryPDFMetadata(payload), { doi: '10.1234/test' });
		let [method, url, options] = http.firstCall.args;
		assert.equal(method, 'POST');
		assert.equal(url, server + 'recognizer/recognize');
		assert.equal(options.headers['Zotero-API-Key'], 'test-token');
		assert.deepEqual(JSON.parse(options.body), payload);
		assert.equal(options.logBodyLength, 0);
		assert.isFalse(options.followRedirects);
		assert.isTrue(options.anon);
		assert.equal(options.errorDelayMax, 0);
	});

	it('keeps Zotero recognition independent of sync accounts and never sends their token', async function () {
		Zotero.Prefs.set('recognize.engine', 'zotero');
		let http = sandbox.stub(Zotero.HTTP, 'request').resolves({ status: 200, responseText: 'null' });
		assert.isNull(await recognizer.queryPDFMetadata(payload));
		assert.equal(http.firstCall.args[1], 'https://zotero-recognizer.example.test/recognize');
		assert.isUndefined(http.firstCall.args[2].headers['Zotero-API-Key']);
		assert.isFalse(Zotero.Sync.Metadata.getPostgreSQLAPIKey.called);
	});

	it('rejects missing URL, missing login and unknown engines before sending data', async function () {
		let http = sandbox.stub(Zotero.HTTP, 'request');
		Zotero.Prefs.set('sync.metadata.postgresql.url', '');
		assert.include((await getPromiseError(recognizer.queryPDFMetadata(payload))).message, 'Account Settings');
		Zotero.Prefs.set('sync.metadata.postgresql.url', server);
		Zotero.Sync.Metadata.getPostgreSQLAPIKey.resolves(null);
		assert.include((await getPromiseError(recognizer.queryPDFMetadata(payload))).message, 'Log in');
		Zotero.Prefs.set('recognize.engine', 'unknown');
		assert.include((await getPromiseError(recognizer.queryPDFMetadata(payload))).message, 'supported');
		assert.isFalse(http.called);
	});

	it('does not fall back or follow a redirect on server errors', async function () {
		let http = sandbox.stub(Zotero.HTTP, 'request');
		for (let status of [302, 401, 403, 404, 500]) {
			http.resetHistory();
			http.resolves({ status, responseText: '{"doi":"10.1234/untrusted"}' });
			assert.isString((await getPromiseError(recognizer.queryPDFMetadata(payload))).message);
			assert.isTrue(http.calledOnce);
			assert.equal(http.firstCall.args[1], server + 'recognizer/recognize');
		}
		http.rejects(new Error('Network timeout'));
		assert.include((await getPromiseError(recognizer.queryPDFMetadata(payload))).message, 'could not complete');
	});

	it('rejects invalid JSON and malformed results without leaking response text', async function () {
		let http = sandbox.stub(Zotero.HTTP, 'request');
		for (let responseText of ['<html>private text</html>', '{}', '[]', '{"doi":17}', '{"title":"incomplete"}']) {
			http.resolves({ status: 200, responseText });
			let error = await getPromiseError(recognizer.queryPDFMetadata(payload));
			assert.include(error.message, 'supported PDF recognition response');
			assert.notInclude(error.message, 'private text');
		}
	});

	it('captures provider selection and aborts when its server changes', async function () {
		let http = sandbox.stub(Zotero.HTTP, 'request').resolves({ status: 200, responseText: 'null' });
		let configuration = recognizer.getRecognitionConfiguration();
		Zotero.Prefs.set('recognize.engine', 'zotero');
		await recognizer.queryPDFMetadata(payload, configuration);
		assert.equal(http.firstCall.args[1], server + 'recognizer/recognize');
		http.resetHistory();
		Zotero.Prefs.set('sync.metadata.postgresql.url', 'https://other.example.test/');
		assert.include((await getPromiseError(recognizer.queryPDFMetadata(payload, configuration))).message, 'changed');
		assert.isFalse(http.called);
	});

	it('verifies protocol and authentication with no document body', async function () {
		let http = sandbox.stub(Zotero.HTTP, 'request').resolves({ status: 200,
			responseText: '{"engine":"epilib","version":1,"protocol":"zotero-recognizer-json"}' });
		await recognizer.verifyRecognitionServer();
		assert.equal(http.firstCall.args[0], 'GET');
		assert.equal(http.firstCall.args[1], server + 'recognizer/health');
		assert.isUndefined(http.firstCall.args[2].body);
	});

	it('does not release a token if the server changes while retrieving it', async function () {
		let http = sandbox.stub(Zotero.HTTP, 'request');
		Zotero.Sync.Metadata.getPostgreSQLAPIKey.callsFake(async () => {
			Zotero.Prefs.set('sync.metadata.postgresql.url', 'https://other.example.test/');
			return 'test-token';
		});
		assert.include((await getPromiseError(recognizer.queryPDFMetadata(payload))).message, 'changed');
		assert.isFalse(http.called);
	});

	it('rejects embedded URL credentials and Zotero domains for the EpiLib server', function () {
		for (let url of [
			'https://api.zotero.org/',
			'https://user:secret@example.test/',
			'https://example.test/?key=secret',
			'https://example.test/#fragment'
		]) {
			Zotero.Prefs.set('sync.metadata.postgresql.url', url);
			assert.throws(() => recognizer.getRecognitionConfiguration());
		}
	});

	it('retains extraction and item creation while disabling EpiLib feedback uploads', async function () {
		let attachment = await importPDFAttachment();
		let extraction = sandbox.stub(Zotero.PDFWorker, 'getRecognizerData').resolves({
			metadata: {}, totalPages: 1, pages: [[600, 800, ['extracted text']]]
		});
		let http = sandbox.stub(Zotero.HTTP, 'request').resolves({ status: 200,
			responseText: '{"title":"Test paper","authors":[{"firstName":"A","lastName":"Researcher"}]}' });
		let parent;
		try {
			parent = await recognizer._recognize(attachment);
			assert.isTrue(extraction.calledOnce);
			assert.equal(parent.getField('title'), 'Test paper');
			assert.equal(parent.getField('libraryCatalog'), 'EpiLib');
			Zotero.Prefs.set('recognize.engine', 'zotero');
			assert.include((await getPromiseError(recognizer.report(parent, 'Wrong match'))).message, 'unavailable');
			assert.isTrue(http.calledOnce);
		}
		finally {
			await attachment.eraseTx();
			if (parent) await parent.eraseTx();
		}
	});

	it('renders labelled native settings and persists changes without a network request', async function () {
		let http = sandbox.stub(Zotero.HTTP, 'request').rejects(new Error('Unexpected request'));
		preferences = await loadPrefPane('general');
		let doc = preferences.document;
		await doc.l10n.translateFragment(doc.getElementById('pdf-recognition-group'));
		let menu = doc.getElementById('pdf-recognition-engine');
		assert.equal(menu.value, 'epilib');
		assert.equal(menu.querySelector('[value="zotero"]').label, 'Zotero');
		assert.equal(menu.querySelector('[value="epilib"]').label, 'EpiLib');
		assert.equal(doc.querySelector('[control="pdf-recognition-engine"]').textContent.trim(), 'Engine:');
		assert.isFalse(doc.getElementById('pdf-recognition-server').hidden);
		assert.equal(doc.getElementById('pdf-recognition-url').value, server + 'recognizer/');
		menu.value = 'zotero';
		menu.dispatchEvent(new preferences.Event('command', { bubbles: true }));
		assert.equal(Zotero.Prefs.get('recognize.engine'), 'zotero');
		assert.isTrue(doc.getElementById('pdf-recognition-server').hidden);
		assert.isFalse(http.called);
	});

	it('discards a late verification result after selecting a different engine', async function () {
		preferences = await loadPrefPane('general');
		let resolve;
		sandbox.stub(recognizer, 'verifyRecognitionServer').returns(new Promise((r) => {
			resolve = r;
		}));
		let controller = preferences.Zotero_Preferences.General;
		let pending = controller.verifyRecognitionServer();
		Zotero.Prefs.set('recognize.engine', 'zotero');
		controller._updateRecognitionUI();
		resolve({ engine: 'epilib' });
		await pending;
		assert.equal(preferences.document.getElementById('pdf-recognition-status').textContent, '');
	});

	it('keeps explicit Zotero feedback on its original server after changing settings', async function () {
		Zotero.Prefs.set('recognize.engine', 'zotero');
		let attachment = await importPDFAttachment();
		sandbox.stub(Zotero.PDFWorker, 'getRecognizerData').resolves({ pages: [[600, 800, ['text']]] });
		let http = sandbox.stub(Zotero.HTTP, 'request').resolves({ status: 200,
			responseText: '{"title":"Test paper","authors":[]}' });
		let parent;
		try {
			parent = await recognizer._recognize(attachment);
			attachment.parentID = parent.id;
			await attachment.saveTx();
			Zotero.Prefs.set('recognize.engine', 'epilib');
			Zotero.Prefs.set('recognize.url', 'https://different.example.test/');
			http.resolves({ status: 204, responseText: '' });
			await recognizer.report(parent, 'Wrong match');
			assert.equal(http.lastCall.args[1], 'https://zotero-recognizer.example.test/report');
			assert.isUndefined(http.lastCall.args[2].headers['Zotero-API-Key']);
			assert.isFalse(Zotero.Sync.Metadata.getPostgreSQLAPIKey.called);
		}
		finally {
			if (parent) await parent.eraseTx();
			else await attachment.eraseTx();
		}
	});
});
