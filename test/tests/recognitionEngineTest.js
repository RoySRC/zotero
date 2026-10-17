/* global describe, beforeEach, afterEach, it, assert, sinon, getPromiseError,
	loadPrefPane, importPDFAttachment, createDataObject, createAnnotation, loadZoteroPane */
"use strict";

describe('PDF recognition engines', function () {
	let sandbox, saved, preferences;
	let recognizer = Zotero.RecognizeDocument;
	let prefs = ['recognize.engine', 'recognize.url', 'recognize.epilib.url', 'sync.metadata.postgresql.url',
		'recognize.grobid.enabled', 'recognize.grobid.url', 'automaticTags'];
	const server = 'https://metadata.example.test/api/';
	const payload = { metadata: {}, totalPages: 1, pages: [[600, 800, []]], fileName: 'test.pdf' };

	beforeEach(function () {
		saved = prefs.map(name => [name, Zotero.Prefs.get(name)]);
		sandbox = sinon.createSandbox();
		Zotero.Prefs.set('recognize.engine', 'epilib');
		Zotero.Prefs.set('recognize.epilib.url', '');
		Zotero.Prefs.set('automaticTags', true);
		Zotero.Prefs.set('recognize.grobid.enabled', false);
		Zotero.Prefs.set('recognize.grobid.url', 'http://127.0.0.1:8070/');
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
		Zotero.Prefs.set('recognize.epilib.url', 'https://custom.example.test/');
		let http = sandbox.stub(Zotero.HTTP, 'request').resolves({ status: 200, responseText: 'null' });
		assert.isNull(await recognizer.queryPDFMetadata(payload));
		assert.equal(http.firstCall.args[1], 'https://zotero-recognizer.example.test/recognize');
		assert.isUndefined(http.firstCall.args[2].headers['Zotero-API-Key']);
		assert.isFalse(Zotero.Sync.Metadata.getPostgreSQLAPIKey.called);
	});

	it('normalizes an explicit account gateway URL and retains account authentication', async function () {
		Zotero.Prefs.set('recognize.epilib.url', '  https://METADATA.example.test:443/api/recognizer  ');
		let http = sandbox.stub(Zotero.HTTP, 'request').resolves({ status: 200, responseText: 'null' });
		await recognizer.queryPDFMetadata(payload);
		assert.equal(http.firstCall.args[1], server + 'recognizer/recognize');
		assert.equal(http.firstCall.args[2].headers['Zotero-API-Key'], 'test-token');
		assert.equal(Zotero.Prefs.get('sync.metadata.postgresql.url'), server);
	});

	it('never sends account credentials to a custom destination, even on the same host', async function () {
		let http = sandbox.stub(Zotero.HTTP, 'request').resolves({ status: 200, responseText: 'null' });
		for (let url of ['https://custom.example.test/v2', 'https://metadata.example.test/other/',
			'http://metadata.example.test/api/recognizer/', 'https://metadata.example.test:8443/api/recognizer/']) {
			Zotero.Prefs.set('recognize.epilib.url', url);
			http.resetHistory();
			await recognizer.queryPDFMetadata(payload);
			assert.equal(http.firstCall.args[1], url.replace(/\/$/, '') + '/recognize');
			assert.isUndefined(http.firstCall.args[2].headers['Zotero-API-Key']);
			assert.isUndefined(http.firstCall.args[2].headers.Authorization);
			assert.isTrue(http.firstCall.args[2].anon);
			assert.isFalse(http.firstCall.args[2].followRedirects);
		}
		assert.isFalse(Zotero.Sync.Metadata.getPostgreSQLAPIKey.called);
	});

	it('supports custom recognizers without an account and explains separate authentication failures', async function () {
		Zotero.Prefs.set('sync.metadata.postgresql.url', '');
		Zotero.Prefs.set('recognize.epilib.url', 'http://127.0.0.1:23130/');
		let http = sandbox.stub(Zotero.HTTP, 'request').resolves({ status: 403, responseText: '{"error":"forbidden"}' });
		assert.include((await getPromiseError(recognizer.verifyRecognitionServer())).message, 'separate authentication');
		assert.isFalse(Zotero.Sync.Metadata.getPostgreSQLAPIKey.called);
		http.resolves({ status: 200, responseText: '{"engine":"epilib","version":2,"protocol":"epilib-recognition-v2"}' });
		assert.equal((await recognizer.verifyRecognitionServer()).version, 2);
	});

	it('rejects malformed custom URLs without sending requests', async function () {
		let http = sandbox.stub(Zotero.HTTP, 'request');
		for (let url of ['not a URL', 'file:///tmp/', 'https://user:secret@example.test/',
			'https://example.test/?key=secret', 'https://example.test/#fragment']) {
			Zotero.Prefs.set('recognize.epilib.url', url);
			assert.include((await getPromiseError(recognizer.queryPDFMetadata(payload))).message, 'HTTP or HTTPS');
		}
		assert.isFalse(http.called);
	});

	it('aborts changed overrides and authentication scopes before releasing a token or PDF', async function () {
		let http = sandbox.stub(Zotero.HTTP, 'request');
		let configuration = recognizer.getRecognitionConfiguration();
		Zotero.Prefs.set('recognize.epilib.url', 'https://custom.example.test/');
		assert.include((await getPromiseError(recognizer.queryPDFMetadata(payload, configuration))).message, 'changed');
		Zotero.Prefs.set('recognize.epilib.url', server + 'recognizer/');
		Zotero.Prefs.set('sync.metadata.postgresql.url', 'https://other.example.test/');
		assert.include((await getPromiseError(recognizer.queryPDFMetadata(payload, configuration))).message, 'changed');
		assert.isFalse(http.called);
		assert.isFalse(Zotero.Sync.Metadata.getPostgreSQLAPIKey.called);

		Zotero.Prefs.set('sync.metadata.postgresql.url', server);
		Zotero.Sync.Metadata.getPostgreSQLAPIKey.callsFake(async () => {
			Zotero.Prefs.set('recognize.epilib.url', 'https://custom.example.test/');
			return 'test-token';
		});
		assert.include((await getPromiseError(recognizer.queryPDFMetadata(payload))).message, 'changed');
		assert.isFalse(http.called);
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
		assert.equal(doc.getElementById('pdf-recognition-url').placeholder, server + 'recognizer/');
		menu.value = 'zotero';
		menu.dispatchEvent(new preferences.Event('command', { bubbles: true }));
		assert.equal(Zotero.Prefs.get('recognize.engine'), 'zotero');
		assert.isTrue(doc.getElementById('pdf-recognition-server').hidden);
		assert.isFalse(http.called);
	});

	it('edits and persists the recognition URL without overwriting text or changing account settings', async function () {
		let http = sandbox.stub(Zotero.HTTP, 'request');
		preferences = await loadPrefPane('general');
		let doc = preferences.document;
		await doc.l10n.translateFragment(doc.getElementById('pdf-recognition-group'));
		let input = doc.getElementById('pdf-recognition-url');
		assert.isFalse(input.readOnly);
		assert.isFalse(input.disabled);
		assert.equal(doc.querySelector('[for="pdf-recognition-url"]').textContent, 'Server URL:');
		input.focus();
		assert.equal(doc.activeElement, input);
		// Simulate typing, including intermediate invalid text. No refresh may
		// erase the draft or make a request just because a character was entered.
		let url = 'https://custom.example.test/recognizer/';
		for (let i = 1; i <= url.length; i++) {
			input.value = url.slice(0, i);
			input.dispatchEvent(new preferences.Event('input', { bubbles: true }));
			assert.equal(input.value, url.slice(0, i));
			assert.equal(Zotero.Prefs.get('recognize.epilib.url'), input.value);
		}
		let checkbox = doc.getElementById('pdf-recognition-grobid');
		checkbox.checked = true;
		checkbox.dispatchEvent(new preferences.Event('command', { bubbles: true }));
		assert.equal(input.value, url);
		assert.equal(Zotero.Prefs.get('sync.metadata.postgresql.url'), server);
		preferences.close();
		preferences = await loadPrefPane('general');
		input = preferences.document.getElementById('pdf-recognition-url');
		assert.equal(input.value, url);
		assert.isFalse(http.called);
	});

	it('clearing the URL restores the automatic account gateway without refilling the input', async function () {
		Zotero.Prefs.set('recognize.epilib.url', 'https://custom.example.test/');
		preferences = await loadPrefPane('general');
		let input = preferences.document.getElementById('pdf-recognition-url');
		input.value = '';
		input.dispatchEvent(new preferences.Event('input', { bubbles: true }));
		assert.equal(input.value, '');
		assert.equal(Zotero.Prefs.get('recognize.epilib.url'), '');
		assert.equal(recognizer.getRecognitionConfiguration().baseURL, server + 'recognizer/');
		Zotero.Prefs.set('sync.metadata.postgresql.url', 'https://new.example.test/');
		assert.equal(input.placeholder, 'https://new.example.test/recognizer/');
		assert.equal(input.value, '');
		assert.equal(recognizer.getRecognitionConfiguration().baseURL, input.placeholder);
	});

	it('discards a pending verification after editing the recognition URL', async function () {
		preferences = await loadPrefPane('general');
		let resolve;
		sandbox.stub(recognizer, 'verifyRecognitionServer').returns(new Promise(r => { resolve = r; }));
		let pending = preferences.Zotero_Preferences.General.verifyRecognitionServer();
		let input = preferences.document.getElementById('pdf-recognition-url');
		input.value = 'https://custom.example.test/';
		input.dispatchEvent(new preferences.Event('input', { bubbles: true }));
		resolve({ engine: 'epilib' });
		await pending;
		assert.equal(preferences.document.getElementById('pdf-recognition-status').textContent, '');
		assert.isFalse(preferences.document.getElementById('pdf-recognition-verify').disabled);
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

	it('accepts complete v2 records without translator lookups or remote record identities', async function () {
		let attachment = await importPDFAttachment();
		sandbox.stub(Zotero.PDFWorker, 'getRecognizerData').resolves({ pages: [[600, 800, ['text']]] });
		let translate = sandbox.stub(Zotero.Translate, 'Search').throws(new Error('Unexpected translator'));
		sandbox.stub(Zotero.HTTP, 'request').resolves({ status: 200, responseText: JSON.stringify({ engine: 'epilib', version: 2,
			status: 'matched', item: { itemType: 'book', title: 'Complete book record', creators: [{ name: 'Example Author' }],
				ISBN: '9783034602891', libraryCatalog: 'Open Library', key: 'UNTRUSTD', libraryID: 999, attachments: [{ url: 'https://example.test/file' }] } }) });
		let parent;
		try {
			parent = await recognizer._recognize(attachment);
			assert.equal(parent.itemTypeID, Zotero.ItemTypes.getID('book'));
			assert.equal(parent.libraryID, attachment.libraryID);
			assert.notEqual(parent.key, 'UNTRUSTD');
			assert.equal(parent.numAttachments(), 0);
			assert.isFalse(translate.called);
		}
		finally { await attachment.eraseTx(); if (parent) await parent.eraseTx(); }
	});

	it('saves complete preprint metadata while excluding provider identities and unsafe tag properties', async function () {
		let attachment = await importPDFAttachment();
		sandbox.stub(Zotero.PDFWorker, 'getRecognizerData').resolves({ pages: [[600, 800, ['text']]] });
		let record = { itemType: 'preprint', title: 'A fully described preprint',
			creators: [{ creatorType: 'author', firstName: 'Ada', lastName: 'Example' }],
			DOI: '10.48550/arxiv.2401.12345', date: '2024-01-14',
			abstractNote: 'Detailed abstract. '.repeat(300).trim(), language: 'en', rights: 'CC BY 4.0',
			archiveID: 'arXiv:2401.12345', repository: 'arXiv', url: 'https://arxiv.org/abs/2401.12345',
			libraryCatalog: 'DataCite', tags: [{ tag: 'Spectral Theory', type: 0, tagID: 999 },
				{ tag: 'Spectral Theory' }, { tag: '' }, { tag: 7 }, { tag: 'x'.repeat(256) }],
			key: 'UNTRUSTD', libraryID: 999, synced: true, collections: ['UNTRUSTD'],
			notes: [{ note: 'Untrusted note' }], attachments: [{ url: 'https://example.test/secret' }] };
		sandbox.stub(Zotero.HTTP, 'request').resolves({ status: 200, responseText: JSON.stringify({
			engine: 'epilib', version: 2, status: 'matched', item: record
		}) });
		let parent;
		try {
			parent = await recognizer._recognize(attachment);
			for (let field of ['title', 'DOI', 'abstractNote', 'date', 'language', 'rights',
				'archiveID', 'repository', 'url', 'libraryCatalog']) {
				assert.equal(parent.getField(field), record[field], field);
			}
			assert.deepEqual(parent.getTags(), [{ tag: 'Spectral Theory', type: 1 }]);
			assert.equal(parent.libraryID, attachment.libraryID);
			assert.notEqual(parent.key, record.key);
			assert.isFalse(parent.synced);
			assert.deepEqual(parent.getCollections(), []);
			assert.equal(parent.numAttachments(), 0);
			assert.equal(parent.numNotes(), 0);
		}
		finally { await attachment.eraseTx(); if (parent) await parent.eraseTx(); }
	});

	it('keeps the same metadata validation for reviewed candidates and enforces field limits', async function () {
		let item = { itemType: 'preprint', title: 'Candidate', creators: [],
			abstractNote: 'x'.repeat(20001), rights: 'x'.repeat(4001), language: 'en',
			institution: 'Invalid field for a preprint',
			tags: Array.from({ length: 150 }, (_, index) => ({ tag: 'Subject ' + index })) };
		sandbox.stub(Zotero.HTTP, 'request').resolves({ status: 200, responseText: JSON.stringify({
			engine: 'epilib', version: 2, status: 'needs_review', candidates: [{ item }]
		}) });
		let clean = (await recognizer.queryPDFMetadata(payload)).candidates[0].item;
		assert.isUndefined(clean.abstractNote);
		assert.isUndefined(clean.rights);
		assert.isUndefined(clean.institution);
		assert.equal(clean.language, 'en');
		assert.lengthOf(clean.tags, 100);
	});

	it('retains validated alternate arXiv identifiers and displays publication type and venue', async function () {
		let item = { itemType: 'conferencePaper', title: 'Label-Free Concept Bottleneck Models',
			creators: [{ name: 'Tuomas Oikarinen' }], date: '2023', proceedingsTitle: 'ICLR 2023',
			libraryCatalog: 'OpenReview', alternateIdentifiers: { arxiv: '2304.06129' }, extra: 'Untrusted provider text' };
		let http = sandbox.stub(Zotero.HTTP, 'request').resolves({ status: 200,
			responseText: JSON.stringify({ engine: 'epilib', version: 2, status: 'matched', item }) });
		let record = (await recognizer.queryPDFMetadata(payload)).item;
		assert.equal(record.extra, 'arXiv: 2304.06129');
		let prompt = sinon.stub().returns(2);
		let originalPrompt = Services.prompt;
		try {
			Services.prompt = { confirmEx: prompt };
			assert.isNull(recognizer.chooseRecognitionCandidate([{ item: record }]));
			assert.include(prompt.firstCall.args[2], 'Conference Paper');
			assert.include(prompt.firstCall.args[2], 'ICLR 2023');
		}
		finally { Services.prompt = originalPrompt; }
		item.alternateIdentifiers.arxiv = '2304.06129\nDOI: injected';
		http.resolves({ status: 200, responseText: JSON.stringify({ engine: 'epilib', version: 2, status: 'matched', item }) });
		assert.isUndefined((await recognizer.queryPDFMetadata(payload)).item.extra);
	});

	it('updates a confirmed published version in place without changing attachment, annotation or collection identity', async function () {
		let collection = await createDataObject('collection');
		let parent = await createDataObject('item', { itemType: 'preprint', title: 'A preprint',
			collections: [collection.id], tags: [{ tag: 'Personal tag' }] });
		parent.setField('archiveID', 'arXiv:2304.06129');
		parent.setField('DOI', '10.48550/arxiv.2304.06129');
		parent.setField('extra', 'User notes');
		await parent.saveTx();
		let attachment = await importPDFAttachment(parent);
		let annotation = await createAnnotation('highlight', attachment);
		let keys = [parent.key, attachment.key, annotation.key];
		let attachmentJSON = attachment.toJSON(), annotationJSON = annotation.toJSON();
		let record = { itemType: 'conferencePaper', title: 'Published title', creators: [{ creatorType: 'author', name: 'Example Author' }],
			date: '2023', proceedingsTitle: 'ICLR 2023', extra: 'arXiv: 2304.06129' };
		let request = sandbox.stub(recognizer, 'queryPDFMetadata').resolves({ engine: 'epilib', version: 2, status: 'matched', item: record });
		sandbox.stub(recognizer, 'chooseRecognitionCandidate').returns(record);
		try {
			assert.isTrue(await recognizer.refreshPublishedMetadata(parent));
			assert.deepEqual([parent.key, attachment.key, annotation.key], keys);
			assert.equal(parent.itemTypeID, Zotero.ItemTypes.getID('conferencePaper'));
			assert.equal(parent.getField('proceedingsTitle'), 'ICLR 2023');
			assert.equal(parent.getField('DOI'), '');
			assert.include(parent.getField('extra'), 'Preprint DOI: 10.48550/arxiv.2304.06129');
			assert.include(parent.getField('extra'), 'User notes');
			assert.deepEqual(parent.getCollections(), [collection.id]);
			assert.equal(parent.getTags()[0].tag, 'Personal tag');
			assert.deepEqual(attachment.toJSON(), attachmentJSON);
			assert.deepEqual(annotation.toJSON(), annotationJSON);
			assert.equal(attachment.parentID, parent.id);
			assert.equal(annotation.parentID, attachment.id);
			assert.deepEqual(request.firstCall.args[0].pages, []);
			assert.equal(request.firstCall.args[0].metadata.arxiv, '2304.06129');
		}
		finally { await parent.eraseTx(); await collection.eraseTx(); }
	});

	it('cancel, no publication, read-only libraries and concurrent edits never overwrite an existing preprint', async function () {
		let parent = await createDataObject('item', { itemType: 'preprint', title: 'Original title' });
		let before = parent.toJSON();
		let record = { itemType: 'conferencePaper', title: 'Published title', creators: [], proceedingsTitle: 'ICLR 2023' };
		let query = sandbox.stub(recognizer, 'queryPDFMetadata').resolves({ status: 'matched', item: record });
		let choose = sandbox.stub(recognizer, 'chooseRecognitionCandidate').returns(null);
		try {
			assert.isFalse(await recognizer.refreshPublishedMetadata(parent));
			assert.deepEqual(parent.toJSON(), before);
			query.resolves({ status: 'no_match' });
			assert.include((await getPromiseError(recognizer.refreshPublishedMetadata(parent))).message, 'No verified');
			assert.deepEqual(parent.toJSON(), before);
			let editable = sandbox.stub(parent, 'isEditable').returns(false);
			assert.isFalse(recognizer.canRefreshPublishedMetadata(parent));
			assert.include((await getPromiseError(recognizer.refreshPublishedMetadata(parent))).message, 'editable preprint');
			editable.restore();
			query.callsFake(async () => {
				parent.setField('title', 'Concurrent user edit');
				await parent.saveTx();
				return { status: 'matched', item: record };
			});
			choose.returns(record);
			assert.include((await getPromiseError(recognizer.refreshPublishedMetadata(parent))).message, 'item changed');
			assert.equal(parent.getField('title'), 'Concurrent user edit');
			assert.equal(parent.itemTypeID, Zotero.ItemTypes.getID('preprint'));
		}
		finally { await parent.eraseTx(); }
	});

	it('shows the published-version action only for an editable preprint with EpiLib enabled', async function () {
		let win = await loadZoteroPane();
		let parent = await createDataObject('item', { itemType: 'preprint', title: 'Refresh test' });
		try {
			await win.ZoteroPane.selectItem(parent.id);
			await win.ZoteroPane.buildItemContextMenu();
			let menu = win.document.querySelector('.zotero-menuitem-refresh-publication');
			assert.isFalse(menu.hidden);
			assert.equal(menu.label, 'Update to Published Version...');
			Zotero.Prefs.set('recognize.engine', 'zotero');
			await win.ZoteroPane.buildItemContextMenu();
			assert.isTrue(menu.hidden);
		}
		finally { await parent.eraseTx(); win.close(); }
	});

	it('respects the automatic-tag preference without discarding other descriptive metadata', async function () {
		Zotero.Prefs.set('automaticTags', false);
		let attachment = await importPDFAttachment();
		sandbox.stub(Zotero.PDFWorker, 'getRecognizerData').resolves({ pages: [[600, 800, ['text']]] });
		sandbox.stub(Zotero.HTTP, 'request').resolves({ status: 200, responseText: JSON.stringify({
			engine: 'epilib', version: 2, status: 'matched', item: { itemType: 'preprint',
				title: 'Preprint', creators: [], abstractNote: 'Complete abstract.', tags: [{ tag: 'Physics', type: 1 }] }
		}) });
		let parent;
		try {
			parent = await recognizer._recognize(attachment);
			assert.deepEqual(parent.getTags(), []);
			assert.equal(parent.getField('abstractNote'), 'Complete abstract.');
		}
		finally { await attachment.eraseTx(); if (parent) await parent.eraseTx(); }
	});

	it('does not create a parent when the user cancels ambiguous-match review', async function () {
		let attachment = await importPDFAttachment();
		sandbox.stub(Zotero.PDFWorker, 'getRecognizerData').resolves({ pages: [[600, 800, ['text']]] });
		sandbox.stub(Zotero.HTTP, 'request').resolves({ status: 200, responseText: JSON.stringify({ engine: 'epilib', version: 2,
			status: 'needs_review', candidates: [{ item: { itemType: 'journalArticle', title: 'Candidate', creators: [] } }] }) });
		let choose = sandbox.stub(recognizer, 'chooseRecognitionCandidate').returns(null);
		try { assert.isNull(await recognizer._recognize(attachment)); assert.isTrue(choose.calledOnce); }
		finally { await attachment.eraseTx(); }
	});

	it('restricts GROBID to loopback and validates bounded TEI without external entities', function () {
		assert.equal(recognizer.getLocalGROBIDURL(), 'http://127.0.0.1:8070/');
		for (let url of ['http://example.test/', 'http://127.0.0.1.example.test/', 'file:///tmp/',
			'http://user:password@127.0.0.1/', 'http://127.0.0.1/?secret=x']) assert.throws(() => recognizer.getLocalGROBIDURL(url));
		let hints = recognizer.parseGROBIDHeader('<TEI xmlns="http://www.tei-c.org/ns/1.0"><teiHeader><fileDesc><sourceDesc><biblStruct><analytic>'
			+ '<title>A paper title</title><author><persName><forename>Ada</forename><surname>Example</surname></persName></author><idno type="DOI">10.1234/test</idno>'
			+ '</analytic></biblStruct></sourceDesc></fileDesc></teiHeader></TEI>');
		assert.equal(hints.hints.title, 'A paper title');
		assert.equal(hints.metadata.DOI, '10.1234/test');
		assert.equal(hints.hints.author, 'Ada Example');
		for (let xml of ['<!DOCTYPE TEI><TEI/>', '<bad>', 'x'.repeat(1024 * 1024 + 1)]) assert.throws(() => recognizer.parseGROBIDHeader(xml));
	});

	it('uses local GROBID only after no match, with no credentials and consolidation disabled', async function () {
		Zotero.Prefs.set('recognize.grobid.enabled', true);
		let attachment = await importPDFAttachment();
		sandbox.stub(Zotero.PDFWorker, 'getRecognizerData').resolves({ pages: [[600, 800, ['text']]] });
		let http = sandbox.stub(Zotero.HTTP, 'request');
		http.onCall(0).resolves({ status: 200, responseText: '{"engine":"epilib","version":2,"status":"no_match"}' });
		http.onCall(1).resolves({ status: 200, responseText: '<TEI xmlns="http://www.tei-c.org/ns/1.0"><teiHeader><fileDesc><titleStmt><title>A paper title</title></titleStmt></fileDesc></teiHeader></TEI>' });
		http.onCall(2).resolves({ status: 200, responseText: '{"engine":"epilib","version":2,"status":"no_match"}' });
		try {
			assert.isNull(await recognizer._recognize(attachment));
			assert.equal(http.callCount, 3);
			let [method, url, options] = http.secondCall.args;
			assert.equal(method, 'POST');
			assert.equal(url, 'http://127.0.0.1:8070/api/processHeaderDocument');
			assert.equal(options.body.get('consolidateHeader'), '0');
			assert.equal(options.body.get('input').name, 'document.pdf');
			assert.isUndefined(options.headers['Zotero-API-Key']);
			assert.isTrue(options.anon);
			assert.isFalse(options.followRedirects);
			assert.equal(options.timeout, 60000);
			assert.deepEqual(JSON.parse(http.thirdCall.args[2].body).pages, []);
		}
		finally { await attachment.eraseTx(); }
	});

	it('keeps local fallback off by default and exposes labelled settings only when enabled', async function () {
		let http = sandbox.stub(Zotero.HTTP, 'request');
		preferences = await loadPrefPane('general');
		let doc = preferences.document;
		await doc.l10n.translateFragment(doc.getElementById('pdf-recognition-group'));
		assert.isTrue(doc.getElementById('pdf-recognition-grobid-settings').hidden);
		assert.equal(doc.getElementById('pdf-recognition-grobid-settings').getBoundingClientRect().height, 0);
		let checkbox = doc.getElementById('pdf-recognition-grobid');
		assert.equal(checkbox.label, 'Use local GROBID when EpiLib finds no match');
		checkbox.checked = true;
		checkbox.dispatchEvent(new preferences.Event('command', { bubbles: true }));
		assert.isTrue(Zotero.Prefs.get('recognize.grobid.enabled'));
		assert.isFalse(doc.getElementById('pdf-recognition-grobid-settings').hidden);
		assert.equal(doc.querySelector('[for="pdf-recognition-grobid-url"]').textContent, 'Local GROBID URL:');
		let labelBounds = doc.querySelector('[for="pdf-recognition-grobid-url"]').getBoundingClientRect();
		let inputBounds = doc.getElementById('pdf-recognition-grobid-url').getBoundingClientRect();
		assert.isAbove(labelBounds.width, 0);
		assert.isAbove(inputBounds.width, 100);
		assert.isAtMost(labelBounds.right, inputBounds.left);
		assert.isFalse(http.called);
	});

	it('verifies the v2 worker and local GROBID without uploading files', async function () {
		let http = sandbox.stub(Zotero.HTTP, 'request');
		http.onCall(0).resolves({ status: 200, responseText: '{"engine":"epilib","version":2,"protocol":"epilib-recognition-v2"}' });
		http.onCall(1).resolves({ status: 200, responseText: 'true' });
		await recognizer.verifyRecognitionServer();
		await recognizer.verifyLocalGROBID();
		assert.equal(http.secondCall.args[0], 'GET');
		assert.equal(http.secondCall.args[1], 'http://127.0.0.1:8070/api/isalive');
		assert.isUndefined(http.secondCall.args[2].body);
		assert.isUndefined(http.secondCall.args[2].headers);
	});

	it('discards stale local verification without leaving the other verify button disabled', async function () {
		preferences = await loadPrefPane('general');
		let resolveEngine, resolveLocal;
		sandbox.stub(recognizer, 'verifyRecognitionServer').returns(new Promise(resolve => { resolveEngine = resolve; }));
		sandbox.stub(recognizer, 'verifyLocalGROBID').returns(new Promise(resolve => { resolveLocal = resolve; }));
		let controller = preferences.Zotero_Preferences.General;
		let enginePending = controller.verifyRecognitionServer();
		let localPending = controller.verifyLocalGROBID();
		resolveEngine();
		await enginePending;
		assert.isFalse(preferences.document.getElementById('pdf-recognition-verify').disabled);
		controller._updateRecognitionUI();
		resolveLocal();
		await localPending;
		assert.equal(preferences.document.getElementById('pdf-recognition-grobid-status').textContent, '');
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
