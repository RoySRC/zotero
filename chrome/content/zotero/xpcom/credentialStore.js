"use strict";

/**
 * OS-keychain-backed secrets stored in Mozilla's profile login database. The
 * versioned envelope binds ciphertext to its realm/username so copying an entry
 * to another account cannot silently re-scope a secret. No plaintext fallback.
 *
 * All operations are serialized: a late migration cannot resurrect a secret
 * after logout or overwrite a newer save. Callers supply a synchronous guard to
 * reject account/configuration changes while a keychain prompt is outstanding.
 */
Zotero.CredentialStore = new function () {
	let queue = Promise.resolve();
	const origin = 'chrome://zotero';

	/** Keep a failed operation from poisoning later reads or writes. */
	function serialize(operation) {
		const result = queue.then(operation);
		queue = result.catch(() => {});
		return result;
	}

	/** Find one exact entry; never guess between duplicate credential identities. */
	async function find(realm, username) {
		if (!realm) return null;
		const entries = (await Services.logins.searchLoginsAsync({ origin, httpRealm: realm }))
			.filter(login => login.username == username);
		if (entries.length > 1) throw new Error('Multiple saved credentials for this account');
		return entries[0] || null;
	}

	/** Check both ciphertext protection and its authenticated logical identity. */
	async function decrypt(login, descriptor, validate) {
		if (!Zotero.OSKeyStore.isEncrypted(login.password)) throw new Error('Saved credential is not OS-keychain encrypted');
		let data;
		try {
			data = JSON.parse(await Zotero.OSKeyStore.decrypt(login.password));
		}
		catch (error) {
			if (Zotero.OSKeyStore.isKeyStoreError(error)) throw error;
			throw new Error('Unable to decrypt saved credential');
		}
		if (data?.version !== 1 || data.realm !== descriptor.realm || data.username !== descriptor.username
			|| typeof data.secret != 'string') throw new Error('Saved credential does not match this account');
		validate(data.secret);
		return data.secret;
	}

	/** Construct a login containing only OS ciphertext in its password slot. */
	function makeLogin(descriptor, password) {
		const LoginInfo = new Components.Constructor('@mozilla.org/login-manager/loginInfo;1',
			Components.interfaces.nsILoginInfo, 'init');
		return new LoginInfo(origin, null, descriptor.realm, descriptor.username, password, '', '');
	}

	/** Remove a legacy entry only after the new ciphertext was read back successfully. */
	async function removeLegacy(descriptor, guard) {
		const legacy = await find(descriptor.legacyRealm, descriptor.legacyUsername || descriptor.username);
		guard();
		if (legacy) await Services.logins.removeLoginAsync(legacy);
	}

	/**
	 * Verify encryption before changing disk, then verify the persisted entry.
	 * Restore the previous encrypted entry on a failed save; during migration the
	 * untouched legacy entry remains recoverable until all verification succeeds.
	 */
	async function write(descriptor, secret, guard, validate, authorizeLegacy) {
		validate(secret);
		guard();
		const previous = await find(descriptor.realm, descriptor.username);
		const password = await Zotero.OSKeyStore.encrypt(JSON.stringify({ version: 1,
			realm: descriptor.realm, username: descriptor.username, secret }));
		const replacement = makeLogin(descriptor, password);
		if (await decrypt(replacement, descriptor, validate) !== secret) throw new Error('Credential encryption verification failed');
		guard();
		if (authorizeLegacy) {
			await authorizeLegacy(secret);
			guard();
		}
		let written = false;
		try {
			if (previous) await Services.logins.modifyLoginAsync(previous, replacement);
			else await Services.logins.addLoginAsync(replacement);
			written = true;
			const saved = await find(descriptor.realm, descriptor.username);
			if (!saved || await decrypt(saved, descriptor, validate) !== secret) throw new Error('Credential storage verification failed');
			guard();
		}
		catch (error) {
			if (written) {
				// Do not undo a change made outside this serialized store.
				const saved = await find(descriptor.realm, descriptor.username);
				if (saved?.password === password) {
					if (previous) await Services.logins.modifyLoginAsync(saved, previous);
					else await Services.logins.removeLoginAsync(saved);
				}
			}
			throw error;
		}
		await removeLegacy(descriptor, guard);
		guard();
	}

	/** Read/migrate lazily; a locked keychain never causes use of the plaintext legacy value. */
	this.get = (descriptor, { guard = () => {}, validate = () => {}, authorizeLegacy } = {}) => serialize(async () => {
		guard();
		const saved = await find(descriptor.realm, descriptor.username);
		if (saved) {
			const secret = await decrypt(saved, descriptor, validate);
			guard();
			await removeLegacy(descriptor, guard);
			guard();
			return secret;
		}
		const legacy = await find(descriptor.legacyRealm, descriptor.legacyUsername || descriptor.username);
		guard();
		if (!legacy) return null;
		const secret = await Zotero.OSKeyStore.decrypt(legacy.password);
		await write(descriptor, secret, guard, validate, authorizeLegacy);
		return secret;
	});

	/** Store a replacement under its exact scope, never an application-global realm. */
	this.set = (descriptor, secret, options = {}) => serialize(() => write(descriptor, secret,
		options.guard || (() => {}), options.validate || (() => {})));

	/** Presence checks do not trigger a keychain unlock just to render Settings. */
	this.has = (descriptor, guard = () => {}) => serialize(async () => {
		const saved = await find(descriptor.realm, descriptor.username)
			|| await find(descriptor.legacyRealm, descriptor.legacyUsername || descriptor.username);
		guard();
		return !!saved;
	});

	/** Logout/clear needs no decryption and affects only this scope, including its legacy copy. */
	this.remove = (descriptor, guard = () => {}) => serialize(async () => {
		const saved = await find(descriptor.realm, descriptor.username);
		guard();
		// Remove the legacy copy first so interruption cannot resurrect it later.
		await removeLegacy(descriptor, guard);
		guard();
		if (saved) await Services.logins.removeLoginAsync(saved);
	});
};
