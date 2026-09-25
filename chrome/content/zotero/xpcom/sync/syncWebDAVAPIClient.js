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
 * Experimental metadata-sync client backed by a WebDAV profile.
 *
 * This intentionally mirrors the subset of Zotero.Sync.APIClient used by
 * Zotero.Sync.Data.Engine. It stores API-style object JSON under a per-library
 * metadata root and commits version changes via a manifest.
 */
Zotero.Sync.WebDAVAPIClient = function (options) {
	if (!options) {
		throw new Error("Options not provided");
	}
	if (options.libraryID === undefined) {
		throw new Error("libraryID not set");
	}
	if (!options.profileID) {
		throw new Error("profileID not set");
	}

	this.libraryID = options.libraryID;
	this.library = Zotero.Libraries.get(this.libraryID);
	this.libraryKey = Zotero.Sync.Storage.Profiles._getLibraryProfileKey(this.libraryID);
	this.profileID = Zotero.Sync.Storage.Profiles._normalizeProfileID(options.profileID);
	this.schemaVersion = options.schemaVersion || Zotero.Schema.globalSchemaVersion;
	this.userID = options.userID || Zotero.Users.getCurrentUserID() || 1;
	this.username = options.username || Zotero.Users.getCurrentUsername() || "webdav";
	this.caller = options.caller || { start: async fn => fn(), pause: () => {} };
	this.cancellerReceiver = options.cancellerReceiver;

	this._controller = null;
	this._directoriesEnsured = false;
};

Zotero.Sync.WebDAVAPIClient.prototype = {
	MAX_OBJECTS_PER_REQUEST: 100,
	UPLOAD_TIMEOUT: 120000,
	MANIFEST_SCHEMA: 1,

	_METADATA_ROOT: "metadata/v1/libraries",

	async getKeyInfo() {
		return {
			userID: this.userID,
			username: this.username,
			displayName: this.username,
			emails: [],
			access: {
				user: {
					library: true,
					notes: true,
					write: true,
					files: true
				},
				groups: {
					all: {
						library: true,
						write: true,
						files: true
					}
				}
			}
		};
	},

	async getSettings(_libraryType, _libraryTypeID, since) {
		let { manifest } = await this._readManifest();
		if (since && manifest.libraryVersion <= since) {
			return false;
		}

		return {
			libraryVersion: manifest.libraryVersion,
			settings: this._filterVersionedMap(manifest.settings, since)
		};
	},

	async getDeleted(_libraryType, _libraryTypeID, since) {
		let { manifest } = await this._readManifest();
		let deleted = {};
		for (let objectTypePlural of this._getSyncedObjectTypePlurals()) {
			deleted[objectTypePlural] = this._filterDeletedKeys(manifest, objectTypePlural, since);
		}
		deleted.settings = this._filterDeletedKeys(manifest, "settings", since);

		return {
			libraryVersion: manifest.libraryVersion,
			deleted
		};
	},

	async getKeys(_libraryType, _libraryTypeID, queryParams = {}) {
		let { manifest } = await this._readManifest();
		let keys = [];

		let collectionItems = queryParams.target
			&& queryParams.target.match(/^collections\/([^/]+)\/items(?:\/top)?$/);
		if (collectionItems) {
			let collectionKey = decodeURIComponent(collectionItems[1]);
			let itemKeys = Object.keys(manifest.objects.items || {});
			let json = await this._getObjects("item", itemKeys);
			keys = json
				.filter((obj) => {
					let data = obj.data || {};
					if (!data.collections || !data.collections.includes(collectionKey)) {
						return false;
					}
					return !queryParams.target.endsWith("/top") || !data.parentItem;
				})
				.map(obj => obj.key);
		}
		else if (queryParams.target) {
			let objectTypePlural = queryParams.target.split("/")[0];
			keys = Object.keys(manifest.objects[objectTypePlural] || {});
		}

		return {
			libraryVersion: manifest.libraryVersion,
			keys
		};
	},

	async getVersions(_libraryType, _libraryTypeID, objectType, queryParams = {}) {
		let objectTypePlural = Zotero.DataObjectUtilities.getObjectTypePlural(objectType);
		let { manifest } = await this._readManifest();
		let records = manifest.objects[objectTypePlural] || {};
		let versions = this._getVersionMap(records);

		if (queryParams.top && objectType == "item") {
			let json = await this._getObjects(objectType, Object.keys(versions));
			let topKeys = new Set(json.filter(obj => !(obj.data || {}).parentItem).map(obj => obj.key));
			versions = Object.fromEntries(
				Object.entries(versions).filter(([key]) => topKeys.has(key))
			);
		}

		if (queryParams.since) {
			versions = this._filterVersionedMap(versions, queryParams.since);
		}

		return {
			libraryVersion: manifest.libraryVersion,
			versions
		};
	},

	downloadObjects(libraryType, libraryTypeID, objectType, objectKeys) {
		if (!objectKeys.length) {
			return [];
		}

		if (objectKeys.length > this.MAX_OBJECTS_PER_REQUEST) {
			let allKeys = objectKeys.concat();
			let promises = [];
			while (allKeys.length) {
				let requestKeys = allKeys.splice(0, this.MAX_OBJECTS_PER_REQUEST);
				promises.push(...this.downloadObjects(
					libraryType,
					libraryTypeID,
					objectType,
					requestKeys
				));
			}
			return promises;
		}

		return [
			this._getObjects(objectType, objectKeys)
				.then(json => ({ keys: objectKeys, json }))
				.catch((e) => {
					Zotero.logError(e);
					if (e instanceof Zotero.HTTP.UnexpectedStatusException && e.is4xx()) {
						throw e;
					}
					return {
						keys: objectKeys,
						error: e
					};
				})
		];
	},

	async deleteSettings(_libraryType, _libraryTypeID, libraryVersion, keys) {
		return this._updateManifest(libraryVersion, async (manifest) => {
			let newVersion = manifest.libraryVersion + 1;
			for (let key of keys) {
				delete manifest.settings[key];
				manifest.deleted.settings[key] = newVersion;
			}
			manifest.libraryVersion = newVersion;
			return newVersion;
		});
	},

	async uploadSettings(_libraryType, _libraryTypeID, libraryVersion, settings) {
		return this._updateManifest(libraryVersion, async (manifest) => {
			let newVersion = manifest.libraryVersion + 1;
			for (let [key, setting] of Object.entries(settings)) {
				manifest.settings[key] = {
					value: setting.value,
					version: newVersion
				};
				delete manifest.deleted.settings[key];
			}
			manifest.libraryVersion = newVersion;
			return {
				libraryVersion: newVersion,
				results: null
			};
		});
	},

	async uploadObjects(_libraryType, _libraryTypeID, method, libraryVersion, objectType, objects) {
		if (method != "POST" && method != "PATCH") {
			throw new Error(`Invalid method '${method}'`);
		}

		let objectTypePlural = Zotero.DataObjectUtilities.getObjectTypePlural(objectType);
		return this._updateManifest(libraryVersion, async (manifest) => {
			let newVersion = manifest.libraryVersion + 1;
			let successful = {};
			let failed = {};
			for (let index in objects) {
				let object = objects[index];
				let existingRecord = manifest.objects[objectTypePlural][object.key];
				let conflict = await this._getObjectUploadConflict(
					objectType,
					object,
					existingRecord,
					manifest.deleted[objectTypePlural][object.key]
				);
				if (conflict) {
					failed[index] = conflict;
					continue;
				}

				let responseJSON = await this._getUploadResponseJSON(
					objectType,
					object,
					existingRecord,
					newVersion
				);
				let path = this._getObjectPayloadPath(objectType, object.key, newVersion);
				await this._ensureObjectDirectory(objectType, object.key);
				await this._putJSON(path, responseJSON, { ifNoneMatch: true });
				manifest.objects[objectTypePlural][object.key] = {
					version: newVersion,
					path
				};
				delete manifest.deleted[objectTypePlural][object.key];
				successful[index] = responseJSON;
			}
			if (Object.keys(successful).length) {
				manifest.libraryVersion = newVersion;
			}
			return {
				libraryVersion: manifest.libraryVersion,
				results: {
					successful,
					unchanged: {},
					failed
				}
			};
		});
	},

	async uploadDeletions(_libraryType, _libraryTypeID, libraryVersion, objectType, keys) {
		let objectTypePlural = Zotero.DataObjectUtilities.getObjectTypePlural(objectType);
		let filesToDelete = [];
		return this._updateManifest(libraryVersion, async (manifest, postCommit) => {
			let newVersion = manifest.libraryVersion + 1;
			for (let key of keys) {
				let record = manifest.objects[objectTypePlural][key];
				delete manifest.objects[objectTypePlural][key];
				manifest.deleted[objectTypePlural][key] = newVersion;
				let path = this._getObjectRecordPath(objectType, key, record);
				if (path) {
					filesToDelete.push(path);
				}
			}
			postCommit.push(async () => this._deleteJSONFiles(filesToDelete));
			manifest.libraryVersion = newVersion;
			return newVersion;
		});
	},

	// Full-text syncing remains out of scope for WebDAV metadata sync for now.
	async getFullTextVersions() {
		return {
			libraryVersion: (await this._readManifest()).manifest.libraryVersion,
			versions: {}
		};
	},

	async getFullTextForItem() {
		return false;
	},

	async setFullTextForItems(_libraryType, _libraryTypeID, libraryVersion) {
		return {
			libraryVersion,
			results: {
				successful: {},
				unchanged: {},
				failed: {}
			}
		};
	},

	async _ensureInitialized() {
		if (this._controller) {
			return;
		}

		this._controller = new Zotero.Sync.Storage.Mode.WebDAV({
			libraryID: this.libraryID,
			profileID: this.profileID
		});
		await this._controller._init();
		await this._controller.cacheCredentials();
	},

	async _ensureMetadataDirectories() {
		if (this._directoriesEnsured) {
			return;
		}
		await this._ensureInitialized();

		let paths = [
			"metadata/",
			"metadata/v1/",
			`${this._METADATA_ROOT}/`,
			`${this._METADATA_ROOT}/${encodeURIComponent(this.libraryKey)}/`,
			`${this._METADATA_ROOT}/${encodeURIComponent(this.libraryKey)}/objects/`
		];
		for (let objectTypePlural of this._getSyncedObjectTypePlurals()) {
			paths.push(
				`${this._METADATA_ROOT}/${encodeURIComponent(this.libraryKey)}/objects/`
					+ `${objectTypePlural}/`
			);
		}

		for (let path of paths) {
			let uri = this._getRootURI(path);
			await this.makeRequest("MKCOL", uri, {
				successCodes: [201, 405]
			});
		}
		this._directoriesEnsured = true;
	},

	async makeRequest(method, uri, options = {}) {
		await this._ensureInitialized();

		let opts = {};
		Object.assign(opts, options);
		opts.headers = Object.assign(
			{},
			this._controller._getAuthorizationHeaders(method, uri),
			options.headers || {}
		);
		opts.cancellerReceiver = this.cancellerReceiver;
		opts.noCache = !options.cache;
		opts.foreground = !options.background;
		opts.errorDelayIntervals = this._controller.ERROR_DELAY_INTERVALS;
		opts.errorDelayMax = this._controller.ERROR_DELAY_MAX;

		return this.caller.start(async () => {
			try {
				return await Zotero.HTTP.request(method, uri, opts);
			}
			catch (e) {
				if (e instanceof Zotero.HTTP.UnexpectedStatusException && e.status == 401) {
					this._controller._onAuthError();
				}
				throw e;
			}
		});
	},

	async _readManifest() {
		await this._ensureMetadataDirectories();
		let uri = this._getLibraryURI("manifest.json");
		let req = await this.makeRequest("GET", uri, {
			successCodes: [200, 404],
			responseType: "text"
		});

		if (req.status == 404) {
			return {
				manifest: this._newManifest(),
				etag: null
			};
		}

		let manifest = this._parseJSON(req.responseText, "manifest.json");
		this._normalizeManifest(manifest);
		let etag = this._getResponseETag(req) || await this._getResourceETag(uri);
		if (!etag) {
			throw new Error(
				"WebDAV metadata manifest ETag not available; cannot safely sync metadata"
			);
		}
		return {
			manifest,
			etag
		};
	},

	async _writeManifest(manifest, etag) {
		this._normalizeManifest(manifest);
		let headers = {
			"Content-Type": "application/json"
		};
		if (etag) {
			headers["If-Match"] = etag;
		}
		else {
			headers["If-None-Match"] = "*";
		}

		let req = await this.makeRequest("PUT", this._getLibraryURI("manifest.json"), {
			headers,
			body: this._stringifyJSON(manifest),
			successCodes: [200, 201, 204, 412],
			timeout: this.UPLOAD_TIMEOUT
		});
		this._check412(req);
		return this._getResponseETag(req);
	},

	async _updateManifest(libraryVersion, update) {
		let { manifest, etag } = await this._readManifest();
		this._checkLibraryVersion(manifest, libraryVersion);

		let before = this._stringifyJSON(manifest);
		let postCommit = [];
		let result = await update(manifest, postCommit);
		if (this._stringifyJSON(manifest) == before) {
			return result;
		}

		await this._writeManifest(manifest, etag);

		for (let fn of postCommit) {
			try {
				await fn();
			}
			catch (e) {
				Zotero.logError(e);
			}
		}

		return result;
	},

	_checkLibraryVersion(manifest, libraryVersion) {
		libraryVersion = parseInt(libraryVersion || 0);
		if (manifest.libraryVersion != libraryVersion) {
			this._throw412(
				`WebDAV metadata manifest changed (${manifest.libraryVersion} != ${libraryVersion})`
			);
		}
	},

	_check412(req) {
		if (req.status == 412) {
			this._throw412(req.responseText || "WebDAV metadata manifest changed");
		}
	},

	_throw412(message) {
		let xmlhttp = {
			status: 412,
			channel: null,
			responseText: message
		};
		throw new Zotero.HTTP.UnexpectedStatusException(xmlhttp, null, message);
	},

	async _getObjects(objectType, keys) {
		let { manifest } = await this._readManifest();
		let objectTypePlural = Zotero.DataObjectUtilities.getObjectTypePlural(objectType);
		let json = [];
		for (let key of keys) {
			let record = manifest.objects[objectTypePlural][key];
			let path = this._getObjectRecordPath(
				objectType,
				key,
				record
			);
			if (!path) {
				continue;
			}
			let req = await this.makeRequest("GET", this._getLibraryURI(
				path
			), {
				successCodes: [200, 404],
				responseType: "text"
			});
			if (req.status == 404) {
				continue;
			}
			let responseJSON = this._toResponseJSON(
				objectType,
				this._parseJSON(req.responseText, path),
				this._getObjectRecordVersion(record)
			);
			responseJSON = await this._repairResponseJSON(objectType, responseJSON, undefined, {
				skipUnrepairable: true
			});
			if (responseJSON) {
				json.push(responseJSON);
			}
		}
		return json;
	},

	async _putJSON(path, data, options = {}) {
		let headers = {
			"Content-Type": "application/json"
		};
		if (options.ifNoneMatch) {
			headers["If-None-Match"] = "*";
		}
		let req = await this.makeRequest("PUT", this._getLibraryURI(path), {
			headers,
			body: this._stringifyJSON(data),
			successCodes: [200, 201, 204, 412],
			timeout: this.UPLOAD_TIMEOUT
		});
		this._check412(req);
	},

	async _getResourceETag(uri) {
		let req = await this.makeRequest("PROPFIND", uri, {
			body: "<propfind xmlns='DAV:'><prop><getetag/></prop></propfind>",
			headers: {
				Depth: 0,
				"Content-Type": "text/xml; charset=utf-8"
			},
			successCodes: [207, 404]
		});
		if (req.status == 404) {
			return null;
		}

		if (req.responseXML) {
			let etag = Zotero.Utilities.xpathText(
				req.responseXML,
				"/*[local-name()='multistatus']/*[local-name()='response']"
					+ "/*[local-name()='propstat']/*[local-name()='prop']"
					+ "/*[local-name()='getetag']"
			);
			if (etag) {
				return etag.trim();
			}
		}

		let match = (req.responseText || "").match(
			/<(?:[^:>]+:)?getetag[^>]*>([^<]+)<\/(?:[^:>]+:)?getetag>/i
		);
		return match ? match[1].trim() : null;
	},

	_getResponseETag(req) {
		let etag = req.getResponseHeader("ETag");
		return etag ? etag.trim() : null;
	},

	async _getObjectUploadConflict(objectType, object, existingRecord, deletedVersion) {
		let remoteVersion = this._getObjectRecordVersion(existingRecord) || deletedVersion || 0;
		let localVersion = parseInt(object.version || 0);
		if (!remoteVersion) {
			return null;
		}

		if (!localVersion || localVersion < remoteVersion) {
			let data = null;
			if (existingRecord) {
				data = await this._getObjectConflictData(objectType, object.key, existingRecord);
			}
			return {
				code: 412,
				message: `${objectType} ${object.key} has changed on the WebDAV metadata backend`,
				data
			};
		}
		return null;
	},

	async _getObjectConflictData(objectType, key, record) {
		let json = await this._getObjectRecordResponseJSON(objectType, key, record);
		return json ? json.data : null;
	},

	async _getObjectRecordResponseJSON(objectType, key, record) {
		let path = this._getObjectRecordPath(objectType, key, record);
		if (!path) {
			return null;
		}
		let req = await this.makeRequest("GET", this._getLibraryURI(path), {
			successCodes: [200, 404],
			responseType: "text"
		});
		if (req.status == 404) {
			return null;
		}
		return this._toResponseJSON(
			objectType,
			this._parseJSON(req.responseText, path),
			this._getObjectRecordVersion(record)
		);
	},

	async _getUploadResponseJSON(objectType, object, existingRecord, version) {
		let responseJSON = this._toResponseJSON(objectType, object, version);
		if (existingRecord && parseInt(object.version || 0)) {
			let existingJSON = await this._getObjectRecordResponseJSON(
				objectType,
				object.key,
				existingRecord
			);
			if (existingJSON) {
				responseJSON = this._mergeResponseJSON(
					objectType,
					existingJSON,
					responseJSON,
					version
				);
			}
		}

		return this._repairResponseJSON(objectType, responseJSON, version);
	},

	async _repairResponseJSON(objectType, responseJSON, version, options = {}) {
		if (objectType == "item" && !responseJSON.data.itemType) {
			let localJSON = await this._getLocalObjectResponseJSON(
				objectType,
				responseJSON.key,
				version || responseJSON.version
			);
			if (localJSON) {
				responseJSON = this._mergeResponseJSON(
					objectType,
					localJSON,
					responseJSON,
					version || responseJSON.version
				);
			}
		}
		if (objectType == "item" && !responseJSON.data.itemType) {
			let historyJSON = await this._getObjectHistoryResponseJSON(
				objectType,
				responseJSON.key,
				json => !!(json.data && json.data.itemType)
			);
			if (historyJSON) {
				responseJSON = this._mergeResponseJSON(
					objectType,
					historyJSON,
					responseJSON,
					version || responseJSON.version
				);
			}
		}
		if (objectType == "item" && !responseJSON.data.itemType) {
			let attachmentJSON = await this._getStorageAttachmentResponseJSON(
				responseJSON,
				version || responseJSON.version
			);
			if (attachmentJSON) {
				responseJSON = this._mergeResponseJSON(
					objectType,
					attachmentJSON,
					responseJSON,
					version || responseJSON.version
				);
			}
		}
		if (objectType == "item"
				&& responseJSON.data.itemType == "attachment"
				&& !Object.prototype.hasOwnProperty.call(responseJSON.data, "parentItem")) {
			let historyJSON = await this._getObjectHistoryResponseJSON(
				objectType,
				responseJSON.key,
				json => json.data && Object.prototype.hasOwnProperty.call(json.data, "parentItem")
			);
			if (historyJSON) {
				responseJSON = this._mergeResponseJSON(
					objectType,
					historyJSON,
					responseJSON,
					version || responseJSON.version
				);
			}
		}
		if (options.skipUnrepairable && objectType == "item" && !responseJSON.data.itemType) {
			Zotero.logError(
				`Skipping malformed WebDAV metadata item ${this.libraryKey}/${responseJSON.key}: `
					+ "itemType is missing and no repair source was found"
			);
			return null;
		}

		return responseJSON;
	},

	async _getLocalObjectResponseJSON(objectType, key, version) {
		let objectsClass = Zotero.DataObjectUtilities.getObjectsClassForObjectType(objectType);
		let obj = await objectsClass.getByLibraryAndKeyAsync(
			this.libraryID,
			key,
			{ noCache: true }
		);
		if (!obj) {
			return null;
		}
		return this._toResponseJSON(
			objectType,
			await obj.toResponseJSONAsync({ version }),
			version
		);
	},

	async _getStorageAttachmentResponseJSON(responseJSON, version) {
		let data = responseJSON.data || {};
		let key = responseJSON.key || data.key;
		if (!key) {
			return null;
		}
		let metadata = await this._getStorageFileMetadataForKey(key);
		if (!metadata || !metadata.mtime) {
			return null;
		}
		if (!Object.prototype.hasOwnProperty.call(data, "parentItem")) {
			Zotero.logError(
				`Skipping storage-only WebDAV attachment metadata ${this.libraryKey}/${key}: `
					+ "parentItem is missing"
			);
			return null;
		}

		Zotero.debug(
			`Synthesizing attachment metadata for WebDAV-backed item ${this.libraryKey}/${key}`
				+ " from storage .prop data",
			3
		);

		let filename = data.filename || `${key}.pdf`;
		let attachmentData = Object.assign(
			{
				key,
				version: parseInt(version || responseJSON.version || data.version || 0),
				itemType: "attachment",
				linkMode: "imported_file",
				title: data.title || filename,
				contentType: data.contentType || "application/pdf",
				filename,
				mtime: metadata.mtime,
				tags: [],
				collections: [],
				relations: {}
			},
			data
		);
		attachmentData.itemType = "attachment";
		attachmentData.linkMode = attachmentData.linkMode || "imported_file";
		attachmentData.contentType = attachmentData.contentType || "application/pdf";
		attachmentData.filename = attachmentData.filename || filename;
		attachmentData.title = attachmentData.title || attachmentData.filename;
		attachmentData.mtime = attachmentData.mtime || metadata.mtime;
		attachmentData.md5 = attachmentData.md5 || metadata.md5;

		return this._toResponseJSON("item", attachmentData, attachmentData.version);
	},

	async _getStorageFileMetadataForKey(key) {
		await this._ensureInitialized();
		let item = {
			key,
			libraryKey: `${this.libraryKey}/${key}`
		};
		let request = {
			setChannel() {}
		};
		try {
			return await this._controller._getStorageFileMetadata(item, request);
		}
		catch (e) {
			Zotero.logError(e);
			return null;
		}
	},

	async _getObjectHistoryResponseJSON(objectType, key, predicate) {
		if (!key) {
			return null;
		}
		let paths = await this._getObjectHistoryPaths(objectType, key);
		for (let path of paths) {
			let req = await this.makeRequest("GET", this._getLibraryURI(path), {
				successCodes: [200, 404],
				responseType: "text"
			});
			if (req.status == 404) {
				continue;
			}
			let responseJSON = this._toResponseJSON(
				objectType,
				this._parseJSON(req.responseText, path),
				this._getObjectRecordVersionFromPath(path)
			);
			if (predicate(responseJSON)) {
				return responseJSON;
			}
		}
		return null;
	},

	async _getObjectHistoryPaths(objectType, key) {
		let dirPath = this._getObjectDirectoryPath(objectType, key);
		let req = await this.makeRequest("PROPFIND", this._getLibraryURI(dirPath), {
			body: "<propfind xmlns='DAV:'><prop><getetag/></prop></propfind>",
			headers: {
				Depth: 1,
				"Content-Type": "text/xml; charset=utf-8"
			},
			successCodes: [207, 404]
		});
		if (req.status == 404) {
			return [];
		}

		let paths = new Set();
		let matches = (req.responseText || "").matchAll(
			/<(?:[^:>]+:)?href[^>]*>([^<]+)<\/(?:[^:>]+:)?href>/gi
		);
		for (let match of matches) {
			let href = match[1].replace(/&amp;/g, "&");
			let filename = href.split(/[?#]/)[0].split("/").filter(Boolean).pop();
			if (!filename) {
				continue;
			}
			try {
				filename = decodeURIComponent(filename);
			}
			catch (e) {
				continue;
			}
			if (/^[0-9]+-[A-Za-z0-9]+\.json$/.test(filename)) {
				paths.add(dirPath + filename);
			}
		}

		return [...paths].sort((a, b) => {
			return this._getObjectRecordVersionFromPath(b)
				- this._getObjectRecordVersionFromPath(a);
		});
	},

	_mergeResponseJSON(objectType, baseJSON, patchJSON, version) {
		let data = Object.assign({}, baseJSON.data || {}, patchJSON.data || {});
		version = parseInt(version || patchJSON.version || data.version || 0);
		if (version) {
			data.version = version;
		}
		data.key = patchJSON.key || baseJSON.key || data.key;
		return {
			key: data.key,
			version,
			library: patchJSON.library || baseJSON.library || this._getLibraryResponseJSON(),
			links: Object.assign({}, baseJSON.links || {}, patchJSON.links || {}),
			meta: Object.assign(
				{},
				baseJSON.meta || {},
				patchJSON.meta || {},
				this._getObjectMeta(objectType, data)
			),
			data
		};
	},

	_getObjectRecordVersion(record) {
		if (!record) {
			return 0;
		}
		let version = typeof record == "object" ? record.version : record;
		return parseInt(version || 0);
	},

	async _deleteJSONFiles(paths) {
		for (let path of paths) {
			await this.makeRequest("DELETE", this._getLibraryURI(path), {
				successCodes: [200, 204, 404],
				timeout: this.UPLOAD_TIMEOUT
			});
		}
	},

	_newManifest() {
		let manifest = {
			schema: this.MANIFEST_SCHEMA,
			library: {
				key: this.libraryKey,
				libraryID: this.libraryID,
				libraryType: this.library.libraryType,
				libraryTypeID: this.library.libraryTypeID,
				name: this.library.name
			},
			libraryVersion: 0,
			settings: Object.create(null),
			objects: Object.create(null),
			deleted: Object.create(null)
		};
		return this._normalizeManifest(manifest);
	},

	_normalizeManifest(manifest) {
		if (!manifest || typeof manifest != "object" || Array.isArray(manifest)) {
			throw new Error("Invalid WebDAV metadata manifest");
		}
		if (!manifest.schema) {
			manifest.schema = this.MANIFEST_SCHEMA;
		}
		if (manifest.schema != this.MANIFEST_SCHEMA) {
			throw new Error(`Unsupported WebDAV metadata manifest schema ${manifest.schema}`);
		}
		manifest.libraryVersion = parseInt(manifest.libraryVersion || 0);
		manifest.settings = this._toNullPrototypeObject(manifest.settings);
		manifest.objects = this._toNullPrototypeObject(manifest.objects);
		manifest.deleted = this._toNullPrototypeObject(manifest.deleted);
		for (let objectTypePlural of this._getSyncedObjectTypePlurals()) {
			manifest.objects[objectTypePlural] = this._toNullPrototypeObject(
				manifest.objects[objectTypePlural]
			);
			manifest.deleted[objectTypePlural] = this._toNullPrototypeObject(
				manifest.deleted[objectTypePlural]
			);
		}
		manifest.deleted.settings = this._toNullPrototypeObject(manifest.deleted.settings);
		return manifest;
	},

	_toNullPrototypeObject(object) {
		let newObject = Object.create(null);
		if (!object || typeof object != "object" || Array.isArray(object)) {
			return newObject;
		}
		for (let [key, val] of Object.entries(object)) {
			newObject[key] = val;
		}
		return newObject;
	},

	_toResponseJSON(objectType, object, version) {
		if (!object || typeof object != "object" || Array.isArray(object)) {
			throw new Error(`Invalid WebDAV metadata ${objectType} JSON`);
		}

		// Early Phase 2D builds accidentally wrote an API response wrapper inside
		// the response's data block. Unwrap those records when reading them back.
		if (object.data
				&& object.data.data
				&& typeof object.data == "object"
				&& typeof object.data.data == "object"
				&& !Array.isArray(object.data.data)) {
			object = object.data;
		}

		let data = object.data
			&& typeof object.data == "object"
			&& !Array.isArray(object.data)
			? Object.assign({}, object.data)
			: Object.assign({}, object);
		version = parseInt(version ?? object.version ?? data.version ?? 0);
		if (version) {
			data.version = version;
		}
		let key = object.key || data.key;
		if (key) {
			data.key = key;
		}
		return {
			key,
			version,
			library: object.library || this._getLibraryResponseJSON(),
			links: object.links || {},
			meta: object.meta || this._getObjectMeta(objectType, data),
			data
		};
	},

	_getLibraryResponseJSON() {
		let json = {
			type: this.library.libraryType,
			id: this.library.libraryTypeID,
			name: this.library.name
		};
		if (this.library.libraryType == "group") {
			json.groupID = Zotero.Groups.getGroupIDFromLibraryID(this.libraryID);
		}
		return json;
	},

	_getObjectMeta(objectType, data) {
		let meta = {};
		if (objectType == "item") {
			if (data.creators && data.creators.length) {
				let creator = data.creators[0];
				meta.creatorSummary = creator.name
					|| [creator.firstName, creator.lastName].filter(x => x).join(" ");
			}
			meta.numChildren = 0;
		}
		else if (objectType == "collection") {
			meta.numCollections = 0;
			meta.numItems = 0;
		}
		return meta;
	},

	_getSyncedObjectTypePlurals() {
		return Zotero.DataObjectUtilities.getTypesForLibrary(this.libraryID)
			.map(objectType => Zotero.DataObjectUtilities.getObjectTypePlural(objectType));
	},

	async _ensureObjectDirectory(objectType, key) {
		let path = this._getObjectDirectoryPath(objectType, key);
		await this.makeRequest("MKCOL", this._getLibraryURI(path), {
			successCodes: [201, 405]
		});
	},

	_getObjectDirectoryPath(objectType, key) {
		let objectTypePlural = Zotero.DataObjectUtilities.getObjectTypePlural(objectType);
		return `objects/${objectTypePlural}/${encodeURIComponent(key)}/`;
	},

	_getObjectPayloadPath(objectType, key, version) {
		let suffix = Zotero.Utilities.randomString(8);
		return `${this._getObjectDirectoryPath(objectType, key)}${version}-${suffix}.json`;
	},

	_getObjectRecordPath(objectType, key, record) {
		if (!record) {
			return null;
		}
		if (typeof record == "object" && record.path) {
			return record.path;
		}
		let objectTypePlural = Zotero.DataObjectUtilities.getObjectTypePlural(objectType);
		return `objects/${objectTypePlural}/${encodeURIComponent(key)}.json`;
	},

	_getObjectRecordVersionFromPath(path) {
		let filename = path.split("/").pop();
		let match = filename && filename.match(/^([0-9]+)-/);
		return match ? parseInt(match[1]) : 0;
	},

	_getVersionMap(records) {
		let versions = {};
		for (let [key, record] of Object.entries(records || {})) {
			versions[key] = typeof record == "object" ? record.version : record;
		}
		return versions;
	},

	_getRootURI(path) {
		return this._controller.rootURI.mutate()
			.setSpec(this._controller.rootURI.spec + path)
			.finalize();
	},

	_getLibraryURI(path) {
		return this._getRootURI(
			`${this._METADATA_ROOT}/${encodeURIComponent(this.libraryKey)}/${path}`
		);
	},

	_filterVersionedMap(map, since) {
		if (!since) {
			return Object.assign({}, map);
		}
		since = parseInt(since);
		let filtered = {};
		for (let [key, value] of Object.entries(map)) {
			let version = typeof value == "object" ? value.version : value;
			if (version > since) {
				filtered[key] = value;
			}
		}
		return filtered;
	},

	_filterDeletedKeys(manifest, objectTypePlural, since) {
		let deleted = manifest.deleted[objectTypePlural] || {};
		if (!since) {
			return Object.keys(deleted);
		}
		since = parseInt(since);
		return Object.entries(deleted)
			.filter(([, version]) => version > since)
			.map(([key]) => key);
	},

	_parseJSON(json, label) {
		try {
			return JSON.parse(json);
		}
		catch (e) {
			Zotero.debug(`Could not parse WebDAV metadata JSON: ${label}`, 1);
			Zotero.debug(json, 1);
			throw e;
		}
	},

	_stringifyJSON(json) {
		return JSON.stringify(json, null, 2);
	}
};
