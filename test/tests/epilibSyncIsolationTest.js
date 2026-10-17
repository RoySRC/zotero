/* global describe, beforeEach, afterEach, it, assert, sinon, createGroup, loadPrefPane,
	getPromiseError, importPDFAttachment */
"use strict";

describe("EpiLib sync isolation", function () {
	let sandbox, preferences;
	const serverURL = 'http://localhost:23129/';
	const prefs = [
		'sync.metadata.backend',
		'sync.metadata.postgresql.url',
		'sync.storage.protocol',
		'sync.storage.enabled',
		'sync.storage.groups.enabled',
		'sync.storage.webdavProfiles',
		'sync.storage.libraryProfiles',
		'streaming.enabled',
		'automaticScraperUpdates',
		'sync.autoSync'
	];
	let saved;

	beforeEach(function () {
		saved = prefs.map(name => [name, Zotero.Prefs.get(name)]);
		sandbox = sinon.createSandbox();
		Zotero.Prefs.set('sync.metadata.postgresql.url', serverURL);
		Zotero.Prefs.set('sync.storage.libraryProfiles', '{}');
	});

	afterEach(function () {
		preferences?.close();
		preferences = null;
		sandbox.restore();
		for (let [name, value] of saved) {
			if (value === undefined) {
				Zotero.Prefs.clear(name);
			}
			else {
				Zotero.Prefs.set(name, value);
			}
		}
	});

	it("ignores a legacy Zotero backend without changing library versions", async function () {
		let library = Zotero.Libraries.userLibrary;
		let version = library.libraryVersion;
		Zotero.Prefs.set('sync.metadata.backend', 'zotero');
		let legacyKey = sandbox.stub(Zotero.Sync.Data.Local, 'getAPIKey').rejects(new Error('Legacy key read'));
		let runner = new Zotero.Sync.Runner_Module();
		assert.equal(Zotero.Sync.Metadata.getBackend(), 'postgresql');
		let client = runner.getAPIClient({ apiKey: 'test-postgresql-token' });
		assert.equal(client.baseURL, serverURL);
		assert.equal(client.apiKey, 'test-postgresql-token');
		assert.isFalse(legacyKey.called);
		assert.equal(library.libraryVersion, version);
	});

	it("requires a self-hosted URL and rejects the legacy API bypass", function () {
		let runner = new Zotero.Sync.Runner_Module();
		Zotero.Prefs.set('sync.metadata.postgresql.url', '');
		assert.isFalse(runner.enabled);
		assert.throws(() => runner.getAPIClient(), 'URL not set');
		assert.throws(() => runner.getAPIClient({ metadataBackend: false }), 'not supported');
		for (let url of ['https://api.zotero.org/', 'https://www.zotero.org./api/', 'ftp://example.org/']) {
			assert.throws(() => Zotero.Sync.Metadata.normalizePostgreSQLBaseURL(url));
		}
	});

	it("rejects old login entry points without sending any HTTP request", async function () {
		let http = sandbox.stub(Zotero.HTTP, 'request').rejects(new Error('Unexpected HTTP request'));
		let runner = new Zotero.Sync.Runner_Module();
		assert.include((await getPromiseError(runner.startLoginSession())).message, 'not supported');
		assert.include((await getPromiseError(runner.createAPIKeyFromCredentials('old-user', 'old-password'))).message, 'not supported');
		assert.include((await getPromiseError(runner.checkLoginSession('old-session'))).message, 'not supported');
		await runner.cancelLoginSession('old-session');
		assert.isFalse(http.called);
	});

	it("authenticates against PostgreSQL and keeps logout local", async function () {
		let http = sandbox.stub(Zotero.HTTP, 'request').resolves({
			status: 200,
			responseText: JSON.stringify({ userID: 1, username: 'test-user', apiKey: 'test-token' })
		});
		let saveKey = sandbox.stub(Zotero.Sync.Metadata, 'setPostgreSQLAPIKey').resolves();
		let clearKey = sandbox.stub(Zotero.Sync.Metadata, 'clearPostgreSQLAPIKey').resolves();
		await Zotero.Sync.Metadata.loginPostgreSQL({ url: serverURL, username: 'test-user', password: 'test-password' });
		assert.equal(http.firstCall.args[1], serverURL + 'auth/login');
		assert.equal(saveKey.firstCall.args[0], 'test-token');
		await new Zotero.Sync.Runner_Module().deleteAPIKey();
		await Zotero.Sync.Metadata.disablePostgreSQL();
		assert.isTrue(clearKey.called);
		assert.equal(Zotero.Sync.Metadata.getBackend(), 'postgresql');
		assert.isTrue(http.calledOnce);
	});

	it("disables legacy file backends without rewriting existing assignments", async function () {
		let userID = Zotero.Libraries.userLibraryID;
		Zotero.Prefs.set('sync.storage.protocol', 'zotero');
		Zotero.Prefs.set('sync.storage.groups.enabled', true);
		assert.isNull(Zotero.Sync.Storage.Local.getModeForLibrary(userID));
		assert.isFalse(Zotero.Sync.Storage.Local.getEnabledForLibrary(userID));
		assert.throws(() => Zotero.Sync.Runner.getStorageController('zfs'), 'only WebDAV');
		assert.throws(() => new Zotero.Sync.Storage.Mode.ZFS({}), 'not supported');
		let group = await createGroup();
		try {
			assert.isNull(Zotero.Sync.Storage.Local.getModeForLibrary(group.libraryID));
			assert.isFalse(Zotero.Sync.Storage.Local.getEnabledForLibrary(group.libraryID));
			await Zotero.Sync.Storage.Profiles.setWebDAVProfile('isolation', { url: 'example.invalid/webdav' });
			await Zotero.Sync.Storage.Profiles.setLibraryProfile(group.libraryID, 'isolation');
			assert.equal(Zotero.Sync.Storage.Local.getModeForLibrary(group.libraryID), 'webdav');
		}
		finally {
			await group.eraseTx({ skipDeleteLog: true });
		}
	});

	it("does not re-enable Zotero Storage when loading server account settings", async function () {
		await Zotero.Sync.Storage.Profiles.applySyncSettingsBundle({
			fileStorage: { global: { protocol: 'zotero', groupsEnabled: true } }
		});
		assert.equal(Zotero.Prefs.get('sync.storage.protocol'), 'none');
		assert.isFalse(Zotero.Prefs.get('sync.storage.groups.enabled'));
		assert.isNull(Zotero.Sync.Storage.Local.getModeForLibrary(Zotero.Libraries.userLibraryID));
	});

	it("does not send stored account credentials to Zotero streaming", async function () {
		Zotero.Prefs.set('streaming.enabled', true);
		Zotero.Prefs.set('automaticScraperUpdates', true);
		Zotero.Prefs.set('sync.autoSync', true);
		let legacyKey = sandbox.stub(Zotero.Sync.Data.Local, 'getAPIKey').resolves('obsolete-cloud-key');
		let streamer = new Zotero.Streamer_Module({ apiKey: 'obsolete-cloud-key' });
		try {
			streamer._socket = { readyState: 1, OPEN: 1, send: sandbox.spy() };
			streamer._ready = true;
			await streamer._update();
			assert.isFalse(legacyKey.called);
			let message = JSON.parse(streamer._socket.send.firstCall.args[0]);
			assert.deepEqual(message.subscriptions, [{ topics: ['styles', 'translators'] }]);
			Zotero.Prefs.set('automaticScraperUpdates', false);
			assert.isFalse(streamer._isEnabled());
		}
		finally {
			Zotero.Notifier.unregisterObserver(streamer._observerID);
		}
	});

	it("recognizes PDFs without an account or configured metadata server", async function () {
		Zotero.Prefs.set('sync.metadata.postgresql.url', '');
		let attachment = await importPDFAttachment();
		let parent;
		try {
			sandbox.stub(Zotero.PDFWorker, 'getRecognizerData').resolves({ pages: [[0, 0, 'Sample text']] });
			sandbox.stub(Zotero.Sync.Runner, 'getAPIClient').throws(new Error('Sync client must not be used'));
			let http = sandbox.stub(Zotero.HTTP, 'request').resolves({
				status: 200,
				responseText: JSON.stringify({ title: 'Recognized paper', authors: [] })
			});
			parent = await Zotero.RecognizeDocument._recognize(attachment);
			assert.equal(parent.getField('title'), 'Recognized paper');
			assert.match(http.firstCall.args[1], /\/recognizer\/recognize$/);
			assert.notProperty(http.firstCall.args[2].headers, 'Zotero-API-Key');
		}
		finally {
			await attachment.eraseTx();
			await parent?.eraseTx();
		}
	});

	it("discovers open-access PDFs by DOI without using the sync API", async function () {
		Zotero.Prefs.set('sync.metadata.postgresql.url', '');
		sandbox.stub(Zotero.Sync.Runner, 'getAPIClient').throws(new Error('Sync client must not be used'));
		let locations = [{ url: 'https://example.invalid/paper.pdf', version: 'acceptedVersion' }];
		let http = sandbox.stub(Zotero.HTTP, 'request').resolves({ response: locations });
		assert.deepEqual(await Zotero.Utilities.Internal.getOpenAccessPDFURLs('10.1234/example'), locations);
		assert.match(http.firstCall.args[1], /\/oa\/search$/);
		assert.deepEqual(JSON.parse(http.firstCall.args[2].body), { doi: '10.1234/example' });
		assert.notProperty(http.firstCall.args[2].headers, 'Zotero-API-Key');
	});

	it("shows only PostgreSQL and WebDAV or no-file-sync choices in Account settings", async function () {
		Zotero.Prefs.set('sync.metadata.backend', 'zotero');
		Zotero.Prefs.set('sync.storage.protocol', 'zotero');
		let legacyKey = sandbox.stub(Zotero.Sync.Data.Local, 'getAPIKey').rejects(new Error('Legacy key read'));
		preferences = await loadPrefPane('account');
		let doc = preferences.document;
		assert.lengthOf(doc.querySelectorAll('#metadata-backend menuitem[value="zotero"]'), 0);
		assert.lengthOf(doc.querySelectorAll('#storage-protocol menuitem[value="zotero"]'), 0);
		assert.isNull(doc.getElementById('storage-groups-zotero-storage-option'));
		assert.equal(doc.getElementById('metadata-backend').value, 'postgresql');
		assert.equal(doc.getElementById('storage-protocol').value, 'none');
		assert.isFalse(doc.getElementById('metadata-postgresql-settings').hidden);
		assert.isFalse(legacyKey.called);
	});
});
