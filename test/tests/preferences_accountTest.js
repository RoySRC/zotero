/* global describe, beforeEach, afterEach, it, assert, sinon, loadPrefPane, waitForDialog */
describe("Account Preferences", function () {
	let win, doc, sandbox, apiKey, savedURL;

	beforeEach(async function () {
		sandbox = sinon.createSandbox();
		apiKey = 'test-postgresql-token';
		savedURL = Zotero.Prefs.get('sync.metadata.postgresql.url');
		Zotero.Prefs.set('sync.metadata.postgresql.url', 'http://localhost:23129/');
		sandbox.stub(Zotero.Sync.Metadata, 'getPostgreSQLAPIKey').callsFake(async () => apiKey);
		sandbox.stub(Zotero.Sync.Metadata, 'hasPostgreSQLAPIKey').callsFake(async () => !!apiKey);
		sandbox.stub(Zotero.Sync.Metadata, 'clearPostgreSQLAPIKey').callsFake(async () => {
			apiKey = '';
		});
		sandbox.stub(Zotero.Users, 'getCurrentUsername').returns('Test User');
		sandbox.stub(Zotero.Sync.Data.Local, 'getAPIKey').throws(new Error('Legacy account key read'));
		sandbox.stub(Zotero.HTTP, 'request').rejects(new Error('Unexpected HTTP request'));
		win = await loadPrefPane('account');
		doc = win.document;
	});

	afterEach(function () {
		win?.close();
		sandbox.restore();
		Zotero.Prefs.set('sync.metadata.postgresql.url', savedURL);
	});

	it("shows the PostgreSQL account and sync controls for a saved server token", async function () {
		await win.Zotero_Preferences.Sync._refreshAccountAndSyncUI();
		assert.equal(doc.getElementById('account-username').value, 'Test User');
		assert.isFalse(doc.getElementById('account-log-out-button').hidden);
		assert.isFalse(doc.getElementById('sync-settings-section').hidden);
		assert.isTrue(doc.getElementById('sync-unauthorized').hidden);
	});

	it("focuses the server login without opening a Zotero authorization page", async function () {
		let launchURL = sandbox.stub(Zotero, 'launchURL');
		await win.Zotero_Preferences.Sync.linkAccount();
		assert.equal(doc.activeElement.id, 'metadata-postgresql-url');
		assert.isFalse(launchURL.called);
		assert.isFalse(Zotero.HTTP.request.called);
	});

	it("logs out locally without deleting library data or contacting Zotero", async function () {
		let version = Zotero.Libraries.userLibrary.libraryVersion;
		let resetController = sandbox.spy(Zotero.Sync.Runner, 'resetStorageController');
		await win.Zotero_Preferences.Sync.unlinkAccount(false);
		assert.equal(apiKey, '');
		assert.isTrue(resetController.calledWith('webdav'));
		assert.isTrue(doc.getElementById('account-log-out-button').hidden);
		assert.isFalse(doc.getElementById('metadata-postgresql-settings').hidden);
		assert.equal(Zotero.Libraries.userLibrary.libraryVersion, version);
		assert.isFalse(Zotero.HTTP.request.called);
	});

	it("keeps the server token when logout is cancelled", async function () {
		let dialog = waitForDialog(null, 'cancel');
		await win.Zotero_Preferences.Sync.unlinkAccount();
		await dialog;
		assert.equal(apiKey, 'test-postgresql-token');
		assert.isFalse(Zotero.HTTP.request.called);
	});
});
