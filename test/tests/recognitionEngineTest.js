/* global describe, beforeEach, afterEach, it, assert, sinon, getPromiseError,
	loadPrefPane, importPDFAttachment, createDataObject, createAnnotation, loadZoteroPane, waitForWindow, waitForDOMEvent */
"use strict";

describe('PDF recognition engines', function () {
	let sandbox, saved, preferences;
	let recognizer = Zotero.RecognizeDocument;
	let prefs = ['recognize.engine', 'recognize.url', 'recognize.epilib.url', 'sync.metadata.postgresql.url',
		'recognize.grobid.enabled', 'recognize.grobid.url', 'automaticTags'];
	const server = 'https://metadata.example.test/api/';
	const payload = { metadata: {}, totalPages: 1, pages: [[600, 800, []]], fileName: 'test.pdf' };

	/** Invoke the actual XUL handler; chrome ignores untrusted synthetic commands. */
	function invokeItemCommand(win, selector) {
		let command = win.document.querySelector(selector);
		assert.isFunction(command.oncommand);
		command.oncommand();
	}

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

	it('preserves a repository thesis ISBN without accepting arbitrary Extra text', async function () {
		let attachment = await importPDFAttachment();
		sandbox.stub(Zotero.PDFWorker, 'getRecognizerData').resolves({ pages: [[600, 800, ['text']]] });
		sandbox.stub(Zotero.HTTP, 'request').resolves({ status: 200, responseText: JSON.stringify({
			engine: 'epilib', version: 2, status: 'matched', item: { itemType: 'thesis',
				title: 'Repository thesis', creators: [{ name: 'Ada Example' }], ISBN: '9162845462',
				university: 'Lund University', thesisType: 'Doctoral thesis', extra: 'Do not import this text' }
		}) });
		let parent;
		try {
			parent = await recognizer._recognize(attachment);
			assert.equal(parent.getField('ISBN'), '91-628-4546-2');
			assert.equal(parent.getField('extra'), '');
			assert.equal(parent.getField('thesisType'), 'Doctoral thesis');
			assert.equal(parent.getField('university'), 'Lund University');
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

	it('saves conference fields and generates stable distinct local citation keys, never provider ids', async function () {
		let attachment = await importPDFAttachment();
		let parents = [];
		sandbox.stub(Zotero.PDFWorker, 'getRecognizerData').resolves({ pages: [[600, 800, ['text']]] });
		let record = { itemType: 'conferencePaper', title: 'Language in a Bottle',
			creators: [{ creatorType: 'author', firstName: 'Yue', lastName: 'Yang' }],
			DOI: '10.1109/cvpr52729.2023.01839', date: '2023-6', proceedingsTitle: 'CVPR 2023',
			conferenceName: 'IEEE/CVF Conference on Computer Vision and Pattern Recognition',
			eventPlace: 'Vancouver, BC, Canada', pages: '19187-19197', publisher: 'IEEE',
			citationKey: 'untrusted-provider-id' };
		sandbox.stub(Zotero.HTTP, 'request').resolves({ status: 200, responseText: JSON.stringify({
			engine: 'epilib', version: 2, status: 'matched', item: record
		}) });
		try {
			for (let i = 0; i < 2; i++) {
				let parent = await recognizer._recognize(attachment);
				parents.push(parent);
				for (let field of ['conferenceName', 'eventPlace', 'proceedingsTitle', 'pages']) {
					assert.equal(parent.getField(field), record[field]);
				}
				assert.equal(parent.getField('citationKey'), `yang2023LanguageBottle-${parent.key}`);
			}
			assert.notEqual(parents[0].getField('citationKey'), parents[1].getField('citationKey'));
		}
		finally {
			await attachment.eraseTx();
			for (let parent of parents) await parent.eraseTx();
		}
	});

	it('fills chapter authors and missing fields in place while preserving user metadata and citation keys', async function () {
		let parent = await createDataObject('item', { itemType: 'bookSection', title: 'A mathematical guide to operator learning' });
		parent.setField('DOI', '10.1016/bs.hna.2024.05.003');
		parent.setField('bookTitle', 'User-edited book title');
		parent.setField('citationKey', 'my-existing-key');
		parent.setField('date', '2024');
		await parent.saveTx();
		let attachment = await importPDFAttachment(parent);
		let original = attachment.toJSON(), key = parent.key;
		let record = { itemType: 'bookSection', title: parent.getField('title'), DOI: parent.getField('DOI'),
			creators: [{ creatorType: 'author', name: 'Nicolas Boull\u00e9' }, { creatorType: 'author', name: 'Alex Townsend' }],
			bookTitle: 'Numerical Analysis Meets Machine Learning', series: 'Handbook of Numerical Analysis',
			pages: '83-125', date: '2023', ISBN: '9780443239847' };
		let request = sandbox.stub(Zotero.HTTP, 'request').resolves({ status: 200, responseText: JSON.stringify({
			engine: 'epilib', version: 2, status: 'matched', item: record
		}) });
		sandbox.stub(recognizer, 'chooseRecognitionCandidate').callsFake(candidates => candidates[0].item);
		try {
			assert.isTrue(await recognizer.refreshMetadata(parent));
			assert.equal(parent.key, key);
			assert.equal(parent.getCreators()[0].lastName, 'Nicolas Boull\u00e9');
			assert.equal(parent.getCreators()[1].lastName, 'Alex Townsend');
			assert.equal(parent.getField('series'), record.series);
			assert.equal(parent.getField('pages'), record.pages);
			assert.equal(parent.getField('bookTitle'), 'User-edited book title');
			assert.equal(parent.getField('citationKey'), 'my-existing-key');
			assert.equal(parent.getField('date'), '2024');
			assert.deepEqual(attachment.toJSON(), original);
			assert.equal(JSON.parse(request.firstCall.args[2].body).metadata.DOI, record.DOI);
			parent.setField('citationKey', '');
			await parent.saveTx();
			await recognizer.refreshMetadata(parent);
			let generated = parent.getField('citationKey');
			assert.match(generated, /^boulle2024mathematicalguideoperator-/);
			await recognizer.refreshMetadata(parent);
			assert.equal(parent.getField('citationKey'), generated);
		}
		finally { await parent.eraseTx(); }
	});

	it('refresh cannot downgrade a publication or substitute another DOI, and cancellation changes nothing', async function () {
		let parent = await createDataObject('item', { itemType: 'conferencePaper', title: 'Existing publication' });
		parent.setField('DOI', '10.1234/published');
		await parent.saveTx();
		let before = parent.toJSON();
		let record = { itemType: 'conferencePaper', title: 'Existing publication', creators: [], DOI: '10.1234/other' };
		let query = sandbox.stub(recognizer, 'queryPDFMetadata').resolves({ status: 'matched', item: record });
		let choice = sandbox.stub(recognizer, 'chooseRecognitionCandidate').returns(null);
		try {
			assert.include((await getPromiseError(recognizer.refreshMetadata(parent))).message, 'No verified');
			query.resolves({ status: 'matched', item: { ...record, itemType: 'preprint', DOI: '10.1234/published' } });
			assert.include((await getPromiseError(recognizer.refreshMetadata(parent))).message, 'No verified');
			assert.isFalse(choice.called);
			query.resolves({ status: 'matched', item: { ...record, DOI: '10.1234/published' } });
			assert.isFalse(await recognizer.refreshMetadata(parent));
			assert.deepEqual(parent.toJSON(), before);
		}
		finally { await parent.eraseTx(); }
	});

	it('retains unconfigured catalog status without accepting unknown provider states', async function () {
		let item = { itemType: 'book', title: 'A source', creators: [] };
		let review = { sources: [{ id: 'source-1', label: 'Open Library', item, mergeFields: [] }],
			custom: { item, fieldSources: {} }, providers: [
				{ name: 'Google Books', status: 'not_configured' }, { name: 'Injected', status: 'unknown' }
			] };
		sandbox.stub(Zotero.HTTP, 'request').resolves({ status: 200,
			responseText: JSON.stringify({ engine: 'epilib', version: 2, status: 'matched', item, review }) });
		let result = await recognizer.queryPDFMetadata(payload);
		assert.deepEqual(result.review.providers, [{ name: 'Google Books', status: 'not_configured' }]);
	});

	it('validates every comparison source and strips identity-changing Custom field controls', async function () {
		let item = { itemType: 'conferencePaper', title: 'A source', creators: [], DOI: '10.1234/source',
			pages: '1-12', libraryID: 999, key: 'UNTRUSTD' };
		let review = { sources: [{ id: 'source-1', label: 'Crossref', item,
			mergeFields: ['pages', 'DOI', 'itemType', 'libraryID', 'key', '__proto__'] }],
			custom: { item, fieldSources: { pages: 'source-1', title: 'missing-source', libraryID: 'source-1' } },
			providers: [{ name: 'Crossref', status: 'matched' }, { name: 'bad', status: 'invented' }] };
		let http = sandbox.stub(Zotero.HTTP, 'request').callsFake(async () => ({ status: 200,
			responseText: JSON.stringify({ engine: 'epilib', version: 2, status: 'matched', item, review }) }));
		let result = await recognizer.queryPDFMetadata(payload);
		assert.deepEqual(result.review.sources[0].mergeFields, ['pages']);
		assert.isUndefined(result.review.sources[0].item.key);
		assert.isUndefined(result.review.custom.item.libraryID);
		assert.deepEqual(result.review.custom.fieldSources, { pages: 'source-1' });
		assert.lengthOf(result.review.providers, 1);
		review.sources.push(review.sources[0]);
		assert.include((await getPromiseError(recognizer.queryPDFMetadata(payload))).message, 'supported PDF recognition response');
		review.sources.pop(); review.sources[0].id = 'custom';
		assert.include((await getPromiseError(recognizer.queryPDFMetadata(payload))).message, 'supported PDF recognition response');
		assert.isTrue(http.called);
	});

	it('replaces existing bibliographic values only after explicit selection while keeping citation and item identity', async function () {
		let parent = await createDataObject('item', { itemType: 'conferencePaper', title: 'Existing title' });
		parent.setField('DOI', '10.1234/paper');
		parent.setField('citationKey', 'UserCitationKey');
		await parent.saveTx();
		let key = parent.key;
		let record = { itemType: 'conferencePaper', title: 'Selected source title', creators: [],
			DOI: '10.1234/paper', pages: '1-12' };
		let query = sandbox.stub(recognizer, 'queryPDFMetadata').resolves({ status: 'matched', item: record });
		sandbox.stub(recognizer, 'chooseRecognitionCandidate').callsFake((candidates, options) => {
			assert.isTrue(options.refresh);
			options.replaceExisting = true;
			return record;
		});
		try {
			await recognizer.refreshMetadata(parent);
			assert.isTrue(query.firstCall.args[0].includeAlternatives);
			assert.equal(parent.getField('title'), record.title);
			assert.equal(parent.getField('citationKey'), 'UserCitationKey');
			assert.equal(parent.key, key);
		}
		finally { await parent.eraseTx(); }
	});

	it('retains validated alternate arXiv identifiers and displays publication type and venue', async function () {
		let item = { itemType: 'conferencePaper', title: 'Label-Free Concept Bottleneck Models',
			creators: [{ name: 'Tuomas Oikarinen' }], date: '2023', proceedingsTitle: 'ICLR 2023',
			libraryCatalog: 'OpenReview', alternateIdentifiers: { arxiv: '2304.06129' }, extra: 'Untrusted provider text' };
		let http = sandbox.stub(Zotero.HTTP, 'request').resolves({ status: 200,
			responseText: JSON.stringify({ engine: 'epilib', version: 2, status: 'matched', item }) });
		let record = (await recognizer.queryPDFMetadata(payload)).item;
		assert.equal(record.extra, 'arXiv: 2304.06129');
		let opened = waitForWindow('chrome://zotero/content/recognitionReview.xhtml', dialog => {
			try {
				assert.include(dialog.document.getElementById('recognition-review-summary').textContent, 'Conference Paper');
				assert.include(dialog.document.getElementById('recognition-review-fields').textContent, 'ICLR 2023');
			}
			finally { dialog.close(); }
		});
		assert.isNull(recognizer.chooseRecognitionCandidate([{ item: record }]));
		await opened;
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

	it('keeps the Neuro-Symbolic paper title and collection when publication refresh produces a sync patch', async function () {
		const title = 'Neuro-Symbolic AI for Analytical Solutions of Differential Equations';
		let collection = await createDataObject('collection');
		let parent = await createDataObject('item', { itemType: 'preprint', title,
			version: 1, collections: [collection.id], tags: [{ tag: 'Personal tag' }] });
		parent.setField('archiveID', '2502.01476');
		parent.setField('DOI', '10.48550/arXiv.2502.01476');
		parent.setField('abstractNote', 'Preserve the original abstract');
		parent.setField('citationKey', 'Oikonomou2025NeuroSymbolic');
		await parent.saveTx();
		let original = parent.toJSON();
		await Zotero.Sync.Data.Local.saveCacheObjects('item', parent.libraryID, [original]);
		let record = { itemType: 'conferencePaper', title,
			creators: [{ creatorType: 'author', name: 'Orestis Oikonomou' }],
			date: '2026', proceedingsTitle: 'ICML 2026 regular',
			url: 'https://openreview.net/forum?id=acvRKe2uMW' };
		sandbox.stub(recognizer, 'queryPDFMetadata').resolves({ status: 'matched', item: record });
		sandbox.stub(recognizer, 'chooseRecognitionCandidate').returns(record);
		try {
			assert.isTrue(await recognizer.refreshPublishedMetadata(parent));
			await parent.reload(null, true);
			assert.equal(parent.getField('title'), title);
			assert.deepEqual(parent.getCollections(), [collection.id]);
			let engine = new Zotero.Sync.Data.Engine({ apiClient: {}, libraryID: parent.libraryID });
			let patch = await engine._getJSONForObject('item', parent.id);
			assert.equal(patch.itemType, 'conferencePaper');
			// This is the legitimate wire format that previously triggered data loss:
			// a changed type does not make unchanged title/collections part of the patch.
			for (let field of ['title', 'collections', 'citationKey', 'abstractNote', 'tags']) {
				assert.notProperty(patch, field);
			}
			assert.equal(patch.archiveID, '', 'Removed preprint-only fields are explicit clears');
			assert.equal(patch.DOI, '');
			assert.equal(parent.getField('citationKey'), original.citationKey);
			assert.equal(parent.getField('abstractNote'), original.abstractNote);
			assert.deepEqual(parent.getCollections(), [collection.id]);
			assert.deepEqual(parent.getTags(), original.tags);
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
			assert.include((await getPromiseError(recognizer.refreshPublishedMetadata(parent))).message, 'editable bibliographic item');
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

	it('keeps refresh and publication upgrade as separate context-menu commands', async function () {
		let win = await loadZoteroPane();
		let parent = await createDataObject('item', { itemType: 'preprint', title: 'Refresh test' });
		try {
			await win.ZoteroPane.selectItem(parent.id);
			await win.ZoteroPane.buildItemContextMenu();
			let upgrade = win.document.querySelector('.zotero-menuitem-refresh-publication');
			let refresh = win.document.querySelector('.zotero-menuitem-refresh-metadata');
			assert.isNotNull(refresh, 'Refresh must not be replaced by the publication command');
			assert.isFalse(refresh.hidden);
			assert.equal(refresh.label, 'Refresh Metadata...');
			assert.isFalse(upgrade.hidden);
			assert.equal(upgrade.label, 'Update to Published Version...');
			// Check the compiled theme and packaged assets, not just menu classes:
			// native and in-content menus use separate icon CSS properties.
			let popup = win.document.getElementById('zotero-itemmenu');
			let shown = waitForDOMEvent(popup, 'popupshown');
			popup.openPopup(win.document.getElementById('zotero-items-tree'), 'after_start', 0, 0, true);
			await shown; // Gecko resolves popup styles lazily, only once the menu opens.
			try {
				let referenceStyle = win.getComputedStyle(win.document.querySelector('.zotero-menuitem-duplicate-item'));
				for (let [command, icon] of [[refresh, 'refresh'], [upgrade, 'retrieve-metadata']]) {
					let url = `chrome://zotero/skin/16/universal/${icon}.svg`;
					let style = win.getComputedStyle(command);
					assert.include(style.getPropertyValue('--menuitem-icon'), url);
					if (referenceStyle.listStyleImage != 'none') assert.include(style.listStyleImage, url);
					assert.equal(style.fill, referenceStyle.fill, 'Use the standard theme-aware menu color');
					let image = new win.Image();
					image.src = url;
					await image.decode();
					assert.equal(image.naturalWidth, 16);
					assert.equal(image.naturalHeight, 16);
				}
			}
			finally { popup.hidePopup(); }
			let refreshCall = sandbox.stub(recognizer, 'refreshMetadata').resolves(true);
			let upgradeCall = sandbox.stub(recognizer, 'refreshPublishedMetadata').resolves(true);
			invokeItemCommand(win, '.zotero-menuitem-refresh-metadata');
			assert.equal(refreshCall.callCount, 1, 'Refresh menu must invoke refresh');
			assert.equal(refreshCall.firstCall.args[0].id, parent.id);
			assert.isFalse(upgradeCall.called);
			invokeItemCommand(win, '.zotero-menuitem-refresh-publication');
			assert.equal(upgradeCall.callCount, 1, 'Publication menu must invoke upgrade');
			assert.equal(upgradeCall.firstCall.args[0].id, parent.id);
			assert.isTrue(refreshCall.calledOnce);

			// DOI-less publications, including upgraded OpenReview records, must
			// retain refresh. Upgrading is meaningful only while still a preprint.
			parent.setType(Zotero.ItemTypes.getID('conferencePaper'));
			await parent.saveTx();
			await win.ZoteroPane.buildItemContextMenu();
			assert.isFalse(refresh.hidden);
			assert.isTrue(upgrade.hidden);
			parent.setType(Zotero.ItemTypes.getID('bookSection'));
			parent.setField('DOI', '10.1016/bs.hna.2024.05.003');
			await parent.saveTx();
			await win.ZoteroPane.buildItemContextMenu();
			assert.isFalse(refresh.hidden);
			assert.isTrue(upgrade.hidden);
			Zotero.Prefs.set('recognize.engine', 'zotero');
			await win.ZoteroPane.buildItemContextMenu();
			assert.isTrue(refresh.hidden);
			assert.isTrue(upgrade.hidden);
		}
		finally { await parent.eraseTx(); win.close(); }
	});

	it('hides both metadata commands for noneditable, deleted, attachment and multiple selections', async function () {
		let win = await loadZoteroPane();
		let parent = await createDataObject('item', { itemType: 'preprint', title: 'Refresh restrictions' });
		let pdf = await importPDFAttachment(parent);
		try {
			await win.ZoteroPane.selectItem(parent.id);
			let editable = sandbox.stub(parent, 'isEditable').returns(false);
			await win.ZoteroPane.buildItemContextMenu();
			let upgrade = win.document.querySelector('.zotero-menuitem-refresh-publication');
			let refresh = win.document.querySelector('.zotero-menuitem-refresh-metadata');
			assert.isTrue(refresh.hidden);
			assert.isTrue(upgrade.hidden);
			editable.restore();
			parent.deleted = true;
			await parent.saveTx();
			assert.isFalse(recognizer.canRefreshMetadata(parent));
			assert.isFalse(recognizer.canRefreshPublishedMetadata(parent));
			parent.deleted = false;
			await parent.saveTx();
			await win.ZoteroPane.selectItem(pdf.id);
			await win.ZoteroPane.buildItemContextMenu();
			assert.isTrue(refresh.hidden);
			assert.isTrue(upgrade.hidden);
			await win.ZoteroPane.selectItems([parent.id, pdf.id]);
			await win.ZoteroPane.buildItemContextMenu();
			assert.isTrue(refresh.hidden);
			assert.isTrue(upgrade.hidden);
		}
		finally { await parent.eraseTx(); win.close(); }
	});

	it('refreshes a preprint without upgrading it even when the preferred recognition result is published', async function () {
		let parent = await createDataObject('item', { itemType: 'preprint', title: 'Keep this preprint title' });
		parent.setField('archiveID', '2502.01476');
		await parent.saveTx();
		let source = { itemType: 'preprint', title: 'Catalog title', creators: [], abstractNote: 'New abstract' };
		let published = { itemType: 'conferencePaper', title: source.title, creators: [], proceedingsTitle: 'Conference' };
		let query = sandbox.stub(recognizer, 'queryPDFMetadata').resolves({ status: 'matched', item: published,
			review: { sources: [{ id: 'preprint', label: 'arXiv', item: source, mergeFields: [] }],
				custom: { item: published, fieldSources: {} }, providers: [] } });
		sandbox.stub(recognizer, 'chooseRecognitionCandidate').callsFake((candidates, options) => {
			assert.deepEqual(options.allowedTypes, ['preprint']);
			assert.isTrue(candidates.every(candidate => candidate.item.itemType == 'preprint'));
			return source;
		});
		try {
			assert.isTrue(await recognizer.refreshMetadata(parent));
			await parent.reload(null, true);
			assert.equal(parent.itemTypeID, Zotero.ItemTypes.getID('preprint'));
			assert.equal(parent.getField('title'), 'Keep this preprint title');
			assert.equal(parent.getField('abstractNote'), 'New abstract');
			assert.equal(parent.getField('archiveID'), '2502.01476');
			assert.equal(query.firstCall.args[0].metadata.arxiv, '2502.01476');
		}
		finally { await parent.eraseTx(); }
	});

	it('runs DOI-less refresh from the native menu through review and SQLite without moving the PDF', async function () {
		let win = await loadZoteroPane();
		let collection = await createDataObject('collection');
		let parent = await createDataObject('item', { itemType: 'conferencePaper', title: 'A paper without a DOI',
			collections: [collection.id], tags: [{ tag: 'Personal tag' }] });
		parent.setField('citationKey', 'KeepMyKey');
		await parent.saveTx();
		let pdf = await importPDFAttachment(parent);
		let original = parent.toJSON(), originalPDF = pdf.toJSON();
		let record = { itemType: 'conferencePaper', title: 'Provider title', creators: [], pages: '1-12' };
		let query = sandbox.stub(recognizer, 'queryPDFMetadata').resolves({ status: 'matched', item: record });
		let refreshCall = sandbox.spy(recognizer, 'refreshMetadata');
		try {
			await win.ZoteroPane.selectItem(parent.id);
			await win.ZoteroPane.buildItemContextMenu();
			// Only the catalog result is stubbed. This opens the actual native review
			// dialog, accepts its default fill-blanks behavior, then reloads SQLite.
			let opened = waitForWindow('chrome://zotero/content/recognitionReview.xhtml', dialog => {
				try {
					assert.isFalse(dialog.document.getElementById('recognition-review-replace').checked);
					dialog.document.getElementById('recognition-review-dialog').acceptDialog();
				}
				finally { if (!dialog.closed) dialog.close(); }
			});
			invokeItemCommand(win, '.zotero-menuitem-refresh-metadata');
			assert.isTrue(refreshCall.calledOnce);
			assert.isTrue(await refreshCall.firstCall.returnValue);
			await opened;
			await parent.reload(null, true);
			await pdf.reload(null, true);
			assert.equal(query.firstCall.args[0].metadata.Title, original.title);
			assert.equal(parent.key, original.key);
			assert.equal(parent.getField('title'), original.title);
			assert.equal(parent.getField('pages'), '1-12');
			assert.equal(parent.getField('citationKey'), 'KeepMyKey');
			assert.deepEqual(parent.getCollections(), [collection.id]);
			assert.deepEqual(parent.getTags(), original.tags);
			assert.deepEqual(pdf.toJSON(), originalPDF);
		}
		finally { await parent.eraseTx(); await collection.eraseTx(); win.close(); }
	});

	it('refreshes books by ISBN and rejects cancellation, type changes and concurrent edits without overwriting data', async function () {
		let parent = await createDataObject('item', { itemType: 'book', title: 'A book without a DOI' });
		parent.setField('ISBN', '9780262046305');
		await parent.saveTx();
		let before = parent.toJSON();
		let record = { itemType: 'book', title: before.title, creators: [], ISBN: before.ISBN, publisher: 'Publisher' };
		let query = sandbox.stub(recognizer, 'queryPDFMetadata').resolves({ status: 'matched', item: record });
		let choose = sandbox.stub(recognizer, 'chooseRecognitionCandidate').returns(null);
		try {
			assert.isTrue(recognizer.canRefreshMetadata(parent));
			assert.isFalse(recognizer.canRefreshPublishedMetadata(parent));
			assert.isFalse(await recognizer.refreshMetadata(parent));
			assert.equal(query.firstCall.args[0].metadata.ISBN, before.ISBN);
			assert.deepEqual(parent.toJSON(), before);
			choose.returns({ ...record, itemType: 'preprint' });
			assert.include((await getPromiseError(recognizer.refreshMetadata(parent))).message, 'No verified');
			assert.deepEqual(parent.toJSON(), before);
			choose.returns(record);
			assert.isTrue(await recognizer.refreshMetadata(parent));
			assert.equal(parent.getField('publisher'), 'Publisher');
			query.callsFake(async () => {
				parent.setField('title', 'Concurrent user edit');
				await parent.saveTx();
				return { status: 'matched', item: record };
			});
			assert.include((await getPromiseError(recognizer.refreshMetadata(parent))).message, 'item changed');
			assert.equal(parent.getField('title'), 'Concurrent user edit');
		}
		finally { await parent.eraseTx(); }
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
