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


if (!Zotero.Sync.Storage) {
	Zotero.Sync.Storage = {};
}

/**
 * Local storage profile routing.
 *
 * Profiles are stored in prefs so the sync runner can resolve a library's file-sync backend
 * synchronously. Passwords are stored separately by the WebDAV controller in the login manager.
 */
Zotero.Sync.Storage.Profiles = {
	_profilesPref: 'sync.storage.webdavProfiles',
	_libraryProfilesPref: 'sync.storage.libraryProfiles',
	_webDAVProjectLibrariesPref: 'sync.storage.webdavProjectLibraries',
	_reservedProfileIDs: new Set(['__proto__', 'prototype', 'constructor']),

	_getPrefObject(pref) {
		let object = Object.create(null);
		let value = Zotero.Prefs.get(pref);
		if (!value) {
			return object;
		}
		try {
			let parsed = JSON.parse(value);
			if (!parsed || typeof parsed != 'object' || Array.isArray(parsed)) {
				return object;
			}
			for (let [key, val] of Object.entries(parsed)) {
				object[key] = val;
			}
			return object;
		}
		catch (e) {
			Zotero.logError(e);
			return object;
		}
	},

	_setPrefObject(pref, value) {
		Zotero.Prefs.set(pref, JSON.stringify(value));
	},

	_getCleanObject(value) {
		let object = Object.create(null);
		if (!value || typeof value != 'object' || Array.isArray(value)) {
			return object;
		}
		for (let [key, val] of Object.entries(value)) {
			object[key] = val;
		}
		return object;
	},

	_hasOwn(object, key) {
		return Object.prototype.hasOwnProperty.call(object, key);
	},

	_normalizeProfileID(profileID) {
		if (profileID === undefined || profileID === null) {
			throw new Error("profileID not provided");
		}
		profileID = `${profileID}`.trim();
		if (!profileID) {
			throw new Error("profileID cannot be empty");
		}
		if (!/^[A-Za-z0-9._-]+$/.test(profileID)) {
			throw new Error("profileID can contain only letters, numbers, '.', '_', and '-'");
		}
		if (this._reservedProfileIDs.has(profileID)) {
			throw new Error(`profileID '${profileID}' is reserved`);
		}
		return profileID;
	},

	_normalizeURL(url) {
		return `${url || ''}`.trim()
			// Match the existing sync preferences behavior
			.replace(/(^https?:\/\/|^:?\/\/|\/zotero\/?$|\/$)/g, '');
	},

	_getLibraryProfileKey(libraryID) {
		let library = Zotero.Libraries.get(libraryID);
		switch (library.libraryType) {
			case 'user':
				return `L${library.libraryID}`;

			case 'group':
				return `G${Zotero.Groups.getGroupIDFromLibraryID(libraryID)}`;

			case 'publications':
				return `P${library.libraryID}`;

			default:
				return `${library.libraryType}:${library.libraryID}`;
		}
	},

	_getLibraryIDFromProfileKey(key) {
		let type = key[0];
		let id = parseInt(key.substr(1));
		if (!id) {
			return false;
		}

		if (type == 'G') {
			return Zotero.Groups.getLibraryIDFromGroupID(id);
		}

		if ((type == 'L' || type == 'P') && Zotero.Libraries.exists(id)) {
			return id;
		}

		return false;
	},

	_getWebDAVRoot(profile, libraryID = null, profileID = null) {
		if (!profile || !profile.url) {
			return null;
		}
		let url = this._normalizeURL(profile.url);
		let rootPath = libraryID !== null
			? this.getWebDAVFileRootPathForLibrary(libraryID, profileID || profile.id)
			: 'zotero/';
		return `${profile.scheme || 'https'}://${url}/${rootPath}`;
	},

	_getActiveGlobalWebDAVRoot() {
		if (!Zotero.Prefs.get('sync.storage.enabled')
				|| Zotero.Prefs.get('sync.storage.protocol') != 'webdav'
				|| this.getLibraryProfileID(Zotero.Libraries.userLibraryID)) {
			return null;
		}

		return this._getGlobalWebDAVRootFromSettings();
	},

	_getGlobalWebDAVRootFromSettings(settings = {}) {
		let url = this._normalizeURL(
			settings.url !== undefined ? settings.url : Zotero.Prefs.get('sync.storage.url')
		);
		if (!url) {
			return null;
		}
		return `${settings.scheme || Zotero.Prefs.get('sync.storage.scheme') || 'https'}://${url}/zotero/`;
	},

	_getAssignedLibraryIDsForProfile(profileID, assignments = null) {
		profileID = this._normalizeProfileID(profileID);
		assignments = assignments || this._getPrefObject(this._libraryProfilesPref);

		let libraryIDs = [];
		for (let [key, assignedProfileID] of Object.entries(assignments)) {
			if (assignedProfileID != profileID) {
				continue;
			}
			let libraryID = this._getLibraryIDFromProfileKey(key);
			if (libraryID) {
				libraryIDs.push(libraryID);
			}
		}
		return libraryIDs;
	},

	_assertWebDAVRootAssignableToLibrary(profileID, libraryID, profile = null) {
		profile = profile || this.getWebDAVProfile(profileID);
		let root = this._getWebDAVRoot(profile, libraryID, profileID);
		if (!root) {
			return;
		}

		let assignments = this._getPrefObject(this._libraryProfilesPref);
		let libraryKey = this._getLibraryProfileKey(libraryID);
		for (let [key, assignedProfileID] of Object.entries(assignments)) {
			if (key == libraryKey) {
				continue;
			}
			let assignedLibraryID = this._getLibraryIDFromProfileKey(key);
			let assignedProfile = this.getWebDAVProfile(assignedProfileID);
			if (assignedLibraryID
					&& this._getWebDAVRoot(
						assignedProfile,
						assignedLibraryID,
						assignedProfileID
					) == root) {
				throw new Error(
					`WebDAV profile '${profileID}' uses the same WebDAV URL as profile `
					+ `'${assignedProfileID}' assigned to another library`
				);
			}
		}

		if (libraryID != Zotero.Libraries.userLibraryID
				&& this._getActiveGlobalWebDAVRoot() == root) {
			throw new Error(
				`WebDAV profile '${profileID}' uses the same WebDAV URL as the global WebDAV `
				+ `file-sync settings`
			);
		}
	},

	_assertAssignedWebDAVRootIsUnique(profileID, profile) {
		for (let libraryID of this._getAssignedLibraryIDsForProfile(profileID)) {
			this._assertWebDAVRootAssignableToLibrary(profileID, libraryID, profile);
		}
	},

	assertGlobalWebDAVRootIsUnique(settings = {}) {
		let enabled = settings.enabled !== undefined
			? settings.enabled
			: Zotero.Prefs.get('sync.storage.enabled');
		let protocol = settings.protocol || Zotero.Prefs.get('sync.storage.protocol');
		if (!enabled
				|| protocol != 'webdav'
				|| this.getLibraryProfileID(Zotero.Libraries.userLibraryID)) {
			return;
		}

		let root = this._getGlobalWebDAVRootFromSettings(settings);
		if (!root) {
			return;
		}

		let assignments = this._getPrefObject(this._libraryProfilesPref);
		for (let [key, profileID] of Object.entries(assignments)) {
			let libraryID = this._getLibraryIDFromProfileKey(key);
			if (!libraryID || libraryID == Zotero.Libraries.userLibraryID) {
				continue;
			}
			let profile = this.getWebDAVProfile(profileID);
			if (this._getWebDAVRoot(profile, libraryID) == root) {
				throw new Error(
					`Global WebDAV file-sync settings use the same WebDAV URL as profile `
					+ `'${profileID}' assigned to another library`
				);
			}
		}
	},

	async _resetSyncStatesForAssignedLibraries(profileID, assignments = null) {
		for (let libraryID of this._getAssignedLibraryIDsForProfile(profileID, assignments)) {
			await Zotero.Sync.Storage.Local.resetAllSyncStates(libraryID);
		}
	},

	getWebDAVProfiles() {
		return this._getPrefObject(this._profilesPref);
	},

	async getSyncSettingsBundle(options = {}) {
		let webdavProfiles = this.getWebDAVProfiles();
		let bundle = {
			version: 1,
			fileStorage: {
				global: {
					enabled: !!Zotero.Prefs.get('sync.storage.enabled'),
					protocol: Zotero.Prefs.get('sync.storage.protocol') || '',
					scheme: Zotero.Prefs.get('sync.storage.scheme') || '',
					url: Zotero.Prefs.get('sync.storage.url') || '',
					username: Zotero.Prefs.get('sync.storage.username') || '',
					groupsEnabled: !!Zotero.Prefs.get('sync.storage.groups.enabled'),
					downloadModePersonal: Zotero.Prefs.get('sync.storage.downloadMode.personal') || '',
					downloadModeGroups: Zotero.Prefs.get('sync.storage.downloadMode.groups') || ''
				},
				webdavProfiles,
				libraryProfiles: this._getPrefObject(this._libraryProfilesPref),
				webdavProjectLibraries: this._getPrefObject(this._webDAVProjectLibrariesPref)
			}
		};

		if (!options.includeSecrets) {
			return bundle;
		}

		if (Zotero.Prefs.get('sync.storage.protocol') == 'webdav') {
			try {
				let password = await Zotero.Sync.Runner.getStorageController('webdav').getPassword();
				if (password) {
					bundle.fileStorage.global.password = password;
				}
			}
			catch (e) {
				Zotero.logError(e);
			}
		}

		for (let profileID of Object.keys(webdavProfiles)) {
			try {
				let controller = new Zotero.Sync.Storage.Mode.WebDAV({ profileID });
				let password = await controller.getPassword();
				if (password) {
					webdavProfiles[profileID].password = password;
				}
			}
			catch (e) {
				Zotero.logError(e);
			}
		}

		return bundle;
	},

	async applySyncSettingsBundle(settings = {}) {
		let fileStorage = settings.fileStorage || settings;
		if (!fileStorage || typeof fileStorage != 'object') {
			return;
		}

		let global = fileStorage.global;
		if (global && typeof global == 'object' && !Array.isArray(global)) {
			if (global.enabled !== undefined) {
				Zotero.Prefs.set('sync.storage.enabled', !!global.enabled);
			}
			if (global.protocol !== undefined && ['zotero', 'webdav', ''].includes(global.protocol)) {
				Zotero.Prefs.set('sync.storage.protocol', global.protocol);
			}
			if (global.scheme !== undefined && ['http', 'https', ''].includes(global.scheme)) {
				Zotero.Prefs.set('sync.storage.scheme', global.scheme);
			}
			if (global.url !== undefined) {
				Zotero.Prefs.set('sync.storage.url', this._normalizeURL(global.url));
			}
			if (global.username !== undefined) {
				Zotero.Prefs.set('sync.storage.username', `${global.username || ''}`);
			}
			if (global.groupsEnabled !== undefined) {
				Zotero.Prefs.set('sync.storage.groups.enabled', !!global.groupsEnabled);
			}
			if (global.downloadModePersonal !== undefined) {
				Zotero.Prefs.set(
					'sync.storage.downloadMode.personal',
					`${global.downloadModePersonal || ''}`
				);
			}
			if (global.downloadModeGroups !== undefined) {
				Zotero.Prefs.set(
					'sync.storage.downloadMode.groups',
					`${global.downloadModeGroups || ''}`
				);
			}
			if (global.password !== undefined) {
				await Zotero.Sync.Runner.getStorageController('webdav')
					.setPassword(`${global.password || ''}`);
			}
		}

		let profilePasswords = Object.create(null);
		if (fileStorage.webdavProfiles) {
			let profiles = Object.create(null);
			for (let [profileID, profile] of Object.entries(
				this._getCleanObject(fileStorage.webdavProfiles)
			)) {
				try {
					profileID = this._normalizeProfileID(profileID);
				}
				catch (e) {
					Zotero.logError(e);
					continue;
				}
				if (!profile || typeof profile != 'object' || Array.isArray(profile)) {
					continue;
				}
				let scheme = ['http', 'https'].includes(profile.scheme)
					? profile.scheme
					: 'https';
				profiles[profileID] = {
					type: 'webdav',
					scheme,
					url: this._normalizeURL(profile.url),
					username: `${profile.username || ''}`,
					verified: !!profile.verified
				};
				if (profile.password !== undefined) {
					profilePasswords[profileID] = `${profile.password || ''}`;
				}
			}
			this._setPrefObject(this._profilesPref, profiles);
		}

		for (let [profileID, password] of Object.entries(profilePasswords)) {
			try {
				let controller = new Zotero.Sync.Storage.Mode.WebDAV({ profileID });
				await controller.setPassword(password);
			}
			catch (e) {
				Zotero.logError(e);
			}
		}

		if (fileStorage.libraryProfiles) {
			let profiles = this.getWebDAVProfiles();
			let assignments = Object.create(null);
			for (let [libraryKey, profileID] of Object.entries(
				this._getCleanObject(fileStorage.libraryProfiles)
			)) {
				try {
					profileID = this._normalizeProfileID(profileID);
				}
				catch (e) {
					Zotero.logError(e);
					continue;
				}
				if (!this._hasOwn(profiles, profileID)) {
					continue;
				}
				assignments[libraryKey] = profileID;
			}
			this._setPrefObject(this._libraryProfilesPref, assignments);
		}

		if (fileStorage.webdavProjectLibraries) {
			let profiles = this.getWebDAVProfiles();
			let projects = Object.create(null);
			for (let [libraryKey, project] of Object.entries(
				this._getCleanObject(fileStorage.webdavProjectLibraries)
			)) {
				if (!project || typeof project != 'object' || Array.isArray(project)) {
					continue;
				}
				let profileID = project.profileID;
				try {
					profileID = profileID ? this._normalizeProfileID(profileID) : '';
				}
				catch (e) {
					Zotero.logError(e);
					continue;
				}
				if (profileID && !this._hasOwn(profiles, profileID)) {
					continue;
				}
				projects[libraryKey] = {
					name: `${project.name || ''}`,
					profileID,
					created: project.created || Math.floor(Date.now() / 1000)
				};
			}
			this._setPrefObject(this._webDAVProjectLibrariesPref, projects);
		}

		if (Zotero.Sync.Runner) {
			Zotero.Sync.Runner.resetStorageController('webdav');
		}
	},

	getWebDAVProfile(profileID) {
		profileID = this._normalizeProfileID(profileID);
		let profiles = this.getWebDAVProfiles();
		if (!this._hasOwn(profiles, profileID)
				|| !profiles[profileID]
				|| typeof profiles[profileID] != 'object') {
			return null;
		}
		let profile = profiles[profileID];
		return profile ? Object.assign({ id: profileID, type: 'webdav' }, profile) : null;
	},

	setWebDAVProfileVerified(profileID, verified) {
		profileID = this._normalizeProfileID(profileID);
		let profiles = this.getWebDAVProfiles();
		if (!this._hasOwn(profiles, profileID)) {
			throw new Error(`WebDAV profile '${profileID}' not found`);
		}
		profiles[profileID].verified = !!verified;
		this._setPrefObject(this._profilesPref, profiles);
	},

	async setWebDAVProfile(profileID, options) {
		profileID = this._normalizeProfileID(profileID);
		if (!options) {
			throw new Error("WebDAV profile options not provided");
		}

		let profiles = this.getWebDAVProfiles();
		let existing = this._hasOwn(profiles, profileID) && typeof profiles[profileID] == 'object'
			? profiles[profileID]
			: {};
		let profile = Object.assign({}, existing);

		if (options.scheme !== undefined) {
			if (!['http', 'https'].includes(options.scheme)) {
				throw new Error(`Invalid WebDAV scheme '${options.scheme}'`);
			}
			profile.scheme = options.scheme;
		}
		if (options.url !== undefined) {
			profile.url = this._normalizeURL(options.url);
		}
		if (options.username !== undefined) {
			profile.username = `${options.username || ''}`;
		}

		profile.type = 'webdav';
		profile.scheme = profile.scheme || 'https';
		profile.url = profile.url || '';
		profile.username = profile.username || '';

		let connectionChanged = existing.scheme != profile.scheme
			|| existing.url != profile.url
			|| existing.username != profile.username;
		profile.verified = options.verified !== undefined
			? !!options.verified
			: (connectionChanged ? false : !!existing.verified);

		this._assertAssignedWebDAVRootIsUnique(profileID, profile);

		profiles[profileID] = profile;
		this._setPrefObject(this._profilesPref, profiles);

		if (options.password !== undefined) {
			let controller = new Zotero.Sync.Storage.Mode.WebDAV({ profileID });
			await controller.setPassword(options.password);
			profile.verified = false;
			profiles[profileID] = profile;
			this._setPrefObject(this._profilesPref, profiles);
		}

		if (connectionChanged && options.resetSyncState !== false) {
			await this._resetSyncStatesForAssignedLibraries(profileID);
		}

		if (Zotero.Sync.Runner) {
			Zotero.Sync.Runner.resetStorageController('webdav', { profileID });
		}

		return this.getWebDAVProfile(profileID);
	},

	async removeWebDAVProfile(profileID, options = {}) {
		profileID = this._normalizeProfileID(profileID);
		let assignments = this._getPrefObject(this._libraryProfilesPref);
		for (let [key, assignedProfileID] of Object.entries(assignments)) {
			let libraryID = this._getLibraryIDFromProfileKey(key);
			if (assignedProfileID == profileID
					&& libraryID
					&& this.isWebDAVProjectLibrary(libraryID)) {
				throw new Error(
					`WebDAV profile '${profileID}' is used by WebDAV project library `
					+ `'${Zotero.Libraries.get(libraryID).name}'. Remove the project library first.`
				);
			}
		}

		let controller = new Zotero.Sync.Storage.Mode.WebDAV({ profileID });
		await controller.clearPassword();

		let profiles = this.getWebDAVProfiles();
		delete profiles[profileID];
		this._setPrefObject(this._profilesPref, profiles);

		let originalAssignments = this._getPrefObject(this._libraryProfilesPref);
		for (let key in assignments) {
			if (assignments[key] == profileID) {
				delete assignments[key];
			}
		}
		this._setPrefObject(this._libraryProfilesPref, assignments);

		if (options.resetSyncState !== false) {
			await this._resetSyncStatesForAssignedLibraries(profileID, originalAssignments);
		}

		if (Zotero.Sync.Runner) {
			Zotero.Sync.Runner.resetStorageController('webdav', { profileID });
		}
	},

	async clearAllWebDAVProfileCredentials() {
		for (let profileID of Object.keys(this.getWebDAVProfiles())) {
			try {
				let controller = new Zotero.Sync.Storage.Mode.WebDAV({ profileID });
				await controller.clearPassword();
				if (Zotero.Sync.Runner) {
					Zotero.Sync.Runner.resetStorageController('webdav', { profileID });
				}
			}
			catch (e) {
				Zotero.logError(e);
			}
		}
	},

	getLibraryProfileID(libraryID) {
		let assignments = this._getPrefObject(this._libraryProfilesPref);
		return assignments[this._getLibraryProfileKey(libraryID)] || null;
	},

	getWebDAVProfileForLibrary(libraryID) {
		let profileID = this.getLibraryProfileID(libraryID);
		return profileID ? this.getWebDAVProfile(profileID) : null;
	},

	_normalizeWebDAVProjectName(name) {
		name = `${name || ''}`.trim();
		if (!name) {
			throw new Error("Project library name cannot be empty");
		}
		return name;
	},

	getWebDAVProjectLibraries() {
		let projects = this._getPrefObject(this._webDAVProjectLibrariesPref);
		let normalized = Object.create(null);
		let changed = false;
		for (let [key, project] of Object.entries(projects)) {
			let libraryID = this._getLibraryIDFromProfileKey(key);
			if (!libraryID || !Zotero.Libraries.exists(libraryID)) {
				changed = true;
				continue;
			}
			let library = Zotero.Libraries.get(libraryID);
			if (library.libraryType != 'group') {
				changed = true;
				continue;
			}
			project = project && typeof project == 'object' ? project : {};
			normalized[key] = Object.assign({}, project, {
				libraryID,
				groupID: Zotero.Groups.getGroupIDFromLibraryID(libraryID),
				name: project.name || library.name,
				profileID: project.profileID || this.getLibraryProfileID(libraryID)
			});
		}
		if (changed) {
			this._setPrefObject(this._webDAVProjectLibrariesPref, normalized);
		}
		return normalized;
	},

	getWebDAVProjectLibrary(libraryID) {
		return this.getWebDAVProjectLibraries()[this._getLibraryProfileKey(libraryID)] || null;
	},

	isWebDAVProjectLibrary(libraryID) {
		return !!this.getWebDAVProjectLibrary(libraryID);
	},

	getWebDAVProjectLibraryIDs() {
		return Object.values(this.getWebDAVProjectLibraries())
			.map(project => project.libraryID);
	},

	getWebDAVFileRootPathForLibrary(libraryID, profileID = null) {
		if (libraryID !== undefined
				&& (profileID || this.getWebDAVProfileForLibrary(libraryID))) {
			return `zotero/libraries/${encodeURIComponent(this._getLibraryProfileKey(libraryID))}/files/`;
		}
		return 'zotero/';
	},

	_getNextWebDAVProjectGroupID() {
		let groupIDs = new Set(Zotero.Groups.getAll().map(group => group.id));
		for (let groupID = -1; ; groupID--) {
			if (!groupIDs.has(groupID)) {
				return groupID;
			}
		}
	},

	async createWebDAVProjectLibrary(name, profileID, options = {}) {
		name = this._normalizeWebDAVProjectName(name);
		profileID = this._normalizeProfileID(profileID);
		if (!this.getWebDAVProfile(profileID)) {
			throw new Error(`WebDAV profile '${profileID}' does not exist`);
		}

		let group = new Zotero.Group;
		group.id = this._getNextWebDAVProjectGroupID();
		group.name = name;
		group.description = options.description || '';
		group.version = 0;
		group.editable = true;
		group.filesEditable = true;
		group.isAdmin = true;
		await group.saveTx();

		let key = this._getLibraryProfileKey(group.libraryID);
		let projects = this.getWebDAVProjectLibraries();
		projects[key] = {
			name,
			profileID,
			created: Math.floor(Date.now() / 1000)
		};
		this._setPrefObject(this._webDAVProjectLibrariesPref, projects);

		try {
			await this.setLibraryProfile(group.libraryID, profileID, { resetSyncState: false });
		}
		catch (e) {
			this.clearWebDAVProjectLibraryByKey(key);
			await group.eraseTx();
			throw e;
		}

		return group;
	},

	async removeWebDAVProjectLibrary(libraryID) {
		let project = this.getWebDAVProjectLibrary(libraryID);
		if (!project) {
			throw new Error(`Library ${libraryID} is not a WebDAV project library`);
		}
		let group = Zotero.Groups.getByLibraryID(libraryID);
		this.clearWebDAVProjectLibraryByKey(this._getLibraryProfileKey(libraryID));
		await this.clearLibraryProfile(libraryID, { resetSyncState: false });
		await group.eraseTx();
	},

	clearWebDAVProjectLibraryByKey(libraryProfileKey) {
		let projects = this._getPrefObject(this._webDAVProjectLibrariesPref);
		if (projects[libraryProfileKey]) {
			delete projects[libraryProfileKey];
			this._setPrefObject(this._webDAVProjectLibrariesPref, projects);
		}
	},

	async ensureWebDAVFileDirectoriesForLibrary(libraryID, profileID = null) {
		profileID = profileID || this.getLibraryProfileID(libraryID);
		if (!profileID) {
			return;
		}
		let controller = new Zotero.Sync.Storage.Mode.WebDAV({ libraryID, profileID });
		await controller._init();
		await controller.cacheCredentials();

		let rootKey = encodeURIComponent(this._getLibraryProfileKey(libraryID));
		let paths = [
			'zotero/',
			'zotero/libraries/',
			`zotero/libraries/${rootKey}/`,
			`zotero/libraries/${rootKey}/files/`
		];
		for (let path of paths) {
			let uri = controller.parentURI.mutate()
				.setSpec(controller.parentURI.spec + path)
				.finalize();
			await Zotero.HTTP.request('MKCOL', uri, {
				headers: controller._getAuthorizationHeaders('MKCOL', uri),
				successCodes: [201, 405],
				errorDelayIntervals: controller.ERROR_DELAY_INTERVALS,
				errorDelayMax: controller.ERROR_DELAY_MAX
			});
		}
	},

	async ensureWebDAVProjectDirectories(libraryID) {
		if (!this.isWebDAVProjectLibrary(libraryID)) {
			return;
		}
		await this.ensureWebDAVFileDirectoriesForLibrary(libraryID);
	},

	isProfileAssignedToAnotherLibrary(profileID, libraryID) {
		profileID = this._normalizeProfileID(profileID);
		let libraryKey = this._getLibraryProfileKey(libraryID);
		let assignments = this._getPrefObject(this._libraryProfilesPref);
		return Object.entries(assignments)
			.some(([key, assignedProfileID]) => key != libraryKey && assignedProfileID == profileID);
	},

	canSaveFilesForLibrary(libraryID) {
		let library = Zotero.Libraries.get(libraryID);
		if (!library.editable) {
			return false;
		}
		if (library.filesEditable) {
			return true;
		}

		// A group with normal item-editing rights can save local attachments when its file
		// backend is a per-library WebDAV profile, even if Zotero Storage file editing is off.
		return !!this.getWebDAVProfileForLibrary(libraryID);
	},

	async setLibraryProfile(libraryID, profileID, options = {}) {
		let library = Zotero.Libraries.get(libraryID);
		if (!['user', 'group'].includes(library.libraryType)) {
			throw new Error(`Cannot set storage profile for ${library.libraryType} library`);
		}

		profileID = this._normalizeProfileID(profileID);
		if (!this.getWebDAVProfile(profileID)) {
			throw new Error(`WebDAV profile '${profileID}' does not exist`);
		}

		let assignments = this._getPrefObject(this._libraryProfilesPref);
		let libraryKey = this._getLibraryProfileKey(libraryID);
		this._assertWebDAVRootAssignableToLibrary(profileID, libraryID);
		assignments[libraryKey] = profileID;
		this._setPrefObject(this._libraryProfilesPref, assignments);

		if (this.isWebDAVProjectLibrary(libraryID)) {
			let projects = this.getWebDAVProjectLibraries();
			projects[libraryKey].profileID = profileID;
			this._setPrefObject(this._webDAVProjectLibrariesPref, projects);
		}

		if (options.resetSyncState !== false) {
			await Zotero.Sync.Storage.Local.resetAllSyncStates(libraryID);
		}

		if (Zotero.Sync.Runner) {
			Zotero.Sync.Runner.resetStorageController('webdav', { profileID });
		}
	},

	async clearLibraryProfile(libraryID, options = {}) {
		if (this.isWebDAVProjectLibrary(libraryID)) {
			throw new Error("Remove the WebDAV project library instead of clearing its profile");
		}

		let assignments = this._getPrefObject(this._libraryProfilesPref);
		let key = this._getLibraryProfileKey(libraryID);
		if (!assignments[key]) {
			return false;
		}
		let profileID = assignments[key];
		delete assignments[key];
		this._setPrefObject(this._libraryProfilesPref, assignments);

		if (options.resetSyncState !== false) {
			await Zotero.Sync.Storage.Local.resetAllSyncStates(libraryID);
		}

		if (Zotero.Sync.Runner) {
			Zotero.Sync.Runner.resetStorageController('webdav', { profileID });
		}
		return true;
	},

	clearLibraryProfileByKey(libraryProfileKey) {
		let assignments = this._getPrefObject(this._libraryProfilesPref);
		if (assignments[libraryProfileKey]) {
			delete assignments[libraryProfileKey];
			this._setPrefObject(this._libraryProfilesPref, assignments);
		}
	},

	getModeForLibrary(libraryID) {
		let profile = this.getWebDAVProfileForLibrary(libraryID);
		return profile ? 'webdav' : null;
	},

	getControllerKey(mode, options = {}) {
		if (mode != 'webdav') {
			return mode;
		}
		let profileID = options.profileID;
		if (!profileID && options.libraryID !== undefined) {
			profileID = this.getLibraryProfileID(options.libraryID);
		}
		return profileID ? `${mode}:profile:${profileID}` : `${mode}:global`;
	},

	getLoginManagerRealm(profileID) {
		if (!profileID) {
			return null;
		}
		profileID = this._normalizeProfileID(profileID);
		return `Zotero Storage Server (profile: ${profileID})`;
	},

	/**
	 * Convenience API for Run JavaScript/startup scripts.
	 */
	async verifyWebDAVProfile(profileID, options = {}) {
		profileID = this._normalizeProfileID(profileID);
		let controller = new Zotero.Sync.Storage.Mode.WebDAV({ profileID });
		await controller.checkServer(options);
		return controller.verified;
	},

	async configureWebDAVForLibrary(libraryID, profileID, options) {
		await this.setWebDAVProfile(profileID, options);
		await this.setLibraryProfile(libraryID, profileID);
	}
};
