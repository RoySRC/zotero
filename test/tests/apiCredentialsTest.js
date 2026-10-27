/* global describe, beforeEach, afterEach, it, assert, sinon, getPromiseError */
"use strict";

describe('OS-keychain API credentials', function () {
	let sandbox, saved, knownLogins, user, encrypt, decrypt, secrets;
	const metadata = Zotero.Sync.Metadata;
	const recognizer = Zotero.RecognizeDocument;
	const serverA = 'https://credentials-a.example.test/api/';
	const serverB = 'https://credentials-b.example.test/api/';
	const names = ['sync.metadata.postgresql.url',
		'sync.metadata.backend',
		metadata._legacyCredentialScopePref,
		'recognize.engine',
		'recognize.epilib.url'];
	const keys = { pubmed: 'synthetic-provider-key', crossref: 'synthetic-crossref-key' };

	beforeEach(async function () {
		sandbox = sinon.createSandbox();
		saved = names.map(name => [name, Zotero.Prefs.get(name)]);
		knownLogins = new Set((await Services.logins.searchLoginsAsync({ origin: 'chrome://zotero' })).map(login => login.guid));
		// XPCOM methods themselves are non-configurable. A forwarding facade keeps
		// the real login database while allowing precise persistence fault injection.
		const nativeLogins = Services.logins;
		const logins = {};
		for (const method of ['searchLoginsAsync', 'addLoginAsync', 'modifyLoginAsync', 'removeLoginAsync']) {
			logins[method] = (...args) => nativeLogins[method](...args);
		}
		sandbox.stub(Services, 'logins').value(logins);
		user = sandbox.stub(Zotero.Users, 'getCurrentUserID').returns(111);
		Zotero.Prefs.set('sync.metadata.postgresql.url', serverA);
		Zotero.Prefs.set('recognize.engine', 'epilib-local');
		Zotero.Prefs.set('recognize.epilib.url', '');
		Zotero.Prefs.clear(metadata._legacyCredentialScopePref);
		metadata.pinLegacyCredentialScope();
		sandbox.stub(metadata, '_verifyLegacyCredentialIdentity').resolves();
		// Deterministic fault injection at the OS boundary. Mozilla's actual login
		// database still persists entries; no real keychain prompts or secrets are used.
		secrets = new Map();
		encrypt = sandbox.stub(Zotero.OSKeyStore, 'encrypt').callsFake(async (plaintext) => {
			const ciphertext = 'oskv1:test-' + Zotero.Utilities.randomString();
			secrets.set(ciphertext, plaintext);
			return ciphertext;
		});
		decrypt = sandbox.stub(Zotero.OSKeyStore, 'decrypt').callsFake(async (ciphertext) => {
			if (!Zotero.OSKeyStore.isEncrypted(ciphertext)) return ciphertext;
			if (!secrets.has(ciphertext)) throw new Error('Synthetic keychain is locked');
			return secrets.get(ciphertext);
		});
	});

	afterEach(async function () {
		sandbox.restore();
		for (const login of await Services.logins.searchLoginsAsync({ origin: 'chrome://zotero' })) {
			if (!knownLogins.has(login.guid)) await Services.logins.removeLoginAsync(login);
		}
		for (const [name, value] of saved) {
			if (value === undefined) Zotero.Prefs.clear(name); else Zotero.Prefs.set(name, value);
		}
	});

	/** Seed exactly the formats used before the OS-keychain migration. */
	async function seed(realm, username, password) {
		const LoginInfo = new Components.Constructor('@mozilla.org/login-manager/loginInfo;1',
			Components.interfaces.nsILoginInfo, 'init');
		return Services.logins.addLoginAsync(new LoginInfo('chrome://zotero', null, realm, username, password, '', ''));
	}
	const legacyToken = () => seed(metadata._loginManagerRealm, metadata._loginManagerUsername, 'synthetic-legacy-token');
	const providerRealm = () => {
		const scope = recognizer.getProviderCredentialScope();
		return 'EpiLib PDF provider credentials: ' + JSON.stringify([scope.baseURL, scope.userID]);
	};
	const entries = realm => Services.logins.searchLoginsAsync({ origin: 'chrome://zotero', httpRealm: realm });
	const tokenRealm = (url = serverA, userID = 111) => metadata._credentialDescriptor(metadata.getPostgreSQLCredentialScope({ url, userID })).realm;
	const keychainError = () => new Zotero.Error('Synthetic keychain locked', 0, { keyStoreError: true });
	const authReply = (userID = 222) => ({ status: 200,
		responseText: JSON.stringify({ userID, username: 'synthetic-user', apiKey: 'synthetic-login-token' }) });

	it('stores only OS ciphertext and isolates canonical server paths, ports and user IDs', async function () {
		await metadata.setPostgreSQLAPIKey('a-111');
		await metadata.setPostgreSQLAPIKey('a-222', { url: serverA, userID: 222 });
		await metadata.setPostgreSQLAPIKey('b-111', { url: serverB, userID: 111 });
		assert.equal(await metadata.getPostgreSQLAPIKey(), 'a-111');
		assert.equal(await metadata.getPostgreSQLAPIKey({ url: 'https://CREDENTIALS-A.example.test:443/api', userID: '111' }), 'a-111');
		assert.equal(await metadata.getPostgreSQLAPIKey({ userID: 222 }), 'a-222');
		assert.equal(await metadata.getPostgreSQLAPIKey({ url: serverB }), 'b-111');
		assert.isNull(await metadata.getPostgreSQLAPIKey({ url: 'https://credentials-a.example.test/other/' }));
		assert.isNull(await metadata.getPostgreSQLAPIKey({ url: 'https://credentials-a.example.test:444/api/' }));
		for (const login of await entries(tokenRealm())) {
			assert.isTrue(Zotero.OSKeyStore.isEncrypted(login.password));
			assert.notInclude(login.password, 'a-111');
		}
	});

	it('migrates the original global token once and removes it only after persisted decryption', async function () {
		await legacyToken();
		const remove = sandbox.spy(Services.logins, 'removeLoginAsync');
		assert.equal(await metadata.getPostgreSQLAPIKey(), 'synthetic-legacy-token');
		assert.isTrue(remove.calledAfter(decrypt));
		assert.equal((await entries(metadata._loginManagerRealm)).length, 0);
		assert.equal((await entries(tokenRealm())).length, 1);
		assert.equal(await metadata.getPostgreSQLAPIKey(), 'synthetic-legacy-token');
		assert.isTrue(encrypt.calledOnce);
	});

	it('never rebinds the global token after a server/user switch, including after restart', async function () {
		await legacyToken();
		await metadata.configurePostgreSQL({ url: serverB });
		metadata.pinLegacyCredentialScope();
		assert.isNull(await metadata.getPostgreSQLAPIKey());
		Zotero.Prefs.set('sync.metadata.postgresql.url', serverA);
		user.returns(222);
		assert.isNull(await metadata.getPostgreSQLAPIKey());
		user.returns(111);
		assert.equal(await metadata.getPostgreSQLAPIKey(), 'synthetic-legacy-token');
	});

	it('leaves an unidentifiable legacy token intact and requires authentication instead of guessing', async function () {
		await legacyToken();
		Zotero.Prefs.clear(metadata._legacyCredentialScopePref);
		user.returns(null);
		metadata.pinLegacyCredentialScope();
		user.returns(111);
		assert.isNull(await metadata.getPostgreSQLAPIKey());
		assert.equal((await entries(metadata._loginManagerRealm)).length, 1);
		assert.isFalse(encrypt.called);
	});

	it('migrates provider JSON atomically and never writes provider keys into preferences', async function () {
		const legacy = providerRealm();
		await seed(legacy, 'providerKeys', JSON.stringify(keys));
		assert.deepEqual(await recognizer.getProviderCredentials(), keys);
		assert.equal((await entries(legacy)).length, 0);
		const [saved] = await entries(legacy + ' [OSKeyStore v1]');
		assert.isTrue(Zotero.OSKeyStore.isEncrypted(saved.password));
		assert.notInclude(saved.password, keys.pubmed);
		await recognizer.setProviderCredentials({ pubmed: 'replacement' });
		assert.deepEqual(await recognizer.getProviderCredentials(), { pubmed: 'replacement' });
		await recognizer.setProviderCredentials({});
		assert.deepEqual(await recognizer.getProviderCredentials(), {});
		for (const name of names) assert.notInclude(String(Zotero.Prefs.get(name)), keys.pubmed);
	});

	it('keeps both legacy formats untouched when keychain encryption is denied; no plaintext fallback', async function () {
		await legacyToken();
		const realm = providerRealm();
		await seed(realm, 'providerKeys', JSON.stringify(keys));
		encrypt.rejects(keychainError());
		assert.isTrue((await getPromiseError(metadata.getPostgreSQLAPIKey())).keyStoreError);
		assert.isTrue((await getPromiseError(recognizer.getProviderCredentials())).keyStoreError);
		assert.equal((await entries(metadata._loginManagerRealm))[0].password, 'synthetic-legacy-token');
		assert.equal((await entries(realm))[0].password, JSON.stringify(keys));
		assert.equal((await entries(tokenRealm())).length, 0);
		assert.equal((await entries(realm + ' [OSKeyStore v1]')).length, 0);
	});

	it('retains the legacy token if writing or verifying the new login fails', async function () {
		await legacyToken();
		const add = sandbox.stub(Services.logins, 'addLoginAsync').rejects(new Error('Synthetic disk failure'));
		assert.include((await getPromiseError(metadata.getPostgreSQLAPIKey())).message, 'Synthetic disk failure');
		assert.equal((await entries(metadata._loginManagerRealm)).length, 1);
		add.restore();
		decrypt.resetHistory();
		decrypt.onCall(2).rejects(keychainError()); // Legacy read, pre-write check, persisted read-back.
		assert.isTrue((await getPromiseError(metadata.getPostgreSQLAPIKey())).keyStoreError);
		assert.equal((await entries(metadata._loginManagerRealm)).length, 1);
		assert.equal((await entries(tokenRealm())).length, 0);
		assert.equal(await metadata.getPostgreSQLAPIKey(), 'synthetic-legacy-token');
	});

	it('resumes cleanup after an interrupted migration without overwriting the verified new entry', async function () {
		await legacyToken();
		const remove = sandbox.stub(Services.logins, 'removeLoginAsync');
		remove.onFirstCall().rejects(new Error('Synthetic delete failure'));
		remove.callThrough();
		assert.include((await getPromiseError(metadata.getPostgreSQLAPIKey())).message, 'Synthetic delete failure');
		assert.equal((await entries(tokenRealm())).length, 1);
		assert.equal((await entries(metadata._loginManagerRealm)).length, 1);
		assert.equal(await metadata.getPostgreSQLAPIKey(), 'synthetic-legacy-token');
		assert.isTrue(encrypt.calledOnce);
		assert.equal((await entries(metadata._loginManagerRealm)).length, 0);
	});

	it('refuses corrupt or transplanted ciphertext rather than downgrading to the legacy secret', async function () {
		await metadata.setPostgreSQLAPIKey('protected-token');
		await legacyToken();
		const [original] = await entries(tokenRealm());
		await seed(tokenRealm(serverB), metadata._loginManagerUsername, original.password);
		assert.include((await getPromiseError(metadata.getPostgreSQLAPIKey({ url: serverB }))).message, 'does not match');
		secrets.delete(original.password);
		assert.include((await getPromiseError(metadata.getPostgreSQLAPIKey())).message, 'decrypt');
		assert.equal((await entries(metadata._loginManagerRealm)).length, 1);
	});

	it('serializes concurrent migrations without creating duplicate entries', async function () {
		await legacyToken();
		assert.deepEqual(await Promise.all([metadata.getPostgreSQLAPIKey(), metadata.getPostgreSQLAPIKey()]),
			['synthetic-legacy-token', 'synthetic-legacy-token']);
		assert.equal((await entries(tokenRealm())).length, 1);
		assert.isTrue(encrypt.calledOnce);
	});

	it('logout during migration cannot resurrect the credential after the pending unlock resolves', async function () {
		await legacyToken();
		let resume, started;
		const ready = new Promise((resolve) => {
			started = resolve;
		});
		encrypt.callsFake((plaintext) => {
			started(); return new Promise((resolve) => {
				resume = () => {
					secrets.set('oskv1:late', plaintext); resolve('oskv1:late');
				};
			});
		});
		const reading = getPromiseError(metadata.getPostgreSQLAPIKey());
		await ready;
		const clearing = metadata.clearPostgreSQLAPIKey();
		resume();
		assert.include((await reading).message, 'changed');
		await clearing;
		assert.equal((await entries(tokenRealm())).length, 0);
		assert.equal((await entries(metadata._loginManagerRealm)).length, 0);
	});

	it('logout removes only the selected server/user and does not need keychain decryption', async function () {
		await metadata.setPostgreSQLAPIKey('a-111');
		await metadata.setPostgreSQLAPIKey('a-222', { userID: 222 });
		await metadata.setPostgreSQLAPIKey('b-111', { url: serverB });
		decrypt.resetHistory();
		await metadata.disablePostgreSQL();
		assert.isFalse(decrypt.called);
		assert.equal((await entries(tokenRealm())).length, 0);
		assert.equal(await metadata.getPostgreSQLAPIKey({ url: serverA, userID: 222 }), 'a-222');
		assert.equal(await metadata.getPostgreSQLAPIKey({ url: serverB }), 'b-111');
	});

	it('login uses the authenticated response identity rather than the previous local user', async function () {
		await metadata.setPostgreSQLAPIKey('original-account');
		sandbox.stub(Zotero.HTTP, 'request').resolves(authReply());
		await metadata.loginPostgreSQL({ url: serverB, username: 'new-user', password: 'synthetic-password' });
		assert.isNull(await metadata.getPostgreSQLAPIKey());
		assert.equal(await metadata.getPostgreSQLAPIKey({ url: serverB, userID: 222 }), 'synthetic-login-token');
		assert.equal(await metadata.getPostgreSQLAPIKey({ url: serverA, userID: 111 }), 'original-account');
		user.returns(222);
		assert.equal(await metadata.getPostgreSQLAPIKey(), 'synthetic-login-token');
	});

	it('does not change the selected server or its working token if saving a login fails', async function () {
		await metadata.setPostgreSQLAPIKey('original-account');
		sandbox.stub(Zotero.HTTP, 'request').resolves(authReply());
		encrypt.rejects(keychainError());
		assert.isTrue((await getPromiseError(metadata.loginPostgreSQL({ url: serverB, username: 'new', password: 'synthetic' }))).keyStoreError);
		assert.equal(metadata.getPostgreSQLBaseURL(), serverA);
		assert.equal(await metadata.getPostgreSQLAPIKey(), 'original-account');
	});

	it('registering or fetching settings on another server never borrows the active token', async function () {
		await metadata.setPostgreSQLAPIKey('a-only-token');
		const http = sandbox.stub(Zotero.HTTP, 'request').resolves({ ...authReply(), status: 201 });
		assert.isNull(await metadata.fetchPostgreSQLSyncSettings({ url: serverB }));
		assert.isFalse(http.called);
		await metadata.registerPostgreSQL({ url: serverB, username: 'new-user', password: 'synthetic-password' });
		assert.isUndefined(http.firstCall.args[2].headers['Zotero-API-Key']);
		assert.isFalse(http.firstCall.args[2].followRedirects);
		assert.equal(http.firstCall.args[2].logBodyLength, 0);
	});

	it('rejects a late authentication reply and preserves the old account', async function () {
		await metadata.setPostgreSQLAPIKey('original-account');
		sandbox.stub(Zotero.HTTP, 'request').callsFake(async () => {
			user.returns(333);
			return authReply();
		});
		assert.include((await getPromiseError(metadata.loginPostgreSQL({ url: serverB, username: 'new', password: 'synthetic' }))).message, 'changed');
		assert.equal(metadata.getPostgreSQLBaseURL(), serverA);
		assert.equal((await entries(tokenRealm(serverB, 222))).length, 0);
	});

	it('presence checks do not unlock the keychain and URLs cannot carry credentials or queries', async function () {
		await legacyToken();
		assert.isTrue(await metadata.hasPostgreSQLAPIKey());
		assert.isFalse(encrypt.called); assert.isFalse(decrypt.called);
		for (const url of ['https://user:password@example.test/', 'https://example.test/?token=secret', 'https://example.test/#secret']) {
			assert.throws(() => metadata.normalizePostgreSQLBaseURL(url), 'cannot contain');
		}
	});

	it('verifies legacy identity only against the pinned server and preserves mismatched/offline credentials', async function () {
		await legacyToken();
		metadata._verifyLegacyCredentialIdentity.restore();
		const http = sandbox.stub(Zotero.HTTP, 'request').resolves({ status: 200, responseText: '{"userID":222}' });
		assert.include((await getPromiseError(metadata.getPostgreSQLAPIKey())).message, 'identity could not be confirmed');
		assert.equal((await entries(tokenRealm())).length, 0);
		assert.equal((await entries(metadata._loginManagerRealm)).length, 1);
		assert.equal(http.firstCall.args[1], serverA + 'keys/current');
		assert.equal(http.firstCall.args[2].headers['Zotero-API-Key'], 'synthetic-legacy-token');
		assert.isFalse(http.firstCall.args[2].followRedirects);
		http.rejects(new Error('Offline'));
		assert.include((await getPromiseError(metadata.getPostgreSQLAPIKey())).message, 'preserved');
		assert.equal((await entries(metadata._loginManagerRealm)).length, 1);
		http.resolves({ status: 200, responseText: '{"userID":111}' });
		assert.equal(await metadata.getPostgreSQLAPIKey(), 'synthetic-legacy-token');
		assert.equal((await entries(metadata._loginManagerRealm)).length, 0);
	});

	it('rolls back a failed encrypted replacement and rejects malformed tokens without deleting the old one', async function () {
		await metadata.setPostgreSQLAPIKey('original-token');
		const [original] = await entries(tokenRealm());
		decrypt.resetHistory();
		decrypt.onCall(1).rejects(keychainError()); // Pre-write verification succeeds; persisted read fails.
		assert.isTrue((await getPromiseError(metadata.setPostgreSQLAPIKey('replacement-token'))).keyStoreError);
		assert.equal((await entries(tokenRealm()))[0].password, original.password);
		for (const invalid of [false, 0, {}, 'secret\nheader']) {
			assert.include((await getPromiseError(metadata.setPostgreSQLAPIKey(invalid))).message, 'Invalid');
			assert.equal(await metadata.getPostgreSQLAPIKey(), 'original-token');
		}
	});

	it('preserves corrupt provider JSON and aborts provider migration if the account changes during unlock', async function () {
		const realm = providerRealm();
		const legacy = await seed(realm, 'providerKeys', '{malformed-secret');
		const error = await getPromiseError(recognizer.getProviderCredentials());
		assert.notInclude(error.message, 'malformed-secret');
		assert.equal((await entries(realm))[0].password, '{malformed-secret');
		assert.equal((await entries(realm + ' [OSKeyStore v1]')).length, 0);
		await Services.logins.removeLoginAsync(legacy);
		await seed(realm, 'providerKeys', JSON.stringify(keys));
		// Switch identity only after a complete ciphertext is available, before persistence.
		encrypt.callsFake(async (plaintext) => {
			secrets.set('oskv1:provider-late', plaintext);
			user.returns(222);
			return 'oskv1:provider-late';
		});
		assert.include((await getPromiseError(recognizer.getProviderCredentials())).message, 'changed');
		assert.equal((await entries(realm + ' [OSKeyStore v1]')).length, 0);
		assert.equal((await entries(realm))[0].password, JSON.stringify(keys));
	});

	it('password changes replace only the authenticated server/user token', async function () {
		await metadata.setPostgreSQLAPIKey('a-111');
		await metadata.setPostgreSQLAPIKey('b-111', { url: serverB });
		await metadata.setPostgreSQLAPIKey('b-222', { url: serverB, userID: 222 });
		const http = sandbox.stub(Zotero.HTTP, 'request').resolves(authReply(222));
		await metadata.resetPostgreSQLPassword({ url: serverB, username: 'new-user',
			oldPassword: 'synthetic-old', newPassword: 'synthetic-new' });
		assert.equal(http.firstCall.args[1], serverB + 'auth/password');
		assert.equal(http.firstCall.args[2].logBodyLength, 0);
		assert.equal(await metadata.getPostgreSQLAPIKey({ url: serverA, userID: 111 }), 'a-111');
		assert.equal(await metadata.getPostgreSQLAPIKey({ url: serverB, userID: 111 }), 'b-111');
		assert.equal(await metadata.getPostgreSQLAPIKey({ url: serverB, userID: 222 }), 'synthetic-login-token');
	});

	it('does not create a sync client with an old token after the destination changes', async function () {
		await metadata.setPostgreSQLAPIKey('original-token');
		const runner = new Zotero.Sync.Runner_Module();
		const client = sandbox.stub(runner, 'getAPIClient').throws(new Error('Unexpected API client'));
		const errors = sandbox.spy();
		// Icon updates happen after token retrieval, before any pauses or API calls.
		sandbox.stub(runner, 'updateIcons').callsFake((state) => {
			if (state == 'animate') Zotero.Prefs.set('sync.metadata.postgresql.url', serverB);
		});
		await runner.sync({ onError: errors });
		assert.isTrue(errors.calledOnce);
		assert.include(errors.firstCall.args[0].message, 'changed');
		assert.isFalse(client.called);
	});
});

describe('Native OS-keychain credential integration', function () {
	it('round-trips a synthetic secret through the real OS keychain and login database', async function () {
		// Opt in on a desktop with an unlocked keychain. CI's headless hosts exercise
		// deterministic success/failure cases above without relying on an OS service.
		if (Services.env.get('EPILIB_TEST_NATIVE_KEYCHAIN') != '1') this.skip();
		const descriptor = { realm: 'EpiLib synthetic keychain test ' + Zotero.Utilities.randomString(), username: 'test-only' };
		const secret = 'synthetic-' + Zotero.Utilities.randomString(32);
		try {
			await Zotero.CredentialStore.set(descriptor, secret);
			const [login] = await Services.logins.searchLoginsAsync({ origin: 'chrome://zotero', httpRealm: descriptor.realm });
			assert.isTrue(Zotero.OSKeyStore.isEncrypted(login.password));
			assert.notInclude(login.password, secret);
			assert.equal(await Zotero.CredentialStore.get(descriptor), secret);
		}
		finally {
			await Zotero.CredentialStore.remove(descriptor);
		}
	});
});
