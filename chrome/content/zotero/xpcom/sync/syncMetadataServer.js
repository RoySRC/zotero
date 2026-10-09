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
 * WebDAV profiles remain file-storage backends. Metadata sync can use the
 * standard zotero.org API or a self-hosted PostgreSQL-backed API server that
 * implements the Zotero sync API surface used by Zotero.Sync.APIClient.
 */
Zotero.Sync.Metadata = {
	BACKEND_ZOTERO: 'zotero',
	BACKEND_POSTGRESQL: 'postgresql',

	_backendPref: 'sync.metadata.backend',
	_postgreSQLURLPref: 'sync.metadata.postgresql.url',
	_loginManagerHost: 'chrome://zotero',
	_loginManagerRealm: 'Zotero PostgreSQL Metadata Server API Key',
	_loginManagerUsername: 'postgresql-metadata',

	getBackend() {
		let backend = Zotero.Prefs.get(this._backendPref) || this.BACKEND_ZOTERO;
		return backend == this.BACKEND_POSTGRESQL ? backend : this.BACKEND_ZOTERO;
	},

	isPostgreSQLSyncEnabled() {
		return this.getBackend() == this.BACKEND_POSTGRESQL;
	},

	getPostgreSQLBaseURL() {
		let url = `${Zotero.Prefs.get(this._postgreSQLURLPref) || ''}`.trim();
		if (!url) {
			return '';
		}
		return url.endsWith('/') ? url : url + '/';
	},

	async configurePostgreSQL(options = {}) {
		let url = `${options.url || ''}`.trim();
		if (!url) {
			throw new Error("PostgreSQL metadata server URL not provided");
		}
		if (!/^https?:\/\//i.test(url)) {
			throw new Error("PostgreSQL metadata server URL must start with http:// or https://");
		}
		Zotero.Prefs.set(this._backendPref, this.BACKEND_POSTGRESQL);
		Zotero.Prefs.set(this._postgreSQLURLPref, this.normalizePostgreSQLBaseURL(url));
		if (options.apiKey !== undefined) {
			await this.setPostgreSQLAPIKey(options.apiKey);
		}
	},

	async loginPostgreSQL(options = {}) {
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
		await this.configurePostgreSQL({ url, apiKey: json.apiKey });
		return json;
	},

	async registerPostgreSQL(options = {}) {
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
		let apiKey = await this.getPostgreSQLAPIKey();
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
		await this.configurePostgreSQL({ url, apiKey: json.apiKey });
		return json;
	},

	async resetPostgreSQLPassword(options = {}) {
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
		await this.configurePostgreSQL({ url, apiKey: json.apiKey });
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
		let url = options.url
			? this.normalizePostgreSQLBaseURL(options.url)
			: this.getPostgreSQLBaseURL();
		let apiKey = options.apiKey !== undefined
			? options.apiKey
			: await this.getPostgreSQLAPIKey();
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
			let url = this.getPostgreSQLBaseURL();
			let apiKey = await this.getPostgreSQLAPIKey();
		if (!url || !apiKey) {
			return false;
		}
		await Zotero.HTTP.request(
			'PUT',
			url + 'sync/settings',
			{
				body: JSON.stringify(settings || await this.getLocalSyncSettings()),
				headers: {
					'Content-Type': 'application/json',
					'Zotero-API-Key': apiKey
				},
				successCodes: [204],
				timeout: 5000
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
		Zotero.Prefs.set(this._backendPref, this.BACKEND_ZOTERO);
		Zotero.Prefs.clear(this._postgreSQLURLPref);
		await this.clearPostgreSQLAPIKey();
	},

	async getPostgreSQLAPIKey() {
		let login = await this._getPostgreSQLLoginInfo();
		return login ? login.password : null;
	},

	async hasPostgreSQLAPIKey() {
		return !!(await this._getPostgreSQLLoginInfo());
	},

	async setPostgreSQLAPIKey(apiKey) {
		apiKey = `${apiKey || ''}`;
		let oldLoginInfo = await this._getPostgreSQLLoginInfo();
		if (!apiKey) {
			if (oldLoginInfo) {
				await Services.logins.removeLoginAsync(oldLoginInfo);
			}
			return;
		}

		let nsLoginInfo = new Components.Constructor(
			"@mozilla.org/login-manager/loginInfo;1",
			Components.interfaces.nsILoginInfo,
			"init"
		);
		let loginInfo = new nsLoginInfo(
			this._loginManagerHost,
			null,
			this._loginManagerRealm,
			this._loginManagerUsername,
			apiKey,
			"",
			""
		);

		if (oldLoginInfo) {
			await Services.logins.modifyLoginAsync(oldLoginInfo, loginInfo);
		}
		else {
			await Services.logins.addLoginAsync(loginInfo);
		}
	},

	async clearPostgreSQLAPIKey() {
		let login = await this._getPostgreSQLLoginInfo();
		if (login) {
			await Services.logins.removeLoginAsync(login);
		}
	},

	normalizePostgreSQLBaseURL(url) {
		url = url.trim();
		let parsedURL = new URL(url);
		let reservedLocalPort = `${Zotero.Prefs.get('httpServer.port') || 23119}`;
		let hostname = parsedURL.hostname.toLowerCase();
		if ((hostname == 'localhost' || hostname == '127.0.0.1' || hostname == '::1')
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
		return url.endsWith('/') ? url : url + '/';
	},

		async _requestPostgreSQLJSON(method, uri, options = {}) {
			let req = await Zotero.HTTP.request(method, uri, Object.assign({}, options, {
				responseType: 'text'
		}));
		let responseText = req.responseText || '';
		let json;
		try {
			json = responseText ? JSON.parse(responseText) : null;
		}
		catch (e) {
			let preview = responseText.replace(/\s+/g, ' ').trim().slice(0, 180);
			throw new Error(
				`The PostgreSQL metadata server did not return JSON. `
				+ `Request: ${uri}. Status: ${req.status}. Response: ${preview}`
			);
			}
			return { status: req.status, json };
		},


		async _getPostgreSQLRequestContext() {
			let url = this.getPostgreSQLBaseURL();
			let apiKey = await this.getPostgreSQLAPIKey();
			if (!url) {
				throw new Error("PostgreSQL metadata server URL not set");
			}
			if (!apiKey) {
				throw new Error("Log in to the PostgreSQL metadata server first");
			}
			return { url, apiKey };
		},


		async _getPostgreSQLLoginInfo() {
			let logins = await Services.logins.searchLoginsAsync({
				origin: this._loginManagerHost,
			httpRealm: this._loginManagerRealm
		});
		return logins.find(login => login.username == this._loginManagerUsername) || false;
	}
};
