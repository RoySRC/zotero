/*
    ***** BEGIN LICENSE BLOCK *****

    Copyright (c) 2026

    This file is part of Zotero.

    Zotero is free software: you can redistribute it and/or modify
    it under the terms of the GNU Affero General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    Zotero is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU Affero General Public License for more details.

    You should have received a copy of the GNU Affero General Public License
    along with Zotero.  If not, see <http://www.gnu.org/licenses/>.

    ***** END LICENSE BLOCK *****
*/

if (!Zotero.Sync) {
	Zotero.Sync = {};
}

/**
 * Metadata-sync backend selection.
 *
 * EpiLib syncs metadata only with its PostgreSQL-backed API server.
 * WebDAV profiles remain file-storage backends.
 */
Zotero.Sync.Metadata = {
	BACKEND_ZOTERO: 'zotero',
	BACKEND_POSTGRESQL: 'postgresql',

	_backendPref: 'sync.metadata.backend',
	_postgreSQLURLPref: 'sync.metadata.postgresql.url',
	_loginManagerHost: 'chrome://zotero',
	_loginManagerRealm: 'Zotero PostgreSQL Metadata Server API Key',
	_loginManagerUsername: 'postgresql-metadata',
	_legacyCredentialScopePref: 'sync.metadata.postgresql.legacyCredentialScope',
	_credentialRevision: 0,

	getBackend() {
		// Ignore legacy backend preferences without changing local library data.
		return this.BACKEND_POSTGRESQL;
	},

	isPostgreSQLSyncEnabled() {
		return this.getBackend() == this.BACKEND_POSTGRESQL;
	},

	getPostgreSQLBaseURL() {
		let url = `${Zotero.Prefs.get(this._postgreSQLURLPref) || ''}`.trim();
		if (!url) {
			return '';
		}
		return this.normalizePostgreSQLBaseURL(url);
	},

	async configurePostgreSQL(options = {}) {
		this.pinLegacyCredentialScope();
		const context = this.getCredentialContext();
		let url = `${options.url || ''}`.trim();
		if (!url) {
			throw new Error("PostgreSQL metadata server URL not provided");
		}
		if (!/^https?:\/\//i.test(url)) {
			throw new Error("PostgreSQL metadata server URL must start with http:// or https://");
		}
		url = this.normalizePostgreSQLBaseURL(url);
		if (options.apiKey !== undefined) {
			const saving = this.setPostgreSQLAPIKey(options.apiKey, { url, userID: options.userID });
			const revision = this._credentialRevision;
			await saving;
			this.assertCredentialContext({ ...context, revision });
		}
		else this._credentialRevision++;
		// Change the active destination only after encrypted persistence succeeds.
		Zotero.Prefs.set(this._backendPref, this.BACKEND_POSTGRESQL);
		Zotero.Prefs.set(this._postgreSQLURLPref, url);
	},

	async loginPostgreSQL(options = {}) {
		const context = this._beginAuthentication();
		let url = this.normalizePostgreSQLBaseURL(`${options.url || ''}`.trim());
		let username = `${options.username || ''}`.trim();
		let password = `${options.password || ''}`;
		if (!username) {
			throw new Error("PostgreSQL metadata username not provided");
		}
		if (!password) {
			throw new Error("PostgreSQL metadata password not provided");
		}

		let response = await this._requestPostgreSQLJSON(
			'POST',
			url + 'auth/login',
			{
				body: JSON.stringify({ username, password }),
				headers: {
					'Content-Type': 'application/json'
				},
				successCodes: [200, 403, 404],
				timeout: 5000
			}
		);
		if (response.status == 403) {
			throw new Error("PostgreSQL metadata server rejected the username or password");
		}
		if (response.status == 404) {
			throw new Error("PostgreSQL metadata server does not provide /auth/login");
		}
		let json = response.json;
		if (!json.apiKey) {
			throw new Error("apiKey not found in PostgreSQL login response");
		}
		if (!json.userID) {
			throw new Error("userID not found in PostgreSQL login response");
		}
		if (!json.username) {
			throw new Error("username not found in PostgreSQL login response");
		}
		this.assertCredentialContext(context);
		await this.configurePostgreSQL({ url, userID: json.userID, apiKey: json.apiKey });
		return json;
	},

	async registerPostgreSQL(options = {}) {
		const context = this._beginAuthentication();
		let url = this.normalizePostgreSQLBaseURL(`${options.url || ''}`.trim());
		let username = `${options.username || ''}`.trim();
		let password = `${options.password || ''}`;
		let displayName = `${options.displayName || username}`.trim();
		if (!username) {
			throw new Error("PostgreSQL metadata username not provided");
		}
		if (!password) {
			throw new Error("PostgreSQL metadata password not provided");
		}

		let headers = {
			'Content-Type': 'application/json'
		};
		let apiKey = await this.getPostgreSQLAPIKey({ url });
		this.assertCredentialContext(context);
		if (apiKey) {
			headers['Zotero-API-Key'] = apiKey;
		}
		let response = await this._requestPostgreSQLJSON(
			'POST',
			url + 'auth/register',
			{
				body: JSON.stringify({ username, password, displayName }),
				headers,
				successCodes: [201, 400, 403, 404, 409],
				timeout: 5000
			}
		);
		if (response.status == 400 || response.status == 403 || response.status == 409) {
			throw new Error(
				response.json && response.json.message
					? response.json.message
					: "PostgreSQL metadata server rejected the account creation request"
			);
		}
		if (response.status == 404) {
			throw new Error("PostgreSQL metadata server does not provide /auth/register");
		}
		let json = response.json;
		if (!json.apiKey) {
			throw new Error("apiKey not found in PostgreSQL account creation response");
		}
		if (!json.userID) {
			throw new Error("userID not found in PostgreSQL account creation response");
		}
		if (!json.username) {
			throw new Error("username not found in PostgreSQL account creation response");
		}
		this.assertCredentialContext(context);
		await this.configurePostgreSQL({ url, userID: json.userID, apiKey: json.apiKey });
		return json;
	},

	async resetPostgreSQLPassword(options = {}) {
		const context = this._beginAuthentication();
		let url = this.normalizePostgreSQLBaseURL(`${options.url || ''}`.trim());
		let username = `${options.username || ''}`.trim();
		let oldPassword = `${options.oldPassword || ''}`;
		let newPassword = `${options.newPassword || ''}`;
		if (!username) {
			throw new Error("PostgreSQL metadata username not provided");
		}
		if (!oldPassword) {
			throw new Error("PostgreSQL metadata current password not provided");
		}
		if (!newPassword) {
			throw new Error("PostgreSQL metadata new password not provided");
		}

		let response = await this._requestPostgreSQLJSON(
			'POST',
			url + 'auth/password',
			{
				body: JSON.stringify({ username, oldPassword, newPassword }),
				headers: {
					'Content-Type': 'application/json'
				},
				successCodes: [200, 400, 403, 404],
				timeout: 5000
			}
		);
		if (response.status == 400 || response.status == 403) {
			throw new Error(
				response.json && response.json.message
					? response.json.message
					: "PostgreSQL metadata server rejected the password reset request"
			);
		}
		if (response.status == 404) {
			throw new Error("PostgreSQL metadata server does not provide /auth/password");
		}
		let json = response.json;
		if (!json.apiKey) {
			throw new Error("apiKey not found in PostgreSQL password reset response");
		}
		if (!json.userID) {
			throw new Error("userID not found in PostgreSQL password reset response");
		}
		if (!json.username) {
			throw new Error("username not found in PostgreSQL password reset response");
		}
		this.assertCredentialContext(context);
		await this.configurePostgreSQL({ url, userID: json.userID, apiKey: json.apiKey });
		return json;
	},

	async getLocalSyncSettings() {
		let settings = await Zotero.Sync.Storage.Profiles.getSyncSettingsBundle({
			includeSecrets: true
		});
		settings.metadata = {
			backend: this.BACKEND_POSTGRESQL,
			url: this.getPostgreSQLBaseURL()
		};
		return settings;
	},

	async fetchPostgreSQLSyncSettings(options = {}) {
		const context = this.getCredentialContext();
		let url = options.url
			? this.normalizePostgreSQLBaseURL(options.url)
			: this.getPostgreSQLBaseURL();
		let apiKey = options.apiKey !== undefined
			? options.apiKey
			: await this.getPostgreSQLAPIKey({ url, userID: options.userID });
		this.assertCredentialContext(context);
		if (!url || !apiKey) {
			return null;
		}
		let response = await this._requestPostgreSQLJSON(
			'GET',
			url + 'sync/settings',
			{
				headers: {
					'Zotero-API-Key': apiKey
				},
				successCodes: [200, 403, 404],
				timeout: 5000
			}
		);
		if (response.status != 200) {
			return null;
		}
		return response.json;
	},

		async savePostgreSQLSyncSettings(settings = null) {
			const context = this.getCredentialContext();
			let url = this.getPostgreSQLBaseURL();
			let apiKey = await this.getPostgreSQLAPIKey({ url });
			if (!url || !apiKey) return false;
			const body = JSON.stringify(settings || await this.getLocalSyncSettings());
			this.assertCredentialContext(context);
		await Zotero.HTTP.request(
			'PUT',
			url + 'sync/settings',
			{
				body,
				headers: {
					'Content-Type': 'application/json',
					'Zotero-API-Key': apiKey
				},
				successCodes: [204],
				timeout: 5000, anon: true, followRedirects: false, logBodyLength: 0, debug: false
			}
		);
			return true;
		},


		async listPostgreSQLUsers() {
			let { url, apiKey } = await this._getPostgreSQLRequestContext();
			let response = await this._requestPostgreSQLJSON(
				'GET',
				url + 'users',
				{
					headers: {
						'Zotero-API-Key': apiKey
					},
					successCodes: [200, 403, 404],
					timeout: 5000
				}
			);
			if (response.status == 403) {
				throw new Error("PostgreSQL metadata server rejected the saved API key");
			}
			if (response.status == 404) {
				throw new Error("PostgreSQL metadata server does not provide /users");
			}
			return Array.isArray(response.json) ? response.json : [];
		},


		async createPostgreSQLGroupLibrary(options = {}) {
			let name = `${options.name || ''}`.trim();
			let ownerUserID = parseInt(options.ownerUserID, 10);
			let memberUserIDs = Array.isArray(options.memberUserIDs)
				? options.memberUserIDs.map(id => parseInt(id, 10)).filter(Boolean)
				: [];
			if (!name) {
				throw new Error("Library name not provided");
			}
			if (!ownerUserID) {
				throw new Error("Library owner not provided");
			}
			let { url, apiKey } = await this._getPostgreSQLRequestContext();
			let response = await this._requestPostgreSQLJSON(
				'POST',
				url + 'libraries/groups',
				{
					body: JSON.stringify({ name, ownerUserID, memberUserIDs }),
					headers: {
						'Content-Type': 'application/json',
						'Zotero-API-Key': apiKey
					},
					successCodes: [201, 400, 403, 404, 409],
					timeout: 10000
				}
			);
			if (response.status != 201) {
				throw new Error(
					response.json && response.json.message
						? response.json.message
						: "PostgreSQL metadata server rejected the library creation request"
				);
			}
			return response.json;
		},


		async getPostgreSQLGroupLibrary(groupID) {
			groupID = parseInt(groupID, 10);
			if (!groupID) {
				throw new Error("Library ID not provided");
			}
			let { url, apiKey } = await this._getPostgreSQLRequestContext();
			let response = await this._requestPostgreSQLJSON(
				'GET',
				url + `groups/${groupID}`,
				{
					headers: {
						'Zotero-API-Key': apiKey
					},
					successCodes: [200, 403, 404],
					timeout: 10000
				}
			);
			if (response.status != 200) {
				throw new Error(
					response.json && response.json.message
						? response.json.message
						: "PostgreSQL metadata server rejected the library settings request"
				);
			}
			return response.json;
		},


		async updatePostgreSQLGroupLibraryMembers(options = {}) {
			let groupID = parseInt(options.groupID, 10);
			let memberUserIDs = Array.isArray(options.memberUserIDs)
				? options.memberUserIDs.map(id => parseInt(id, 10)).filter(Boolean)
				: [];
			if (!groupID) {
				throw new Error("Library ID not provided");
			}
			if (!memberUserIDs.length) {
				throw new Error("At least one library member is required");
			}
			let { url, apiKey } = await this._getPostgreSQLRequestContext();
			let response = await this._requestPostgreSQLJSON(
				'PUT',
				url + `libraries/groups/${groupID}/members`,
				{
					body: JSON.stringify({ memberUserIDs }),
					headers: {
						'Content-Type': 'application/json',
						'Zotero-API-Key': apiKey
					},
					successCodes: [200, 400, 403, 404, 409],
					timeout: 10000
				}
			);
			if (response.status != 200) {
				throw new Error(
					response.json && response.json.message
						? response.json.message
						: "PostgreSQL metadata server rejected the library member update request"
				);
			}
			return response.json;
		},


		async savePostgreSQLGroupLibraryResponse(response) {
			if (!response || !response.id || !response.data) {
				throw new Error("PostgreSQL metadata server returned invalid group library data");
			}
			let groupID = parseInt(response.id, 10);
			let version = parseInt(response.version, 10);
			if (!groupID || !(version >= 0)) {
				throw new Error("PostgreSQL metadata server returned invalid group library identifiers");
			}

			let group = Zotero.Groups.get(groupID);
			if (!group) {
				group = new Zotero.Group;
				group.id = groupID;
			}
			if (group.version === undefined || version >= group.version) {
				group.version = version;
			}
			group.archived = false;
			group.fromJSON(response.data, Zotero.Users.getCurrentUserID());
			await group.saveTx();
			return group;
		},


		async safelyDeletePostgreSQLGroupLibrary(options = {}) {
			let groupID = parseInt(options.groupID, 10);
			let newOwnerUserID = parseInt(options.newOwnerUserID, 10);
			let memberUserIDs = Array.isArray(options.memberUserIDs)
				? options.memberUserIDs.map(id => parseInt(id, 10)).filter(Boolean)
				: [];
			if (!groupID) {
				throw new Error("Library ID not provided");
			}
			if (!newOwnerUserID) {
				throw new Error("Replacement owner not provided");
			}
			let { url, apiKey } = await this._getPostgreSQLRequestContext();
			let response = await this._requestPostgreSQLJSON(
				'POST',
				url + `libraries/groups/${groupID}/safe-delete`,
				{
					body: JSON.stringify({ newOwnerUserID, memberUserIDs }),
					headers: {
						'Content-Type': 'application/json',
						'Zotero-API-Key': apiKey
					},
					successCodes: [200, 400, 403, 404, 409],
					timeout: 10000
				}
			);
			if (response.status != 200) {
				throw new Error(
					response.json && response.json.message
						? response.json.message
						: "PostgreSQL metadata server rejected the safe library deletion request"
				);
			}
			return response.json;
		},


		async applyPostgreSQLSyncSettings(settings) {
			if (!settings || typeof settings != 'object') {
				return false;
		}
		await Zotero.Sync.Storage.Profiles.applySyncSettingsBundle(settings);
		return true;
	},

	async disablePostgreSQL() {
		await this.clearPostgreSQLAPIKey();
		Zotero.Prefs.set(this._backendPref, this.BACKEND_POSTGRESQL);
		Zotero.Prefs.clear(this._postgreSQLURLPref);
	},

	/** Nonsecret snapshot used to reject late login, unlock or request continuations. */
	getCredentialContext() {
		return { url: Zotero.Prefs.get(this._postgreSQLURLPref) || '',
			userID: Zotero.Users.getCurrentUserID() || null, revision: this._credentialRevision };
	},

	assertCredentialContext(context) {
		if (JSON.stringify(context) != JSON.stringify(this.getCredentialContext())) {
			throw new Error('Metadata server or account changed; please try again');
		}
	},

	/** Invalidate pending unlocks/authentication before starting a new login attempt. */
	_beginAuthentication() {
		this.pinLegacyCredentialScope();
		this._credentialRevision++;
		return this.getCredentialContext();
	},

	/** Canonical URL (including path) plus the server's user ID identifies one token. */
	getPostgreSQLCredentialScope(options = {}) {
		const url = options.url !== undefined ? options.url : this.getPostgreSQLBaseURL();
		const userID = options.userID !== undefined ? options.userID : Zotero.Users.getCurrentUserID();
		if (!url || !userID) return null;
		if (!Number.isSafeInteger(Number(userID)) || Number(userID) <= 0) throw new Error('Invalid metadata account user ID');
		return { url: this.normalizePostgreSQLBaseURL(url), userID: Number(userID) };
	},

	/**
	 * The old global login has no provenance. Pin its one possible owner at startup,
	 * before Settings can change the destination. Never infer a new owner later.
	 * Missing/invalid identity is recorded as null and requires a fresh login.
	 */
	pinLegacyCredentialScope() {
		if (Zotero.Prefs.get(this._legacyCredentialScopePref) !== undefined) return;
		let scope = null;
		try { scope = this.getPostgreSQLCredentialScope(); }
		catch (_) { /* Do not guess a destination for an unscoped secret. */ }
		Zotero.Prefs.set(this._legacyCredentialScopePref, JSON.stringify(scope));
	},

	/** A legacy login is eligible only for the pinned original server/user pair. */
	_credentialDescriptor(scope) {
		this.pinLegacyCredentialScope();
		let legacy;
		try { legacy = JSON.parse(Zotero.Prefs.get(this._legacyCredentialScopePref)); }
		catch (_) { legacy = null; }
		return { realm: 'EpiLib PostgreSQL account token v1: ' + JSON.stringify([scope.url, scope.userID]),
			username: this._loginManagerUsername,
			legacyRealm: JSON.stringify(legacy) == JSON.stringify(scope) ? this._loginManagerRealm : null };
	},

	/** Reject malformed secrets without putting their contents in an error message. */
	_validateAPIKey(value) {
		if (typeof value != 'string' || !value || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) {
			throw new Error('Invalid metadata account token');
		}
	},

	/** Confirm the old unscoped token's user before assigning it a permanent identity. */
	async _verifyLegacyCredentialIdentity(scope, apiKey) {
		let response;
		try {
			response = await this._requestPostgreSQLJSON('GET', scope.url + 'keys/current', {
				headers: { 'Zotero-API-Key': apiKey }, successCodes: [200, 403, 404],
				timeout: 5000, errorDelayMax: 0
			});
		}
		catch (_) {
			throw new Error('Cannot verify the legacy account token. It has been preserved; reconnect or log in again.');
		}
		if (response.status != 200 || Number(response.json?.userID) !== scope.userID) {
			throw new Error('Legacy account token identity could not be confirmed. The saved credential was preserved; log in again.');
		}
	},

	/** Lazy, verified migration; never return plaintext when OS encryption fails. */
	async getPostgreSQLAPIKey(options = {}) {
		const scope = this.getPostgreSQLCredentialScope(options);
		if (!scope) return null;
		const context = this.getCredentialContext();
		return Zotero.CredentialStore.get(this._credentialDescriptor(scope), {
			guard: () => this.assertCredentialContext(context), validate: this._validateAPIKey,
			authorizeLegacy: key => this._verifyLegacyCredentialIdentity(scope, key)
		});
	},

	async hasPostgreSQLAPIKey(options = {}) {
		const scope = this.getPostgreSQLCredentialScope(options);
		if (!scope) return false;
		const context = this.getCredentialContext();
		return Zotero.CredentialStore.has(this._credentialDescriptor(scope), () => this.assertCredentialContext(context));
	},

	/** Login callers pass the authenticated response's user ID, not the old local user. */
	async setPostgreSQLAPIKey(apiKey, options = {}) {
		if (apiKey === null || apiKey === undefined || apiKey === '') return this.clearPostgreSQLAPIKey(options);
		const scope = this.getPostgreSQLCredentialScope(options);
		if (!scope) throw new Error('Metadata token requires a server URL and authenticated user ID');
		this._credentialRevision++;
		const context = this.getCredentialContext();
		return Zotero.CredentialStore.set(this._credentialDescriptor(scope), apiKey, {
			guard: () => this.assertCredentialContext(context), validate: this._validateAPIKey
		});
	},

	/** Logout is scoped; tokens for other servers/users remain available. */
	async clearPostgreSQLAPIKey(options = {}) {
		const scope = this.getPostgreSQLCredentialScope(options);
		this._credentialRevision++;
		if (!scope) return;
		const context = this.getCredentialContext();
		return Zotero.CredentialStore.remove(this._credentialDescriptor(scope), () => this.assertCredentialContext(context));
	},

	normalizePostgreSQLBaseURL(url) {
		url = url.trim();
		let parsedURL = new URL(url);
		if (parsedURL.username || parsedURL.password || parsedURL.search || parsedURL.hash) {
			throw new Error('Metadata server URL cannot contain credentials, a query, or a fragment');
		}
		if (!['http:', 'https:'].includes(parsedURL.protocol)) {
			throw new Error("PostgreSQL metadata server URL must start with http:// or https://");
		}
		let host = parsedURL.hostname.toLowerCase().replace(/\.$/, '');
		if (host == 'zotero.org' || host.endsWith('.zotero.org')
				|| host == 'zotero.net' || host.endsWith('.zotero.net')) {
			throw new Error("Zotero account sync is not supported in EpiLib. Configure your PostgreSQL metadata server.");
		}
		let reservedLocalPort = `${Zotero.Prefs.get('httpServer.port') || 23119}`;
		let hostname = parsedURL.hostname.toLowerCase();
		if ((hostname == 'localhost' || hostname == '127.0.0.1' || hostname == '[::1]')
				&& parsedURL.port == reservedLocalPort) {
			throw new Error(
				`Port ${reservedLocalPort} is reserved for Zotero's local API. `
				+ `Use a different PostgreSQL metadata server port, such as 23129.`
			);
		}
		let path = parsedURL.pathname.replace(/\/+$/, '');
		if (path.endsWith('/health')) {
			parsedURL.pathname = path.replace(/\/?health$/, '/') || '/';
			parsedURL.search = '';
			parsedURL.hash = '';
			url = parsedURL.href;
		}
		parsedURL.hostname = host;
		parsedURL.pathname = parsedURL.pathname.replace(/\/+$/, '') + '/';
		return parsedURL.href;
	},

		async _requestPostgreSQLJSON(method, uri, options = {}) {
			let req = await Zotero.HTTP.request(method, uri, Object.assign({}, options, {
				responseType: 'text', anon: true, followRedirects: false, logBodyLength: 0, debug: false
		}));
		let responseText = req.responseText || '';
		let json;
		try {
			json = responseText ? JSON.parse(responseText) : null;
		}
		catch (e) {
			throw new Error(
				`The PostgreSQL metadata server did not return JSON. `
				+ `Request: ${uri}. Status: ${req.status}.`
			);
			}
			return { status: req.status, json };
		},


		async _getPostgreSQLRequestContext() {
			const context = this.getCredentialContext();
			let url = this.getPostgreSQLBaseURL();
			let apiKey = await this.getPostgreSQLAPIKey({ url });
			this.assertCredentialContext(context);
			if (!url) {
				throw new Error("PostgreSQL metadata server URL not set");
			}
			if (!apiKey) {
				throw new Error("Log in to the PostgreSQL metadata server first");
			}
			return { url, apiKey };
		}
};
