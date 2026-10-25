/* global describe, beforeEach, afterEach, it, assert, sinon, loadPrefPane, getPromiseError */
"use strict";

describe('Recognition provider credentials', function () {
	let sandbox, saved, preferences, scopes;
	const recognizer = Zotero.RecognizeDocument;
	const names = ['recognize.engine', 'recognize.epilib.url', 'sync.metadata.postgresql.url', 'recognize.url'];
	const server = 'https://provider-keys.example.test/';
	const payload = { metadata: {}, pages: [], fileName: 'synthetic.pdf' };
	const keys = { googleBooks: 'test-google', openAlex: 'test-openalex', semanticScholar: 'test-semantic',
		pubmed: 'test-ncbi', crossref: 'test-crossref', worldcatClientID: 'test-oclc-id', worldcatClientSecret: 'test-oclc-secret' };

	beforeEach(function () {
		sandbox = sinon.createSandbox();
		saved = names.map(name => [name, Zotero.Prefs.get(name)]);
		scopes = [];
		Zotero.Prefs.set('recognize.engine', 'epilib');
		Zotero.Prefs.set('recognize.epilib.url', '');
		Zotero.Prefs.set('sync.metadata.postgresql.url', server);
		Zotero.Prefs.set('recognize.url', 'https://zotero.example.test/');
		sandbox.stub(Zotero.Sync.Metadata, 'getPostgreSQLAPIKey').resolves('synthetic-account-token');
		scopes.push(recognizer.getProviderCredentialScope());
	});

	/** Remove only synthetic test realms, never unrelated saved passwords. */
	afterEach(async function () {
		preferences?.close();
		preferences = null;
		sandbox.restore();
		for (let scope of scopes) {
			let realm = 'EpiLib PDF provider credentials: ' + JSON.stringify([scope.baseURL, scope.userID]);
			for (let login of await Services.logins.searchLoginsAsync({ origin: 'chrome://zotero', httpRealm: realm })) {
				await Services.logins.removeLoginAsync(login);
			}
		}
		for (let [name, value] of saved) {
			if (value === undefined) Zotero.Prefs.clear(name);
			else Zotero.Prefs.set(name, value);
		}
	});

	it('stores, replaces and removes all seven values in the login manager', async function () {
		assert.deepEqual(await recognizer.getProviderCredentials(), {});
		await recognizer.setProviderCredentials(keys);
		assert.deepEqual(await recognizer.getProviderCredentials(), keys);
		await recognizer.setProviderCredentials({ pubmed: 'replacement' });
		assert.deepEqual(await recognizer.getProviderCredentials(), { pubmed: 'replacement' });
		await recognizer.setProviderCredentials({});
		assert.deepEqual(await recognizer.getProviderCredentials(), {});
	});

	it('isolates account and canonical server scopes and rejects stale writes', async function () {
		await recognizer.setProviderCredentials(keys);
		const scope = recognizer.getProviderCredentialScope();
		Zotero.Prefs.set('recognize.epilib.url', 'https://PROVIDER-KEYS.example.test:443/recognizer');
		assert.deepEqual(await recognizer.getProviderCredentials(), keys);
		Zotero.Prefs.set('recognize.epilib.url', 'https://other.example.test/');
		assert.deepEqual(await recognizer.getProviderCredentials(), {});
		assert.include((await getPromiseError(recognizer.setProviderCredentials(keys, scope))).message, 'changed');
		Zotero.Prefs.set('recognize.epilib.url', '');
		sandbox.stub(Zotero.Users, 'getCurrentUserID').returns(999999);
		assert.deepEqual(await recognizer.getProviderCredentials(), {});
		assert.include((await getPromiseError(recognizer.setProviderCredentials(keys, scope))).message, 'changed');
	});

	it('validates keys and WorldCat pairs without overwriting saved credentials', async function () {
		await recognizer.setProviderCredentials(keys);
		for (let bad of [
			{ worldcatClientID: 'private-test-value' },
			{ crossref: 'private-test-value\nheader' },
			{ pubmed: 5 },
			JSON.parse('{"__proto__":"private-test-value"}'),
			{ other: 'private-test-value' }
		]) {
			let error = await getPromiseError(recognizer.setProviderCredentials(bad));
			assert.equal(error.name, 'Error');
			assert.notInclude(error.message, 'private-test-value');
			assert.deepEqual(await recognizer.getProviderCredentials(), keys);
		}
	});

	it('checks capability then sends scoped credentials without logging bodies or following redirects', async function () {
		await recognizer.setProviderCredentials(keys);
		let http = sandbox.stub(Zotero.HTTP, 'request').callsFake(async method => ({ status: 200,
			responseText: method == 'GET' ? '{"engine":"epilib","providerCredentials":1}' : 'null' }));
		await recognizer.queryPDFMetadata(payload);
		assert.equal(http.callCount, 2);
		assert.equal(http.firstCall.args[1], server + 'recognizer/health');
		assert.isUndefined(http.firstCall.args[2].body);
		assert.deepEqual(JSON.parse(http.secondCall.args[2].body), { ...payload, providerKeys: keys });
		assert.equal(http.secondCall.args[2].logBodyLength, 0);
		assert.isFalse(http.secondCall.args[2].followRedirects);
		assert.isUndefined(payload.providerKeys);
		assert.notInclude(JSON.stringify(recognizer.getRecognitionConfiguration()), 'test-google');
	});

	it('never sends personal keys to a legacy worker, Zotero, or an unencrypted remote server', async function () {
		await recognizer.setProviderCredentials(keys);
		let http = sandbox.stub(Zotero.HTTP, 'request').resolves({ status: 200, responseText: '{"engine":"epilib"}' });
		assert.include((await getPromiseError(recognizer.queryPDFMetadata(payload))).message, 'Update the recognition server');
		assert.equal(http.callCount, 1);
		assert.isUndefined(http.firstCall.args[2].body);
		Zotero.Prefs.set('recognize.engine', 'zotero');
		http.resolves({ status: 200, responseText: 'null' });
		await recognizer.queryPDFMetadata({ ...payload, providerKeys: keys });
		assert.deepEqual(JSON.parse(http.lastCall.args[2].body), payload);
		assert.isUndefined(http.lastCall.args[2].headers['Zotero-API-Key']);
		Zotero.Prefs.set('recognize.engine', 'epilib');
		Zotero.Prefs.set('recognize.epilib.url', 'http://remote.example.test/');
		scopes.push(recognizer.getProviderCredentialScope());
		await recognizer.setProviderCredentials(keys);
		http.resetHistory();
		assert.include((await getPromiseError(recognizer.queryPDFMetadata(payload))).message, 'HTTPS');
		assert.isFalse(http.called);
	});

	it('allows loopback credentials but aborts an account switch during capability lookup', async function () {
		Zotero.Prefs.set('recognize.epilib.url', 'http://127.0.0.1:23130/');
		scopes.push(recognizer.getProviderCredentialScope());
		await recognizer.setProviderCredentials(keys);
		let http = sandbox.stub(Zotero.HTTP, 'request').callsFake(async method => ({ status: 200,
			responseText: method == 'GET' ? '{"engine":"epilib","providerCredentials":1}' : 'null' }));
		await recognizer.queryPDFMetadata(payload);
		assert.equal(http.callCount, 2);
		let user = sandbox.stub(Zotero.Users, 'getCurrentUserID').returns(scopes.at(-1).userID);
		http.resetHistory();
		http.callsFake(async () => {
			user.returns(999999);
			return { status: 200, responseText: '{"engine":"epilib","providerCredentials":1}' };
		});
		assert.include((await getPromiseError(recognizer.queryPDFMetadata(payload))).message, 'changed');
		assert.equal(http.callCount, 1);
	});

	it('renders labelled masked fields; blank saves keep keys and Clear removes only the selected provider', async function () {
		await recognizer.setProviderCredentials(keys);
		preferences = await loadPrefPane('general');
		let doc = preferences.document;
		let general = preferences.Zotero_Preferences.General;
		await general._loadProviderKeysUI(true);
		await doc.l10n.translateFragment(doc.getElementById('recognition-provider-keys'));
		for (let name of recognizer.providerCredentialNames) {
			let input = doc.getElementById('recognition-provider-key-' + name);
			assert.equal(input.type, 'password');
			assert.equal(input.value, '');
			assert.include(input.placeholder, 'Saved');
			assert.isFalse(input.disabled);
			assert.isAbove(input.getBoundingClientRect().width, 100);
			assert.isNotEmpty(doc.querySelector('label[for="' + input.id + '"]').textContent);
		}
		assert.isNotEmpty(doc.getElementById('recognition-provider-keys-save').textContent);
		await general.saveRecognitionProviderKeys();
		assert.deepEqual(await recognizer.getProviderCredentials(), keys);
		general.clearRecognitionProviderKey('worldcatClientID');
		doc.getElementById('recognition-provider-key-pubmed').value = 'new-ncbi-key';
		await general.saveRecognitionProviderKeys();
		let expected = { ...keys, pubmed: 'new-ncbi-key' };
		delete expected.worldcatClientID;
		delete expected.worldcatClientSecret;
		assert.deepEqual(await recognizer.getProviderCredentials(), expected);
		assert.equal(doc.getElementById('recognition-provider-key-pubmed').value, '');
	});

	it('keeps unsaved edits on ordinary UI refresh but discards them when the server changes', async function () {
		preferences = await loadPrefPane('general');
		let doc = preferences.document;
		let general = preferences.Zotero_Preferences.General;
		await general._loadProviderKeysUI(true);
		let input = doc.getElementById('recognition-provider-key-pubmed');
		input.value = 'unsaved-secret';
		general._updateRecognitionUI();
		assert.equal(input.value, 'unsaved-secret');
		Zotero.Prefs.set('recognize.epilib.url', 'https://other.example.test/');
		await general._loadProviderKeysUI();
		assert.equal(input.value, '');
		assert.equal(input.placeholder, 'Not set');
		await general.saveRecognitionProviderKeys();
		assert.deepEqual(await recognizer.getProviderCredentials(), {});
	});

	it('rejects an incomplete WorldCat pair in the editor without changing other providers', async function () {
		await recognizer.setProviderCredentials({ pubmed: 'original-ncbi' });
		preferences = await loadPrefPane('general');
		let doc = preferences.document;
		let general = preferences.Zotero_Preferences.General;
		await general._loadProviderKeysUI(true);
		doc.getElementById('recognition-provider-key-worldcatClientID').value = 'only-id';
		await general.saveRecognitionProviderKeys();
		assert.include(doc.getElementById('recognition-provider-keys-status').textContent, 'Enter both');
		assert.isFalse(doc.getElementById('recognition-provider-keys-save').disabled);
		assert.deepEqual(await recognizer.getProviderCredentials(), { pubmed: 'original-ncbi' });
	});

	it('ignores a late credential read after switching engine and hides the fields', async function () {
		preferences = await loadPrefPane('general');
		let doc = preferences.document;
		let general = preferences.Zotero_Preferences.General;
		await general._loadProviderKeysUI(true);
		let resolve;
		sandbox.stub(recognizer, 'getProviderCredentials').returns(new Promise((done) => {
			resolve = done;
		}));
		let pending = general._loadProviderKeysUI(true);
		Zotero.Prefs.set('recognize.engine', 'zotero');
		general._updateRecognitionUI();
		resolve(keys);
		await pending;
		assert.equal(doc.getElementById('recognition-provider-key-pubmed').placeholder, '');
		assert.isTrue(doc.getElementById('recognition-provider-key-pubmed').disabled);
		assert.equal(doc.getElementById('recognition-provider-keys').getBoundingClientRect().height, 0);
	});

	it('refreshes the credential scope when returning from Account Settings', async function () {
		await recognizer.setProviderCredentials(keys);
		preferences = await loadPrefPane('general');
		let doc = preferences.document;
		let general = preferences.Zotero_Preferences.General;
		await general._loadProviderKeysUI(true);
		let input = doc.getElementById('recognition-provider-key-pubmed');
		input.value = 'old-user-unsaved-key';
		sandbox.stub(Zotero.Users, 'getCurrentUserID').returns(999999);
		doc.getElementById('zotero-prefpane-general').dispatchEvent(new preferences.Event('showing'));
		await general._providerKeysLoading;
		assert.equal(input.value, '');
		assert.equal(input.placeholder, 'Not set');
	});
});
