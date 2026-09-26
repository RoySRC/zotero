/*
    ***** BEGIN LICENSE BLOCK *****

    Copyright © 2008–2013 Center for History and New Media
                     George Mason University, Fairfax, Virginia, USA
                     http://zotero.org

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

"use strict";

const { ZOTERO_CONFIG } = ChromeUtils.importESModule('resource://zotero/config.mjs');
var React = require('react');
var ReactDOM = require('react-dom');
var VirtualizedTable = require('components/virtualized-table');
var { renderCell } = VirtualizedTable;

Zotero_Preferences.Sync = {
	checkmarkChar: '\u2705',
	noChar: '\uD83D\uDEAB',

	_pendingSessionToken: null,
	_loginResolve: null,
	_loginReject: null,
	_pollTimerID: null,
	_pollInterval: 3000,
	_storageLibraryNotifierID: null,
	_storageLibraryRefreshTimerID: null,

	init: async function () {
		this.storeLastStorageSettings();
		this.updateStorageSettingsUI();
		this.updateStorageSettingsGroupsUI();
		await this.initMetadataSyncUI();

		var username = Zotero.Users.getCurrentUsername() || Zotero.Prefs.get('sync.server.username') || " ";
		var apiKey = await Zotero.Sync.Data.Local.getAPIKey();
		let emails = apiKey ? Zotero.Users.getCurrentEmails() : undefined;
		this.displayFields(apiKey ? username : "", { emails });

		var pass = await Zotero.Sync.Runner.getStorageController('webdav').getPassword();
		if (pass) {
			document.getElementById('storage-password').value = pass;
		}
		this.initStorageProfilesUI();
		this._registerStorageLibraryObserver();

		if (apiKey) {
			try {
				var keyInfo = await Zotero.Sync.Runner.checkAccess(
					Zotero.Sync.Runner.getAPIClient({ apiKey, metadataBackend: false }),
					{timeout: 5000, includeEmails: true}
				);
				this.displayFields(keyInfo.username, { emails: keyInfo.emails });
				if (keyInfo.emails) {
					await Zotero.Users.setCurrentEmails(keyInfo.emails);
				}
			}
			catch (e) {
				// API key wrong/invalid
				if (e instanceof Zotero.Error && e.error == Zotero.Error.ERROR_API_KEY_INVALID) {
					Zotero.alert(
						window,
						Zotero.getString('general.error'),
						Zotero.getString('sync.error.apiKeyInvalid', Zotero.clientName)
					);
					this.unlinkAccount(false);
				}
				else {
					throw e;
				}
			}
		}

		window.addEventListener('beforeunload', () => {
			if (this._pendingSessionToken) {
				this.cancelLogin();
			}
		});

		document.getElementById('zotero-prefpane-account').addEventListener('action', () => {
			this._handlePendingAction();
		});
		// Auto-trigger login if opened with the 'logIn' action.
		// This must be after the checkAccess call above, which may clear an
		// invalid API key via unlinkAccount().
		this._handlePendingAction();

		document.getElementById('storage-url-prefix').addEventListener('synctopreference', () => {
			this.unverifyStorageServer();
		});
	},

	_handlePendingAction: async function () {
		let action = Zotero_Preferences.consumePendingAction();
		if (action == 'logIn'
				&& !this._pendingSessionToken
				&& !(await Zotero.Sync.Data.Local.getAPIKey())) {
			setTimeout(() => this.linkAccount(), 0);
		}
	},

	_registerStorageLibraryObserver: function () {
		if (this._storageLibraryNotifierID) {
			return;
		}

		this._storageLibraryNotifierID = Zotero.Notifier.registerObserver({
			notify: (event, type) => {
				if (type == 'sync' && event != 'finish') {
					return;
				}
				this._scheduleStorageLibraryRefresh(`${event}:${type}`);
			}
		}, ['group', 'sync'], 'preferencesAccountStorageLibraries');

		window.addEventListener('unload', () => {
			if (this._storageLibraryNotifierID) {
				Zotero.Notifier.unregisterObserver(this._storageLibraryNotifierID);
				this._storageLibraryNotifierID = null;
			}
			if (this._storageLibraryRefreshTimerID) {
				window.clearTimeout(this._storageLibraryRefreshTimerID);
				this._storageLibraryRefreshTimerID = null;
			}
		}, { once: true });
	},


	_scheduleStorageLibraryRefresh: function (reason) {
		if (!document.getElementById('storage-library-profile-list')) {
			return;
		}
		if (this._storageLibraryRefreshTimerID) {
			window.clearTimeout(this._storageLibraryRefreshTimerID);
		}
		this._storageLibraryRefreshTimerID = window.setTimeout(async () => {
			this._storageLibraryRefreshTimerID = null;
			try {
				if (this._metadataLoadInProgress) {
					this._appendMetadataLoadStatus('Refreshing library file-storage list', {
						reason,
						libraries: this._getLocalLibraryLoadSummary()
					});
				}
				await this._refreshStorageProfileSections();
			}
			catch (e) {
				Zotero.logError(e);
			}
		}, 250);
	},


	displayFields: function (username, { emails } = {}) {
		let linkedUserID = Zotero.Users.getCurrentUserID();
		let linkedUsername = Zotero.Users.getCurrentUsername()
			|| Zotero.Prefs.get('sync.server.username')
			|| "";
		let loggedIn = !!username;
		let loggedOutLinked = !loggedIn && !!linkedUserID;
		let linked = loggedIn || loggedOutLinked;
		let postgreSQLMetadataEnabled = Zotero.Sync.Metadata.isPostgreSQLSyncEnabled();

		document.getElementById('sync-unauthorized').hidden = linked || postgreSQLMetadataEnabled;
		document.getElementById('sync-postgresql-linked').hidden = linked || !postgreSQLMetadataEnabled;
		document.getElementById('account-linked').hidden = !linked;
		document.getElementById('sync-settings-section').hidden = !loggedIn && !postgreSQLMetadataEnabled;
		document.getElementById('sync-reset').hidden = !loggedIn;

		// Toggle logged-in vs logged-out elements within the linked container
		document.getElementById('account-log-out-button').hidden = !loggedIn;
		document.querySelector('.account-logged-out-status').hidden = !loggedOutLinked;
		document.getElementById('account-logged-out-actions').hidden = !loggedOutLinked;

		let displayUsername = loggedIn ? username : linkedUsername;
		document.getElementById('account-username').value = displayUsername;

		if (!loggedIn && loggedOutLinked && emails === undefined) {
			emails = Zotero.Users.getCurrentEmails();
		}
		this._updateEmails(emails);

		this._showLoginDefault();
	},


	_updateEmails: function (emails) {
		let label = document.getElementById('account-email-label');
		let container = document.getElementById('account-emails');
		container.replaceChildren();

		if (!emails || !emails.length) {
			label.hidden = true;
			container.hidden = true;
			return;
		}

		label.hidden = false;
		container.hidden = false;
		for (let email of emails) {
			let emailLabel = document.createXULElement('label');
			emailLabel.value = email;
			container.appendChild(emailLabel);
		}
	},


	_secmodDeleted: false,
	linkAccount: async function (_event) {
		// Guard against double-click
		if (this._pendingSessionToken) {
			return;
		}

		let session;
		try {
			session = await Zotero.Sync.Runner.startLoginSession();
		}
		catch (e) {
			setTimeout(function () {
				Zotero.Sync.Runner.alert(e);
			});
			throw e;
		}

		let sessionToken = session.sessionToken;
		this._pendingSessionToken = sessionToken;
		this._showLoginPending();
		Zotero.launchURL(session.loginURL);

		let result;
		try {
			// Create a shared promise that either streaming or polling can resolve
			let loginPromise = new Promise((resolve, reject) => {
				this._loginResolve = resolve;
				this._loginReject = reject;
			});

			// Register streaming listener for instant notification
			this._subscribeToLoginSession(sessionToken);
			// Start polling as fallback (fire-and-forget)
			this._startPolling(sessionToken);

			result = await loginPromise;
		}
		catch (e) {
			this._pendingSessionToken = null;
			this._showLoginDefault();
			// Session expired
			if (e.expired) {
				Zotero.alert(
					window,
					Zotero.getString('general.error'),
					Zotero.ftl.formatValueSync('account-error-login-session-expired')
				);
				return;
			}
			setTimeout(function () {
				Zotero.Sync.Runner.alert(e);
			});
			throw e;
		}
		finally {
			this._unsubscribeFromLoginSession(sessionToken);
			this._stopPolling();
			this._loginResolve = null;
			this._loginReject = null;
		}

		// Login was cancelled
		if (!result) {
			this._pendingSessionToken = null;
			this._showLoginDefault();
			return;
		}

		// Validate and store the API key
		try {
			await Zotero.Sync.Runner.checkLoginSession(sessionToken, result);
		}
		catch (e) {
			// The session already created a key on the server, so revoke it rather than
			// leaving an active key we can't use
			if (result.apiKey) {
				try {
					await Zotero.Sync.Runner.getAPIClient({
						apiKey: result.apiKey,
						metadataBackend: false
					})
						.deleteAPIKey();
				}
				catch (e2) {
					Zotero.logError(e2);
				}
			}
			this._pendingSessionToken = null;
			this._showLoginDefault();
			throw e;
		}
		// Handle secmod.db issue when storing the API key
		// This can happen when people have a very old profile directory (e.g., from 2013)
		try {
			// Force a read to verify the key was stored
			await Zotero.Sync.Data.Local.getAPIKey();
		}
		catch (e) {
			if (e.message.includes("User canceled primary password entry")) {
				Zotero.logError(e);
				let profileDir = Zotero.Profile.dir;
				let secmodPath = PathUtils.join(profileDir, 'secmod.db');
				if (!this._secmodDeleted && !((await IOUtils.exists(secmodPath)))) {
					Zotero.debug("secmod.db doesn't exist");
					setTimeout(function () {
						Zotero.Sync.Runner.alert(e);
					});
					throw e;
				}
				Zotero.debug("Deleting secmod.db", 2);
				await IOUtils.remove(secmodPath);
				// Once we've deleted, keep showing the restart message
				this._secmodDeleted = true;

				let index = Zotero.Prompt.confirm({
					title: Zotero.getString('general.restartRequired'),
					text: "Login information could not be saved.\n\n"
						+ Zotero.getString('general.pleaseRestartAndTryAgain', Zotero.appName),
					button0: Zotero.getString('general.restartNow'),
					button1: Services.prompt.BUTTON_TITLE_CANCEL
				});

				if (index == 0) {
					Zotero.Utilities.Internal.quit(true);
					return;
				}
				this._pendingSessionToken = null;
				this._showLoginDefault();
				return;
			}
			throw e;
		}

		let ok = await Zotero.Sync.Data.Local.checkUser(
			window,
			result.userID,
			result.username,
			result.displayName,
			result.emails
		);
		if (!ok) {
			// Session created an API key, but user decided not to use it
			Zotero.Sync.Runner.deleteAPIKey();
			this._pendingSessionToken = null;
			this._showLoginDefault();
			return;
		}

		Zotero.Prefs.set('sync.server.username', result.username);

		// It shouldn't be possible for a sync to be in progress if the user wasn't logged in,
		// but check to be sure
		if (!Zotero.Sync.Runner.syncInProgress) {
			// Clear any displayed sync errors
			Zotero.Sync.Runner.updateIcons([]);
		}
		window.addEventListener('beforeunload', () => {
			Zotero.Sync.Runner.setSyncTimeout(1);
		});

		this._pendingSessionToken = null;
		this.displayFields(result.username, { emails: result.emails });
	},


	_subscribeToLoginSession: function (sessionToken) {
		let topic = "login-session:" + sessionToken;
		Zotero.Streamer.subscribe([topic], (data) => {
			if (this._loginResolve) {
				if (data.event == "loginComplete") {
					this._loginResolve(data);
				}
				else if (data.event == "loginCancelled") {
					this._loginResolve(null);
				}
			}
		});
	},


	_unsubscribeFromLoginSession: function (sessionToken) {
		let topic = "login-session:" + sessionToken;
		Zotero.Streamer.unsubscribe([topic]);
	},


	_startPolling: async function (sessionToken) {
		let timeout = 10 * 60 * 1000; // 10 minutes
		let startTime = Date.now();
		let client = Zotero.Sync.Runner.getAPIClient({ metadataBackend: false });

		while (true) {
			// Wait before polling
			await new Promise((resolve) => {
				this._pollTimerID = setTimeout(resolve, this._pollInterval);
			});
			this._pollTimerID = null;

			// Already resolved by streaming or cancel
			if (!this._loginResolve) {
				return;
			}

			// Check timeout
			if (Date.now() - startTime > timeout) {
				let e = new Error("Login session timed out");
				e.expired = true;
				this._loginReject(e);
				return;
			}

			let result;
			try {
				result = await client.checkLoginSession(sessionToken);
			}
			catch (e) {
				if (this._loginReject) {
					this._loginReject(e);
				}
				return;
			}

			// Already resolved while we were awaiting
			if (!this._loginResolve) {
				return;
			}

			if (result.status == "completed") {
				this._loginResolve(result);
				return;
			}
			if (result.status == "cancelled") {
				this._loginResolve(null);
				return;
			}
			// "pending" -- continue polling
		}
	},


	_stopPolling: function () {
		if (this._pollTimerID) {
			clearTimeout(this._pollTimerID);
			this._pollTimerID = null;
		}
	},


	cancelLogin: function () {
		let token = this._pendingSessionToken;
		this._pendingSessionToken = null;
		if (this._loginResolve) {
			this._loginResolve(null);
		}
		this._showLoginDefault();
		if (token) {
			// Don't unsubscribe here -- the finally block in linkAccount() handles it
			// Fire-and-forget
			Zotero.Sync.Runner.cancelLoginSession(token);
		}
	},


	_showLoginPending: function () {
		for (let elem of document.querySelectorAll('.account-login-default')) {
			elem.hidden = true;
		}
		for (let elem of document.querySelectorAll('.account-login-pending')) {
			elem.hidden = false;
		}
		for (let elem of document.querySelectorAll('.account-login-status-indicator')) {
			elem.setAttribute('animated', true);
		}
	},


	_showLoginDefault: function () {
		for (let elem of document.querySelectorAll('.account-login-default')) {
			elem.hidden = false;
		}
		for (let elem of document.querySelectorAll('.account-login-pending')) {
			elem.hidden = true;
		}
		for (let elem of document.querySelectorAll('.account-login-status-indicator')) {
			elem.removeAttribute('verified');
			elem.removeAttribute('animated');
		}
	},

	unlinkAccount: async function(showAlert=true) {
		if (showAlert) {
			var check = {value: false};
			var ps = Services.prompt;
			var buttonFlags = (ps.BUTTON_POS_0) * (ps.BUTTON_TITLE_IS_STRING) +
				(ps.BUTTON_POS_1) * (ps.BUTTON_TITLE_CANCEL);
			var index = ps.confirmEx(
				null,
				Zotero.getString('general.warning'),
				Zotero.getString('account.unlinkWarning', Zotero.clientName),
				buttonFlags,
				Zotero.getString('account.unlinkWarning.button'), null, null,
				Zotero.getString('account.unlinkWarning.removeData', Zotero.clientName),
				check
			);
			if (index == 0) {
				if (check.value) {
					var resetDataDirFile = PathUtils.join(Zotero.DataDirectory.dir, 'reset-data-directory');
					await Zotero.File.putContentsAsync(resetDataDirFile, '');

					await Zotero.Sync.Runner.deleteAPIKey();
					await Zotero.Sync.Metadata.disablePostgreSQL();
					Zotero.Prefs.clear('sync.server.username');
					return Zotero.Utilities.Internal.quitZotero(true);
				}
			} else {
				return;
			}
		}

		this.displayFields();
		Zotero.Prefs.clear('sync.librariesToSync');
		Zotero.Prefs.clear('reader.readAloudVoices');
		await Zotero.Sync.Runner.deleteAPIKey();
		await Zotero.Sync.Metadata.disablePostgreSQL();
	},


	switchAccounts: async function () {
		let username = Zotero.Users.getCurrentUsername()
			|| Zotero.Prefs.get('sync.server.username')
			|| "";
		let confirmationText = await document.l10n.formatValue(
			'preferences-account-switch-confirmation-text',
		);
		let [title, text, acceptLabel, moreInfo] = await document.l10n.formatValues([
			'general-warning',
			{ id: 'preferences-account-switch-text', args: { username } },
			'preferences-account-switch-accept',
			'general-more-information',
		]);
		text += "\n\n" + await document.l10n.formatValue(
			'general-type-to-continue',
			{ text: confirmationText }
		);
		let io = {
			title,
			text,
			acceptLabel,
			confirmationText,
			extra2Label: moreInfo,
		};
		window.openDialog("chrome://zotero/content/hardConfirmationDialog.xhtml", "",
			"chrome,dialog,dependent,modal,centerscreen", io);

		if (io.extra2) {
			Zotero.launchURL("https://www.zotero.org/support/kb/switching_accounts");
			return;
		}

		if (!io.accept) {
			return;
		}

		let resetDataDirFile = PathUtils.join(Zotero.DataDirectory.dir, 'reset-data-directory');
		await Zotero.File.putContentsAsync(resetDataDirFile, '');
		Zotero.Prefs.set('reopenAccountPrefsOnRestart', true);
		await Zotero.Sync.Metadata.disablePostgreSQL();
		Zotero.Prefs.clear('sync.server.username');
		Zotero.Utilities.Internal.quit(true);
	},


	showLibrariesToSyncDialog: function() {
		var io = {};
		window.openDialog('chrome://zotero/content/preferences/librariesToSync.xhtml',
			"zotero-preferences-librariesToSyncDialog", "chrome,modal,centerscreen", io);
	},


	toggleLibraryToSync: function (index) {
		if (typeof index != "number") {
			index = this._tree.selection.focused;
		}
		if (index == -1 || !this._rows[index].editable) return;
		const row = this._rows[index];
		this._rows[index].checked = !this._rows[index].checked;
		this._tree.invalidateRow(index);

		var librariesToSkip = JSON.parse(Zotero.Prefs.get('sync.librariesToSkip') || '[]');
		var indexOfId = librariesToSkip.indexOf(row.id);
		if (indexOfId == -1) {
			librariesToSkip.push(row.id);
		}
		else {
			librariesToSkip.splice(indexOfId, 1);
		}
		Zotero.Prefs.set('sync.librariesToSkip', JSON.stringify(librariesToSkip));
	},


	initLibrariesToSync: async function () {
		const columns = [
			{
				dataKey: "checked",
				label: "zotero.preferences.sync.librariesToSync.sync",
				fixedWidth: true,
				// TODO: Specify in ems?
				width: '50'
			},
			{
				dataKey: "name",
				label: "zotero.preferences.sync.librariesToSync.library"
			}
		];
		this._rows = [];
		let renderItem = (index, selection, oldDiv=null, columns) => {
			const row = this._rows[index];
			let div;
			if (oldDiv) {
				div = oldDiv;
				div.innerHTML = "";
			}
			else {
				div = document.createElement('div');
				div.className = "row";
				div.addEventListener('dblclick', () => {
					this.toggleLibraryToSync(index);
				});
			}
			div.classList.toggle('selected', selection.isSelected(index));

			for (let column of columns) {
				if (column.dataKey === 'checked') {
					let span = document.createElement('span');
					span.className = `cell ${column.className}`;
					if (row.id != 'loading') {
						span.innerText = row.checked ? this.checkmarkChar : this.noChar;
						span.style.textAlign = 'center';
					}
					span.addEventListener('mousedown', () => {
						this.toggleLibraryToSync(index);
					});
					span.style.pointerEvents = 'initial';
					div.appendChild(span);
				}
				else {
					div.appendChild(renderCell(index, row[column.dataKey], column));
				}
			}
			return div;
		}
		let handleKeyDown = (e) => {
			if (e.key == ' ') {
				this.toggleLibraryToSync();
				return false;
			}
		};
		await new Promise((resolve) => {
			ReactDOM.createRoot(document.getElementById("libraries-to-sync-tree")).render(
				<VirtualizedTable
					getRowCount={() => this._rows.length}
					id="librariesToSync-table"
					ref={(ref) => {
						this._tree = ref;
						resolve();
					}}
					renderItem={renderItem}
					showHeader={true}
					columns={columns}
					staticColumns={true}
					getRowString={index => this._rows[index].name}
					disableFontSizeScaling={true}
					onKeyDown={handleKeyDown}
				/>
			);
		});

		var addRow = function (libraryName, id, checked=false, editable=true) {
			this._rows.push({
				name: libraryName,
				id,
				checked,
				editable
			});
			this._tree.invalidate();
		}.bind(this);

		// Add loading row while we're loading a group list
		var loadingLabel = Zotero.getString("zotero.preferences.sync.librariesToSync.loadingLibraries");
		addRow(loadingLabel, "loading", false, false);

		var apiKey = await this._getActiveMetadataAPIKey();
		var client = Zotero.Sync.Runner.getAPIClient({ apiKey });
		var groups = [];
		try {
			// Load up remote groups
			var keyInfo = await Zotero.Sync.Runner.checkAccess(client, {timeout: 5000});
			groups = await client.getGroups(keyInfo.userID);
		}
		catch (e) {
			// Connection problems
			if ((e instanceof Zotero.HTTP.UnexpectedStatusException)
					|| (e instanceof Zotero.HTTP.TimeoutException)
					|| (e instanceof Zotero.HTTP.BrowserOfflineException)) {
				Zotero.alert(
					window,
					Zotero.getString('general.error'),
					Zotero.getString('sync.error.checkConnection', Zotero.clientName)
				);
			}
			else {
				throw e;
			}
			document.getElementsByTagName('dialog')[0].acceptDialog();
		}

		// Remove the loading row
		this._rows = [];
		this._tree.invalidate();

		var librariesToSkip = JSON.parse(Zotero.Prefs.get('sync.librariesToSkip') || '[]');
		// Add default rows
		addRow(Zotero.getString("pane.collections.libraryAndFeeds"), "L" + Zotero.Libraries.userLibraryID,
			librariesToSkip.indexOf("L" + Zotero.Libraries.userLibraryID) == -1);

		// Sort groups
		var collation = Zotero.getLocaleCollation();
		groups.sort((a, b) => collation.compareString(1, a.data.name, b.data.name));
		// Add group rows
		for (let group of groups) {
			addRow(group.data.name, "G" + group.id, librariesToSkip.indexOf("G" + group.id) == -1);
		}
	},


	_lastStorageProtocol: null,
	_lastStorageURL: null,
	_lastStorageScheme: null,
	_lastStorageEnabled: null,

	storeLastStorageSettings: function () {
		this._lastStorageProtocol = Zotero.Prefs.get('sync.storage.protocol');
		this._lastStorageURL = Zotero.Prefs.get('sync.storage.url');
		this._lastStorageScheme = Zotero.Prefs.get('sync.storage.scheme');
		this._lastStorageEnabled = Zotero.Prefs.get('sync.storage.enabled');
	},


	updateStorageSettingsUI: async function({ unverify = true } = {}) {
		if (unverify) {
			this.unverifyStorageServer();
		}

		var protocol = Zotero.Prefs.get('sync.storage.protocol');
		var enabled = Zotero.Prefs.get('sync.storage.enabled');
		var userProfileID = Zotero.Sync.Storage.Profiles.getLibraryProfileID(
			Zotero.Libraries.userLibraryID
		);

		var storageSettings = document.getElementById('storage-settings');
		var protocolMenu = document.getElementById('storage-protocol');
		var settings = document.getElementById('storage-webdav-settings');
		var sep = document.getElementById('storage-separator');

		if (!enabled || protocol == 'zotero') {
			settings.hidden = true;
			sep.hidden = false;
		}
		else {
			settings.hidden = false;
			sep.hidden = true;
		}

		document.getElementById('storage-user-download-mode').disabled = !enabled && !userProfileID;
		this.updateStorageTerms();
	},


	updateStorageSettingsGroupsUI: function () {
		setTimeout(() => {
			var enabled = Zotero.Prefs.get('sync.storage.groups.enabled');
			document.getElementById('storage-groups-download-mode').disabled =
				!enabled && !this._hasProfileAssignedGroup();
			this.updateStorageTerms();
		});
	},


	updateStorageTerms: function () {
		var terms = document.getElementById('storage-terms');

		var libraryEnabled = Zotero.Prefs.get('sync.storage.enabled');
		var storageProtocol = Zotero.Prefs.get('sync.storage.protocol');
		var groupsEnabled = Zotero.Prefs.get('sync.storage.groups.enabled');
		var userProfileID = Zotero.Sync.Storage.Profiles.getLibraryProfileID(
			Zotero.Libraries.userLibraryID
		);
		var userUsesZFS = libraryEnabled && storageProtocol == 'zotero' && !userProfileID;
		var groupUsesZFS = groupsEnabled && this._hasDefaultStorageGroup();

		terms.hidden = !(userUsesZFS || groupUsesZFS);
	},


	initStorageProfilesUI: function () {
		document.getElementById('storage-profile-url-prefix').value = 'https';
		this.updateStorageProfilesUI();
		this.updateLibraryStorageProfilesUI();
		this.updateWebDAVProjectLibrariesUI();
	},


	initMetadataSyncUI: async function () {
		let backend = Zotero.Sync.Metadata.getBackend();
		document.getElementById('metadata-backend').value = backend;
		document.getElementById('metadata-postgresql-url').value =
			Zotero.Sync.Metadata.getPostgreSQLBaseURL();
		document.getElementById('metadata-postgresql-username').value =
			Zotero.Users.getCurrentUsername() || Zotero.Prefs.get('sync.server.username') || '';
		document.getElementById('metadata-postgresql-password').value = '';
		this.updateMetadataSyncUI();

		if (backend == Zotero.Sync.Metadata.BACKEND_POSTGRESQL
				&& await Zotero.Sync.Metadata.hasPostgreSQLAPIKey()) {
			this._setMetadataSyncStatus(this._formatMetadataMessage(
				'preferences-sync-metadata-postgresql-saved'
			));
		}
	},


	updateMetadataSyncUI: function () {
		let backend = document.getElementById('metadata-backend').value
			|| Zotero.Sync.Metadata.BACKEND_ZOTERO;
		let usingPostgreSQL = backend == Zotero.Sync.Metadata.BACKEND_POSTGRESQL;
		document.getElementById('metadata-postgresql-settings').hidden =
			!usingPostgreSQL || !!this._metadataLoadInProgress;
		document.getElementById('metadata-postgresql-login').disabled = !usingPostgreSQL;
	},


	onMetadataBackendChange: function () {
		document.getElementById('metadata-loading-panel').hidden = true;
		this._metadataLoadInProgress = false;
		this.updateMetadataSyncUI();
		this._setMetadataSyncStatus('');
	},


	onMetadataLoginKeyPress: async function (event) {
		if (event.keyCode == 13) {
			await this.loginPostgreSQLMetadataServer();
		}
	},


	_formatMetadataMessage: function (id, args) {
		return Zotero.ftl.formatValueSync(id, args);
	},


	_setMetadataSyncStatus: function (message, isError = false) {
		let label = document.getElementById('metadata-status');
		label.value = message || '';
		label.classList.toggle('error', isError);
	},


	_setMetadataLoading: function (loading) {
		this._metadataLoadInProgress = !!loading;
		document.getElementById('metadata-loading-progress').hidden = !loading;
		this.updateMetadataSyncUI();
	},


	_startMetadataLoadingStatus: function () {
		this._metadataLoadStartedAt = Date.now();
		let panel = document.getElementById('metadata-loading-panel');
		let current = document.getElementById('metadata-loading-current');
		let log = document.getElementById('metadata-loading-log');
		panel.hidden = false;
		current.value = '';
		log.textContent = '';
		this._setMetadataLoading(true);
	},


	_formatMetadataLoadElapsed: function () {
		if (!this._metadataLoadStartedAt) {
			return '+0ms';
		}
		return `+${Date.now() - this._metadataLoadStartedAt}ms`;
	},


	_sanitizeMetadataLoadValue: function (value) {
		if (Array.isArray(value)) {
			return value.map(val => this._sanitizeMetadataLoadValue(val));
		}
		if (!value || typeof value != 'object') {
			return value;
		}

		let clean = {};
		for (let [key, val] of Object.entries(value)) {
			if (/password|apiKey|token|secret/i.test(key)) {
				clean[key] = val ? '[present]' : '[empty]';
				continue;
			}
			clean[key] = this._sanitizeMetadataLoadValue(val);
		}
		return clean;
	},


	_appendMetadataLoadStatus: function (phase, details = null) {
		let current = document.getElementById('metadata-loading-current');
		let log = document.getElementById('metadata-loading-log');
		let line = `[${new Date().toISOString()} ${this._formatMetadataLoadElapsed()}] ${phase}`;
		current.value = phase;
		if (details !== null && details !== undefined) {
			line += "\n" + JSON.stringify(this._sanitizeMetadataLoadValue(details), null, 2);
		}
		log.textContent += (log.textContent ? "\n\n" : "") + line;
		log.scrollTop = log.scrollHeight;
	},


	_finishMetadataLoadingStatus: function (phase, details = null) {
		if (phase) {
			this._appendMetadataLoadStatus(phase, details);
		}
		this._setMetadataLoading(false);
	},


	_getLocalLibraryLoadSummary: function () {
		let libraries = Zotero.Libraries.getAll();
		let groupLibraries = libraries.filter(library => library.libraryType == 'group');
		return {
			totalLibraries: libraries.length,
			groupLibraries: groupLibraries.length,
			groups: groupLibraries.map(library => ({
				libraryID: library.libraryID,
				groupID: Zotero.Groups.getGroupIDFromLibraryID(library.libraryID),
				name: library.name,
				editable: !!library.editable,
				filesEditable: !!library.filesEditable,
				assignedWebDAVProfile:
					Zotero.Sync.Storage.Profiles.getLibraryProfileID(library.libraryID) || null
			}))
		};
	},


	_summarizePostgreSQLSettings: function (settings) {
		settings ||= {};
		let fileStorage = settings.fileStorage || {};
		let webdavProfiles = fileStorage.webdavProfiles || {};
		let libraryProfiles = fileStorage.libraryProfiles || {};
		let projectLibraries = fileStorage.webdavProjectLibraries || {};
		return {
			version: settings.version,
			metadata: settings.metadata || null,
			fileStorage: {
				hasFileStorage: !!settings.fileStorage,
				global: fileStorage.global ? {
					enabled: !!fileStorage.global.enabled,
					protocol: fileStorage.global.protocol || '',
					scheme: fileStorage.global.scheme || '',
					url: fileStorage.global.url || '',
					username: fileStorage.global.username || '',
					groupsEnabled: !!fileStorage.global.groupsEnabled,
					downloadModePersonal: fileStorage.global.downloadModePersonal || '',
					downloadModeGroups: fileStorage.global.downloadModeGroups || '',
					hasPassword: !!fileStorage.global.password
				} : null,
				webdavProfiles: Object.fromEntries(Object.entries(webdavProfiles)
					.map(([profileID, profile]) => [profileID, {
						scheme: profile.scheme || '',
						url: profile.url || '',
						username: profile.username || '',
						verified: !!profile.verified,
						hasPassword: !!profile.password
					}])),
				libraryProfileKeys: Object.keys(libraryProfiles),
				webdavProjectLibraryKeys: Object.keys(projectLibraries)
			}
		};
	},


	_refreshAccountAndSyncUI: async function () {
		if (Zotero.Sync.Metadata.isPostgreSQLSyncEnabled()
				&& await Zotero.Sync.Metadata.hasPostgreSQLAPIKey()) {
			let username = Zotero.Users.getCurrentUsername()
				|| Zotero.Prefs.get('sync.server.username')
				|| "";
			this.displayFields(username, { emails: Zotero.Users.getCurrentEmails() });
			return;
		}

		let apiKey = await Zotero.Sync.Data.Local.getAPIKey();
		let username = apiKey
			? (Zotero.Users.getCurrentUsername() || Zotero.Prefs.get('sync.server.username') || "")
			: "";
		this.displayFields(username, {
			emails: apiKey ? Zotero.Users.getCurrentEmails() : undefined
		});
	},


	_refreshStorageProfileSections: async function () {
		this.initStorageProfilesUI();
		await this.updateStorageSettingsUI({ unverify: false });
		this.updateStorageSettingsGroupsUI();
	},


	_applyPostgreSQLSyncSettings: async function (settings) {
		if (!settings) {
			return false;
		}
		await Zotero.Sync.Metadata.applyPostgreSQLSyncSettings(settings);
		await this._refreshStorageProfileSections();
		return true;
	},


	_shouldSyncAfterPostgreSQLLogin: function (loginContext, result) {
		if (!loginContext.wasPostgreSQLMetadataEnabled) {
			return {
				sync: true,
				reason: 'PostgreSQL metadata sync was just enabled'
			};
		}
		if (loginContext.previousPostgreSQLURL != Zotero.Sync.Metadata.getPostgreSQLBaseURL()) {
			return {
				sync: true,
				reason: 'PostgreSQL metadata server URL changed'
			};
		}
		if (loginContext.previousUserID && loginContext.previousUserID != result.userID) {
			return {
				sync: true,
				reason: 'Logged-in metadata account changed'
			};
		}
		if (!loginContext.previousUserID) {
			return {
				sync: true,
				reason: 'Local metadata has not been populated yet'
			};
		}
		return {
			sync: false,
			reason: 'Account and PostgreSQL server are unchanged'
		};
	},


	_syncAndRefreshAfterPostgreSQLLogin: async function (loginContext, result) {
		let syncDecision = this._shouldSyncAfterPostgreSQLLogin(loginContext, result);
		if (!syncDecision.sync) {
			this._appendMetadataLoadStatus('Skipping full metadata sync', {
				reason: syncDecision.reason,
				localLibraries: this._getLocalLibraryLoadSummary()
			});
			this._appendMetadataLoadStatus('Refreshing account and storage controls');
			await this._refreshStorageProfileSections();
			this._appendMetadataLoadStatus('Account and storage controls refreshed', {
				afterRefresh: this._getLocalLibraryLoadSummary()
			});
			return;
		}

		this._setMetadataSyncStatus(this._formatMetadataMessage(
			'preferences-sync-metadata-postgresql-syncing'
		));
		this._appendMetadataLoadStatus('Starting metadata sync', {
			reason: syncDecision.reason,
			beforeSync: this._getLocalLibraryLoadSummary()
		});
		await Zotero.Sync.Runner.sync({ background: true });
		this._appendMetadataLoadStatus('Metadata sync finished', {
			afterSync: this._getLocalLibraryLoadSummary()
		});
		this._appendMetadataLoadStatus('Refreshing account and storage controls');
		await this._refreshStorageProfileSections();
		this._appendMetadataLoadStatus('Account and storage controls refreshed', {
			afterRefresh: this._getLocalLibraryLoadSummary()
		});
	},


	_savePostgreSQLSyncSettingsIfEnabled: async function () {
		if (!Zotero.Sync.Metadata.isPostgreSQLSyncEnabled()) {
			return;
		}
		try {
			await Zotero.Sync.Metadata.savePostgreSQLSyncSettings();
		}
		catch (e) {
			Zotero.logError(e);
		}
	},


	_getActiveMetadataAPIKey: function () {
		if (Zotero.Sync.Metadata.isPostgreSQLSyncEnabled()) {
			return Zotero.Sync.Metadata.getPostgreSQLAPIKey();
		}
		return Zotero.Sync.Data.Local.getAPIKey();
	},


	saveMetadataSyncSettings: async function ({ silent = false } = {}) {
		let backend = document.getElementById('metadata-backend').value
			|| Zotero.Sync.Metadata.BACKEND_ZOTERO;

		if (backend == Zotero.Sync.Metadata.BACKEND_ZOTERO) {
			await Zotero.Sync.Metadata.disablePostgreSQL();
			await this._refreshAccountAndSyncUI();
			if (!silent) {
				this._setMetadataSyncStatus(this._formatMetadataMessage(
					'preferences-sync-metadata-zotero-saved'
				));
			}
			return true;
		}

		let urlField = document.getElementById('metadata-postgresql-url');
		let url = urlField.value.trim();
		if (!url) {
			urlField.focus();
			this._setMetadataSyncStatus(this._formatMetadataMessage(
				'preferences-sync-metadata-postgresql-enter-url'
			), true);
			return false;
		}
		if (!(await Zotero.Sync.Metadata.hasPostgreSQLAPIKey())) {
			document.getElementById('metadata-postgresql-username').focus();
			this._setMetadataSyncStatus(this._formatMetadataMessage(
				'preferences-sync-metadata-postgresql-login-required'
			), true);
			return false;
		}

		let options = { url };

		try {
			await Zotero.Sync.Metadata.configurePostgreSQL(options);
		}
		catch (e) {
			Zotero.logError(e);
			this._setMetadataSyncStatus(e.message, true);
			if (!silent) {
				Zotero.alert(window, Zotero.getString('general.error'), e.message);
			}
			return false;
		}

		urlField.value = Zotero.Sync.Metadata.getPostgreSQLBaseURL();
		await this._refreshAccountAndSyncUI();
		if (!silent) {
			this._setMetadataSyncStatus(this._formatMetadataMessage(
				'preferences-sync-metadata-postgresql-saved'
			));
		}
		return true;
	},


	loginPostgreSQLMetadataServer: async function () {
		let loginButton = document.getElementById('metadata-postgresql-login');
		let progressMeter = document.getElementById('metadata-progress');
		let urlField = document.getElementById('metadata-postgresql-url');
		let usernameField = document.getElementById('metadata-postgresql-username');
		let passwordField = document.getElementById('metadata-postgresql-password');
		let url;
		try {
			url = Zotero.Sync.Metadata.normalizePostgreSQLBaseURL(urlField.value);
		}
		catch (e) {
			urlField.focus();
			this._setMetadataSyncStatus(e.message, true);
			Zotero.alert(window, Zotero.getString('general.error'), e.message);
			return;
		}

		let username = usernameField.value.trim();
		let password = passwordField.value;
		let loginContext = {
			wasPostgreSQLMetadataEnabled: Zotero.Sync.Metadata.isPostgreSQLSyncEnabled(),
			previousPostgreSQLURL: Zotero.Sync.Metadata.getPostgreSQLBaseURL(),
			previousUserID: Zotero.Users.getCurrentUserID(),
			previousLibraryCount: Zotero.Libraries.getAll().length,
			previousGroupCount: Zotero.Groups.getAll().length
		};
		if (!username) {
			usernameField.focus();
			this._setMetadataSyncStatus(this._formatMetadataMessage(
				'preferences-sync-metadata-postgresql-enter-username'
			), true);
			return;
		}
		if (!password) {
			passwordField.focus();
			this._setMetadataSyncStatus(this._formatMetadataMessage(
				'preferences-sync-metadata-postgresql-enter-password'
			), true);
			return;
		}

		this._startMetadataLoadingStatus();
		this._appendMetadataLoadStatus('Starting PostgreSQL metadata login', {
			serverURL: url,
			username,
			passwordProvided: !!password,
			currentBackend: Zotero.Sync.Metadata.getBackend(),
			currentLocalLibraries: this._getLocalLibraryLoadSummary()
		});
		loginButton.disabled = true;
		progressMeter.hidden = false;
		try {
			this._appendMetadataLoadStatus('Authenticating with PostgreSQL metadata server', {
				endpoint: url + 'auth/login',
				method: 'POST'
			});
			let result = await Zotero.Sync.Metadata.loginPostgreSQL({ url, username, password });
			this._appendMetadataLoadStatus('Authentication succeeded', {
				userID: result.userID,
				username: result.username,
				displayName: result.displayName,
				emailCount: Array.isArray(result.emails) ? result.emails.length : 0,
				hasAPIKey: !!result.apiKey,
				syncSettings: this._summarizePostgreSQLSettings(result.syncSettings)
			});
			this._appendMetadataLoadStatus('Checking local account identity compatibility', {
				userID: result.userID,
				username: result.username
			});
			let ok = await Zotero.Sync.Data.Local.checkUser(
				window,
				result.userID,
				result.username,
				result.displayName,
				result.emails
			);
			if (!ok) {
				this._finishMetadataLoadingStatus('Account identity check was cancelled');
				await Zotero.Sync.Metadata.clearPostgreSQLAPIKey();
				return;
			}
			this._appendMetadataLoadStatus('Account identity accepted');
			Zotero.Prefs.set('sync.server.username', result.username);
			urlField.value = Zotero.Sync.Metadata.getPostgreSQLBaseURL();
			usernameField.value = result.username;
			passwordField.value = '';
			this._appendMetadataLoadStatus('Applying sync settings from PostgreSQL', {
				settings: this._summarizePostgreSQLSettings(result.syncSettings)
			});
			await this._applyPostgreSQLSyncSettings(result.syncSettings);
			this._appendMetadataLoadStatus('Sync settings applied locally', {
				localLibraries: this._getLocalLibraryLoadSummary()
			});
			this.displayFields(result.username, { emails: result.emails });
			await this._syncAndRefreshAfterPostgreSQLLogin(loginContext, result);
			this._setMetadataSyncStatus(this._formatMetadataMessage(
				'preferences-sync-metadata-postgresql-login-succeeded',
				{ username: result.username }
			));
			this._finishMetadataLoadingStatus('PostgreSQL account settings loaded successfully', {
				username: result.username,
				finalLocalLibraries: this._getLocalLibraryLoadSummary()
			});
		}
		catch (e) {
			Zotero.logError(e);
			this._finishMetadataLoadingStatus('PostgreSQL account settings load failed', {
				name: e.name,
				message: e.message,
				stack: e.stack || ''
			});
			this._setMetadataSyncStatus(e.message, true);
			Zotero.alert(window, Zotero.getString('general.error'), e.message);
		}
		finally {
			loginButton.disabled = false;
			progressMeter.hidden = true;
		}
	},


	_getSortedStorageProfileIDs: function () {
		let collation = Zotero.getLocaleCollation();
		return Object.keys(Zotero.Sync.Storage.Profiles.getWebDAVProfiles())
			.sort((a, b) => collation.compareString(1, a, b));
	},


	_getNextStorageProfileID: function () {
		let ids = new Set(this._getSortedStorageProfileIDs());
		let base = 'profile';
		if (!ids.has(base)) {
			return base;
		}
		for (let i = 2; ; i++) {
			let id = `${base}-${i}`;
			if (!ids.has(id)) {
				return id;
			}
		}
	},


	_getProfileMenuLabel: function (profileID) {
		let profile = Zotero.Sync.Storage.Profiles.getWebDAVProfile(profileID);
		if (!profile) {
			return profileID;
		}
		let url = profile.url ? `${profile.scheme}://${profile.url}/zotero/libraries/.../files/` : '';
		return url ? `${profileID} (${url})` : profileID;
	},


	_formatStorageMessage: function (id, args) {
		return Zotero.ftl.formatValueSync(id, args);
	},


	_appendMenuItem: function (menupopup, label, value, disabled = false) {
		let menuitem = document.createXULElement('menuitem');
		menuitem.setAttribute('label', label);
		menuitem.setAttribute('value', value);
		if (disabled) {
			menuitem.setAttribute('disabled', 'true');
		}
		menupopup.appendChild(menuitem);
		return menuitem;
	},


	_populateProfileMenu: function (menulist, {
		includeDefault = false,
		defaultLabel = null,
		libraryID = null
	} = {}) {
		let menupopup = menulist.querySelector('menupopup');
		menupopup.replaceChildren();
		if (includeDefault) {
			this._appendMenuItem(
				menupopup,
				defaultLabel || this._formatStorageMessage('preferences-sync-fileSyncing-default'),
				''
			);
		}
		for (let profileID of this._getSortedStorageProfileIDs()) {
			let label = this._getProfileMenuLabel(profileID);
			this._appendMenuItem(menupopup, label, profileID);
		}
	},


	updateStorageProfilesUI: function (selectedProfileID = null) {
		let ids = this._getSortedStorageProfileIDs();
		let selector = document.getElementById('storage-profile-selector');
		this._populateProfileMenu(selector);
		selector.disabled = ids.length == 0;

		if (!selectedProfileID || !ids.includes(selectedProfileID)) {
			selectedProfileID = ids.includes(selector.value) ? selector.value : ids[0];
		}
		selector.value = selectedProfileID || '';
		this._loadStorageProfileFields(selectedProfileID);
		this._updateStorageProfileActionState();
		this.updateLibraryStorageProfilesUI();
		this.updateWebDAVProjectLibrariesUI();
		this.updateStorageTerms();
	},


	_loadStorageProfileFields: function (profileID) {
		let profile = profileID ? Zotero.Sync.Storage.Profiles.getWebDAVProfile(profileID) : null;
		let idField = document.getElementById('storage-profile-id');
		idField.value = profile ? profile.id : '';
		idField.disabled = !!profile;
		document.getElementById('storage-profile-url-prefix').value = profile ? profile.scheme : 'https';
		document.getElementById('storage-profile-url').value = profile ? profile.url : '';
		document.getElementById('storage-profile-username').value = profile ? profile.username : '';
		document.getElementById('storage-profile-password').value = '';
		this._setStorageProfileStatus('');
	},


	_updateStorageProfileActionState: function () {
		let hasProfile = !!document.getElementById('storage-profile-selector').value;
		document.getElementById('storage-profile-delete').disabled = !hasProfile;
		document.getElementById('storage-profile-verify').disabled = !hasProfile
			&& !document.getElementById('storage-profile-id').value.trim();
	},


	_setStorageProfileStatus: function (message, isError = false) {
		let label = document.getElementById('storage-profile-status');
		label.value = message || '';
		label.classList.toggle('error', isError);
	},


	onStorageProfileSelect: function () {
		let profileID = document.getElementById('storage-profile-selector').value;
		this._loadStorageProfileFields(profileID);
		this._updateStorageProfileActionState();
	},


	newStorageProfile: function () {
		document.getElementById('storage-profile-selector').value = '';
		this._loadStorageProfileFields(null);
		document.getElementById('storage-profile-id').value = this._getNextStorageProfileID();
		document.getElementById('storage-profile-id').focus();
		this._updateStorageProfileActionState();
	},


	copyCurrentWebDAVToStorageProfile: async function () {
		if (!document.getElementById('storage-profile-id').value.trim()) {
			document.getElementById('storage-profile-id').value = this._getNextStorageProfileID();
		}
		document.getElementById('storage-profile-url-prefix').value =
			Zotero.Prefs.get('sync.storage.scheme') || 'https';
		document.getElementById('storage-profile-url').value =
			Zotero.Prefs.get('sync.storage.url') || '';
		document.getElementById('storage-profile-username').value =
			Zotero.Prefs.get('sync.storage.username') || '';

		let password = await Zotero.Sync.Runner.getStorageController('webdav').getPassword();
		document.getElementById('storage-profile-password').value = password || '';
		this._setStorageProfileStatus(this._formatStorageMessage(
			'preferences-sync-fileSyncing-profile-current-loaded'
		));
	},


	saveStorageProfile: async function ({ silent = false } = {}) {
		let profileID = document.getElementById('storage-profile-selector').value
			|| document.getElementById('storage-profile-id').value.trim();
		if (!profileID) {
			document.getElementById('storage-profile-id').focus();
			this._setStorageProfileStatus(
				this._formatStorageMessage('preferences-sync-fileSyncing-profile-enter-id'),
				true
			);
			return false;
		}

		let options = {
			scheme: document.getElementById('storage-profile-url-prefix').value,
			url: document.getElementById('storage-profile-url').value,
			username: document.getElementById('storage-profile-username').value
		};
		let password = document.getElementById('storage-profile-password').value;
		if (password) {
			options.password = password;
		}

		try {
			await Zotero.Sync.Storage.Profiles.setWebDAVProfile(profileID, options);
		}
		catch (e) {
			Zotero.logError(e);
			this._setStorageProfileStatus(e.message, true);
			if (!silent) {
				Zotero.alert(window, Zotero.getString('general.error'), e.message);
			}
			return false;
		}

		document.getElementById('storage-profile-password').value = '';
		this.updateStorageProfilesUI(profileID);
		await this._savePostgreSQLSyncSettingsIfEnabled();
		if (!silent) {
			this._setStorageProfileStatus(this._formatStorageMessage(
				'preferences-sync-fileSyncing-profile-saved',
				{ profileID }
			));
		}
		return profileID;
	},


	verifyStorageProfile: async function () {
		let profileID = await this.saveStorageProfile({ silent: true });
		if (!profileID) {
			return;
		}

		let verifyButton = document.getElementById('storage-profile-verify');
		let progressMeter = document.getElementById('storage-profile-progress');
		verifyButton.disabled = true;
		progressMeter.hidden = false;

		let controller = new Zotero.Sync.Storage.Mode.WebDAV({ profileID });
		let success = false;
		try {
			await controller.checkServer();
			success = true;
		}
		catch (e) {
			if (e instanceof controller.VerificationError) {
				switch (e.error) {
				case "NO_URL":
				case "INVALID_URL":
				case "NOT_DAV":
					document.getElementById('storage-profile-url').focus();
					break;

				case "NO_USERNAME":
					document.getElementById('storage-profile-username').focus();
					break;

				case "NO_PASSWORD":
				case "AUTH_FAILED":
					document.getElementById('storage-profile-password').focus();
					break;
				}
			}
			success = await controller.handleVerificationError(e, window);
		}
		finally {
			verifyButton.disabled = false;
			progressMeter.hidden = true;
		}

		if (success) {
			this.updateStorageProfilesUI(profileID);
			await this._savePostgreSQLSyncSettingsIfEnabled();
			this._setStorageProfileStatus(this._formatStorageMessage(
				'preferences-sync-fileSyncing-profile-verified',
				{ profileID }
			));
			Zotero.alert(
				window,
				Zotero.getString('sync.storage.serverConfigurationVerified'),
				Zotero.getString('sync.storage.fileSyncSetUp')
			);
		}
		else {
			this.updateStorageProfilesUI(profileID);
		}
	},


	deleteStorageProfile: async function () {
		let profileID = document.getElementById('storage-profile-selector').value
			|| document.getElementById('storage-profile-id').value.trim();
		if (!profileID) {
			return;
		}

		let confirmed = Services.prompt.confirm(
			window,
			Zotero.getString('general.warning'),
			this._formatStorageMessage(
				'preferences-sync-fileSyncing-profile-delete-confirm',
				{ profileID }
			)
		);
		if (!confirmed) {
			return;
		}

		try {
			await Zotero.Sync.Storage.Profiles.removeWebDAVProfile(profileID);
		}
		catch (e) {
			Zotero.logError(e);
			this._setStorageProfileStatus(e.message, true);
			Zotero.alert(window, Zotero.getString('general.error'), e.message);
			return;
		}
		this.updateStorageProfilesUI();
		await this._savePostgreSQLSyncSettingsIfEnabled();
		this._setStorageProfileStatus(this._formatStorageMessage(
			'preferences-sync-fileSyncing-profile-deleted',
			{ profileID }
		));
	},


	updateWebDAVProjectLibrariesUI: function () {
		let profileMenu = document.getElementById('storage-webdav-project-profile');
		let createButton = document.getElementById('storage-webdav-project-create');
		let list = document.getElementById('storage-webdav-project-list');
		if (!profileMenu || !createButton || !list) {
			return;
		}

		let profileIDs = this._getSortedStorageProfileIDs();
		this._populateProfileMenu(profileMenu);
		profileMenu.disabled = profileIDs.length == 0;
		createButton.disabled = profileIDs.length == 0;
		if (!profileIDs.includes(profileMenu.value)) {
			let selectedProfile = document.getElementById('storage-profile-selector').value;
			profileMenu.value = profileIDs.includes(selectedProfile) ? selectedProfile : (profileIDs[0] || '');
		}

		list.replaceChildren();
		let projects = Object.values(Zotero.Sync.Storage.Profiles.getWebDAVProjectLibraries())
			.sort((a, b) => Zotero.getLocaleCollation().compareString(1, a.name, b.name));
		for (let project of projects) {
			let row = document.createXULElement('hbox');
			row.setAttribute('class', 'storage-library-profile-row');
			row.setAttribute('align', 'center');

			let nameLabel = document.createXULElement('label');
			nameLabel.value = project.name;
			row.appendChild(nameLabel);

			let profileLabel = document.createXULElement('label');
			profileLabel.value = project.profileID
				? this._getProfileMenuLabel(project.profileID)
				: this._formatStorageMessage('preferences-sync-fileSyncing-webDAVProject-missing-profile');
			row.appendChild(profileLabel);

			let deleteButton = document.createXULElement('button');
			deleteButton.setAttribute(
				'label',
				this._formatStorageMessage('preferences-sync-fileSyncing-webDAVProject-remove')
			);
			deleteButton.addEventListener('command', () => {
				this.removeWebDAVProjectLibrary(project.libraryID);
			});
			row.appendChild(deleteButton);

			list.appendChild(row);
		}
	},


	createWebDAVProjectLibrary: async function () {
		let nameField = document.getElementById('storage-webdav-project-name');
		let profileMenu = document.getElementById('storage-webdav-project-profile');
		let name = nameField.value.trim();
		let profileID = profileMenu.value;
		if (!name) {
			nameField.focus();
			this._setStorageProfileStatus(
				this._formatStorageMessage('preferences-sync-fileSyncing-webDAVProject-enter-name'),
				true
			);
			return;
		}
		if (!profileID) {
			this._setStorageProfileStatus(
				this._formatStorageMessage('preferences-sync-fileSyncing-webDAVProject-select-profile'),
				true
			);
			return;
		}

		try {
			await Zotero.Sync.Storage.Profiles.createWebDAVProjectLibrary(name, profileID);
		}
		catch (e) {
			Zotero.logError(e);
			this._setStorageProfileStatus(e.message, true);
			Zotero.alert(window, Zotero.getString('general.error'), e.message);
			return;
		}

		nameField.value = '';
		this._setStorageProfileStatus(this._formatStorageMessage(
			'preferences-sync-fileSyncing-webDAVProject-created',
			{ name }
		));
		this.updateStorageProfilesUI(profileID);
		await this._savePostgreSQLSyncSettingsIfEnabled();
	},


	removeWebDAVProjectLibrary: async function (libraryID) {
		let library = Zotero.Libraries.get(libraryID);
		let confirmed = Services.prompt.confirm(
			window,
			Zotero.getString('general.warning'),
			this._formatStorageMessage(
				'preferences-sync-fileSyncing-webDAVProject-remove-confirm',
				{ name: library.name }
			)
		);
		if (!confirmed) {
			return;
		}

		try {
			await Zotero.Sync.Storage.Profiles.removeWebDAVProjectLibrary(libraryID);
		}
		catch (e) {
			Zotero.logError(e);
			this._setStorageProfileStatus(e.message, true);
			Zotero.alert(window, Zotero.getString('general.error'), e.message);
			return;
		}

		this._setStorageProfileStatus(this._formatStorageMessage(
			'preferences-sync-fileSyncing-webDAVProject-removed',
			{ name: library.name }
		));
		this.updateStorageProfilesUI();
		await this._savePostgreSQLSyncSettingsIfEnabled();
	},


	_getProfileAssignableLibraries: function () {
		let userLibrary = Zotero.Libraries.get(Zotero.Libraries.userLibraryID);
		let groups = Zotero.Libraries.getAll()
			.filter(library => library.libraryType == 'group')
			.sort((a, b) => Zotero.getLocaleCollation().compareString(1, a.name, b.name));
		return [userLibrary, ...groups];
	},


	_getDefaultStorageLabelForLibrary: function (library) {
		if (library.libraryType == 'user') {
			if (!Zotero.Prefs.get('sync.storage.enabled')) {
				return this._formatStorageMessage('preferences-sync-fileSyncing-default-no-file-sync');
			}
			return Zotero.Prefs.get('sync.storage.protocol') == 'webdav'
				? this._formatStorageMessage('preferences-sync-fileSyncing-default-global-webdav')
				: this._formatStorageMessage('preferences-sync-fileSyncing-default-zotero-storage');
		}
		if (library.libraryType == 'group') {
			return Zotero.Prefs.get('sync.storage.groups.enabled')
				? this._formatStorageMessage('preferences-sync-fileSyncing-default-zotero-storage')
				: this._formatStorageMessage('preferences-sync-fileSyncing-default-no-file-sync');
		}
		return this._formatStorageMessage('preferences-sync-fileSyncing-default');
	},


	updateLibraryStorageProfilesUI: function () {
		let container = document.getElementById('storage-library-profile-list');
		container.replaceChildren();

		for (let library of this._getProfileAssignableLibraries()) {
			let isWebDAVProject = Zotero.Sync.Storage.Profiles
				.isWebDAVProjectLibrary(library.libraryID);
			let row = document.createXULElement('hbox');
			row.setAttribute('class', 'storage-library-profile-row');
			row.setAttribute('align', 'center');

			let labelBox = document.createXULElement('hbox');
			labelBox.setAttribute('align', 'center');
			let label = document.createXULElement('label');
			label.value = library.name;
			labelBox.appendChild(label);
			if (isWebDAVProject) {
				let projectLabel = document.createXULElement('label');
				projectLabel.value = this._formatStorageMessage(
					'preferences-sync-fileSyncing-webDAVProject-label'
				);
				projectLabel.setAttribute('class', 'storage-profile-status');
				labelBox.appendChild(projectLabel);
			}
			row.appendChild(labelBox);

			let menu = document.createXULElement('menulist');
			menu.setAttribute('native', 'true');
			let popup = document.createXULElement('menupopup');
			menu.appendChild(popup);
			row.appendChild(menu);

			this._populateProfileMenu(menu, {
				includeDefault: true,
				defaultLabel: this._getDefaultStorageLabelForLibrary(library),
				libraryID: library.libraryID
			});
			if (isWebDAVProject) {
				let defaultItem = Array.from(popup.children)
					.find(item => !item.getAttribute('value'));
				if (defaultItem) {
					defaultItem.setAttribute('disabled', 'true');
				}
			}
			menu.value = Zotero.Sync.Storage.Profiles.getLibraryProfileID(library.libraryID) || '';
			menu.addEventListener('command', () => {
				this.onLibraryStorageProfileChange(library.libraryID, menu.value);
			});

			container.appendChild(row);
		}
	},


	onLibraryStorageProfileChange: async function (libraryID, profileID) {
		try {
			if (profileID) {
				await Zotero.Sync.Storage.Profiles.setLibraryProfile(libraryID, profileID);
			}
			else {
				await Zotero.Sync.Storage.Profiles.clearLibraryProfile(libraryID);
			}
		}
		catch (e) {
			Zotero.logError(e);
			this._setStorageProfileStatus(e.message, true);
			Zotero.alert(window, Zotero.getString('general.error'), e.message);
		}
		this.updateLibraryStorageProfilesUI();
		this.updateWebDAVProjectLibrariesUI();
		await this.updateStorageSettingsUI({ unverify: false });
		this.updateStorageSettingsGroupsUI();
		await this._savePostgreSQLSyncSettingsIfEnabled();
	},


	_hasProfileAssignedGroup: function () {
		return Zotero.Libraries.getAll()
			.some(library => library.libraryType == 'group'
				&& Zotero.Sync.Storage.Profiles.getLibraryProfileID(library.libraryID));
	},


	_hasDefaultStorageGroup: function () {
		return Zotero.Libraries.getAll()
			.some(library => library.libraryType == 'group'
				&& !Zotero.Sync.Storage.Profiles.getLibraryProfileID(library.libraryID));
	},


	onStorageSettingsKeyPress: async function(event) {
		if (event.keyCode == 13) {
			await this.verifyStorageServer();
		}
	},


	onStorageSettingsChange: async function() {
		var oldProtocol = this._lastStorageProtocol;
		var oldURL = this._lastStorageURL;
		var oldScheme = this._lastStorageScheme;
		var oldEnabled = this._lastStorageEnabled;

		// Necessary for pref to update
		await Zotero.Promise.delay(1);
		var newProtocol = Zotero.Prefs.get('sync.storage.protocol');

		var newURL = Zotero.Prefs.get('sync.storage.url').trim()
			// Strip scheme, leading '://' or '//' (#3483), and trailing '/zotero'
			.replace(/(^https?:\/\/|^:?\/\/|\/zotero\/?$|\/$)/g, '')
		Zotero.Prefs.set('sync.storage.url', newURL);

		try {
			Zotero.Sync.Storage.Profiles.assertGlobalWebDAVRootIsUnique({
				enabled: Zotero.Prefs.get('sync.storage.enabled'),
				protocol: newProtocol,
				scheme: Zotero.Prefs.get('sync.storage.scheme'),
				url: newURL
			});
		}
		catch (e) {
			Zotero.logError(e);
			Zotero.Prefs.set('sync.storage.enabled', oldEnabled);
			Zotero.Prefs.set('sync.storage.protocol', oldProtocol);
			Zotero.Prefs.set('sync.storage.scheme', oldScheme);
			Zotero.Prefs.set('sync.storage.url', oldURL);
			document.getElementById('storage-protocol').value = oldProtocol;
			document.getElementById('storage-url-prefix').value = oldScheme;
			document.getElementById('storage-url').value = oldURL;
			this._setStorageProfileStatus(e.message, true);
			Zotero.alert(window, Zotero.getString('general.error'), e.message);
			await this.updateStorageSettingsUI({ unverify: false });
			return;
		}

		if (oldProtocol != newProtocol || oldURL != newURL) {
			await Zotero.Sync.Storage.Local.resetAllSyncStates(Zotero.Libraries.userLibraryID);
		}

		if (oldProtocol == 'webdav') {
			this.unverifyStorageServer();
			// The controller is getting replaced anyway, but this removes the WebDAV URL from
			// Zotero.HTTP.CookieBlocker
			Zotero.Sync.Runner.getStorageController('webdav').clearCachedCredentials();
			Zotero.Sync.Runner.resetStorageController(oldProtocol);

			var username = document.getElementById('storage-username').value;
			var password = document.getElementById('storage-password').value;
			if (username) {
				// Get a new controller
				await Zotero.Sync.Runner.getStorageController('webdav').setPassword(password);
			}
		}

		if (oldProtocol == 'zotero' && newProtocol == 'webdav') {
			var sql = "SELECT COUNT(*) FROM settings "
				+ "WHERE setting='storage' AND key='zfsPurge' AND value='user'";
			if (!Zotero.DB.valueQueryAsync(sql)) {
				var account = Zotero.Sync.Server.username;
				var index = Zotero.Prompt.confirm({
					title: Zotero.getString('zotero.preferences.sync.purgeStorage.title'),
					text: Zotero.getString('zotero.preferences.sync.purgeStorage.desc'),
					button0: Zotero.getString('zotero.preferences.sync.purgeStorage.confirmButton'),
					button1: Zotero.getString('zotero.preferences.sync.purgeStorage.cancelButton'),
					buttonDelay: true,
				});

				if (index == 0) {
					var sql = "INSERT OR IGNORE INTO settings VALUES (?,?,?)";
					await Zotero.DB.queryAsync(sql, ['storage', 'zfsPurge', 'user']);

					try {
						await Zotero.Sync.Storage.ZFS.purgeDeletedStorageFiles();
						Services.prompt.alert(
							null,
							Zotero.getString("general.success"),
							"Attachment files from your personal library have been removed from the Zotero servers."
						);
					}
					catch (e) {
						Zotero.logError(e);
						Services.prompt.alert(
							null,
							Zotero.getString("general.error"),
							"An error occurred. Please try again later."
						);
					}
				}
			}
		}

		this.updateStorageSettingsUI();
		this.storeLastStorageSettings();
		await this._savePostgreSQLSyncSettingsIfEnabled();
	},


	verifyStorageServer: async function() {
		// onchange weirdly isn't triggered when clicking straight from a field to the button,
		// so we have to trigger this here (and we don't trigger it for Enter in
		// onStorageSettingsKeyPress()).
		await this.onStorageSettingsChange();

		Zotero.debug("Verifying storage");

		var verifyButton = document.getElementById("storage-verify");
		var abortButton = document.getElementById("storage-abort");
		var progressMeter = document.getElementById("storage-progress");
		var urlField = document.getElementById("storage-url");
		var usernameField = document.getElementById("storage-username");
		var passwordField = document.getElementById("storage-password");

		// These don't get set until window close on Windows/Linux (no instantApply),
		// so set them explicitly when verifying
		Zotero.Prefs.set('sync.storage.url', urlField.value);
		Zotero.Prefs.set('sync.storage.username', usernameField.value);

		verifyButton.hidden = true;
		abortButton.hidden = false;
		progressMeter.hidden = false;

		var success = false;
		var request = null;

		var controller = Zotero.Sync.Runner.getStorageController('webdav');

		try {
			await controller.checkServer({
				// Get the XMLHttpRequest for possible cancelling
				onRequest: r => request = r
			})

			success = true;
		}
		catch (e) {
			if (e instanceof controller.VerificationError) {
				switch (e.error) {
				case "NO_URL":
					urlField.focus();
					break;

				case "NO_USERNAME":
					usernameField.focus();
					break;

				case "NO_PASSWORD":
				case "AUTH_FAILED":
					passwordField.focus();
					break;
				}
			}
			success = await controller.handleVerificationError(e);
		}
		finally {
			verifyButton.hidden = false;
			abortButton.hidden = true;
			progressMeter.hidden = true;
		}

		if (success) {
			Zotero.debug("WebDAV verification succeeded");

			Zotero.alert(
				window,
				Zotero.getString('sync.storage.serverConfigurationVerified'),
				Zotero.getString('sync.storage.fileSyncSetUp')
			);
			await this._savePostgreSQLSyncSettingsIfEnabled();
		}
		else {
			Zotero.logError("WebDAV verification failed");
		}

		abortButton.onclick = function () {
			if (request) {
				Zotero.debug("Cancelling verification request");
				request.onreadystatechange = undefined;
				request.abort();
				verifyButton.hidden = false;
				abortButton.hidden = true;
				progressMeter.hidden = true;
			}
		}
	},


	unverifyStorageServer: function () {
		Zotero.debug("Unverifying storage");
		Zotero.Prefs.set('sync.storage.verified', false);
	},


	//
	// Reset pane
	//
	initResetPane: function () {
		//
		// Build library selector
		//
		var libraryMenu = document.getElementById('sync-reset-library-menu');
		// Some options need to be disabled when certain libraries are selected
		libraryMenu.addEventListener('command', () => {
			this.onResetLibraryChange(parseInt(libraryMenu.value));
		});
		this.onResetLibraryChange(Zotero.Libraries.userLibraryID);
		document.querySelectorAll('#sync-reset-radiogroup radio')
			.forEach(radio => radio.removeAttribute('selected'));
		var libraries = Zotero.Libraries.getAll()
			.filter(x => x.libraryType == 'user' || x.libraryType == 'group');
		Zotero.Utilities.Internal.buildLibraryMenu(libraryMenu, libraries);

		for (let row of document.querySelectorAll('#sync-reset-radiogroup > *')) {
			row.addEventListener('click', function (event) {
				// Ignore clicks if disabled
				if (this.hasAttribute('disabled')) {
					event.stopPropagation();
					return;
				}
				document.getElementById('sync-reset-button').disabled = false;
			});
		}
	},


	onResetLibraryChange: function (libraryID) {
		var library = Zotero.Libraries.get(libraryID);
		this.toggleResetOption('reset-file-sync-history', true);
		this.toggleResetOption('restore-to-server', library.editable);
	},


	toggleResetOption: function (id, enabled) {
		var section = document.getElementById(id);
		var radio = section.querySelector('radio');
		if (enabled) {
			section.removeAttribute('disabled');
			radio.disabled = false;
		}
		else {
			section.setAttribute('disabled', '');
			// If the radio we're disabling is already selected, move the selection to the first
			// enabled one instead.
			if (radio.selected) {
				let enabledRadio = document.querySelector(
					'#sync-reset-radiogroup > div:not([disabled]) radio'
				);
				if (enabledRadio) {
					document.getElementById('sync-reset-radiogroup').selectedItem = enabledRadio;
				}
			}
			radio.disabled = true;
		}
	},


	reset: async function () {
		var ps = Services.prompt;

		if (Zotero.Sync.Runner.syncInProgress) {
			Zotero.alert(
				null,
				Zotero.getString('general.error'),
				Zotero.getString('sync.error.syncInProgress')
					+ "\n\n"
					+ Zotero.getString('general.operationInProgress.waitUntilFinishedAndTryAgain')
			);
			return;
		}

		var libraryID = document.getElementById('sync-reset-library-menu').value;
		var library = Zotero.Libraries.get(libraryID);
		var action = Array.from(document.querySelectorAll('#sync-reset-radiogroup radio'))
			.filter(x => x.selected)[0]
			.getAttribute('value');

		switch (action) {
			/*case 'full-sync':
				var buttonFlags = (ps.BUTTON_POS_0) * (ps.BUTTON_TITLE_IS_STRING)
					+ (ps.BUTTON_POS_1) * (ps.BUTTON_TITLE_CANCEL)
					+ ps.BUTTON_POS_1_DEFAULT;
				var index = ps.confirmEx(
					null,
					Zotero.getString('general.warning'),
					// TODO: localize
					"On the next sync, Zotero will compare all local and remote data and merge any "
						+ "data that does not exist in both locations.\n\n"
						+ "This option is not necessary during normal usage and should "
						+ "generally be used only to troubleshoot specific issues as recommended "
						+ "by Zotero support staff.",
					buttonFlags,
					Zotero.getString('general.reset'),
					null, null, null, {}
				);

				switch (index) {
				case 0:
					let libraries = Zotero.Libraries.getAll().filter(library => library.syncable);
					await Zotero.DB.executeTransaction(async function () {
						for (let library of libraries) {
							library.libraryVersion = -1;
							await library.save();
						}
					});
					break;

					// Cancel
				case 1:
					return;
				}

				break;

			case 'restore-from-server':
				var buttonFlags = (ps.BUTTON_POS_0) * (ps.BUTTON_TITLE_IS_STRING)
									+ (ps.BUTTON_POS_1) * (ps.BUTTON_TITLE_CANCEL)
									+ ps.BUTTON_POS_1_DEFAULT;
				var index = ps.confirmEx(
					null,
					Zotero.getString('general.warning'),
					Zotero.getString('zotero.preferences.sync.reset.restoreFromServer', account),
					buttonFlags,
					Zotero.getString('zotero.preferences.sync.reset.replaceLocalData'),
					null, null, null, {}
				);

				switch (index) {
					case 0:
						// TODO: better error handling

						// Verify username and password
						var callback = async function () {
							Zotero.Schema.stopRepositoryTimer();
							Zotero.Sync.Runner.clearSyncTimeout();

							Zotero.DB.skipBackup = true;

							await Zotero.File.putContentsAsync(
								PathUtils.join(Zotero.DataDirectory.dir, 'restore-from-server'),
								''
							);

							var buttonFlags = (ps.BUTTON_POS_0) * (ps.BUTTON_TITLE_IS_STRING);
							var index = ps.confirmEx(
								null,
								Zotero.getString('general.restartRequired'),
								Zotero.getString('zotero.preferences.sync.reset.restartToComplete'),
								buttonFlags,
								Zotero.getString('general.restartNow'),
								null, null, null, {}
							);

							var appStartup = Components.classes["@mozilla.org/toolkit/app-startup;1"]
									.getService(Components.interfaces.nsIAppStartup);
							appStartup.quit(Components.interfaces.nsIAppStartup.eRestart | Components.interfaces.nsIAppStartup.eAttemptQuit);
						};

						// TODO: better way of checking for an active session?
						if (Zotero.Sync.Server.sessionIDComponent == 'sessionid=') {
							Zotero.Sync.Server.login()
							.then(callback)
							.done();
						}
						else {
							callback();
						}
						break;

					// Cancel
					case 1:
						return;
				}
				break;*/

			case 'restore-to-server': {
				const CHECKBOX_THRESHOLD = 10;
				const CONFIRMATION_TEXT_MAX_ITEMS = 5;

				let apiKey = await this._getActiveMetadataAPIKey();
				let client = Zotero.Sync.Runner.getAPIClient({ apiKey });
				var keyInfo = await Zotero.Sync.Runner.checkAccess(client, { timeout: 5000 });
				let { keys: remoteKeysArray } = await client.getKeys('user', keyInfo.userID, { target: 'items', itemType: '-annotation' });
				let remoteKeys = new Set(remoteKeysArray);
				let localItems = await Zotero.Items.getAll(Zotero.Libraries.userLibraryID, false, false, false);
				let localItemsCount = localItems.length;
				let localKeys = new Set(localItems
					.filter(item => item.isRegularItem() || item.isNote() || item.isAttachment())
					.map(item => item.key));
				let remoteButNotLocal = remoteKeys.difference(localKeys); // NOTE: `difference` requires FF 127
				let remoteItemsDeletedCount = remoteButNotLocal.size;

				let [title, text, warning1, warning2, checkboxLabel, yes] = await document.l10n.formatValues([
					'general-warning',
					{ id: 'preferences-sync-reset-restore-to-server-body', args: { libraryName: library.name, domain: ZOTERO_CONFIG.DOMAIN_NAME } },
					{ id: 'preferences-sync-reset-restore-to-server-deleted-items-text', args: { remoteItemsDeletedCount } },
					{ id: 'preferences-sync-reset-restore-to-server-remaining-items-text', args: { localItemsCount } },
					{ id: 'preferences-sync-reset-restore-to-server-checkbox-label', args: { remoteItemsDeletedCount } },
					'preferences-sync-reset-restore-to-server-yes',
				]);
				let confirmationText;

				text = remoteItemsDeletedCount > 0 ? `${text}\n\n${warning1}` : text;

				if (remoteItemsDeletedCount < CHECKBOX_THRESHOLD) {
					checkboxLabel = null;
				}
				else if (localItemsCount < CONFIRMATION_TEXT_MAX_ITEMS) {
					text += warning2;
					checkboxLabel = null;
					confirmationText = await document.l10n.formatValue(
						'preferences-sync-reset-restore-to-server-confirmation-text',
					)
					text += "\n\n" + await document.l10n.formatValue(
						'general-type-to-continue',
						{ text: confirmationText}
					);
				}
				var io = {
					title,
					text,
					acceptLabel: yes,
					checkboxLabel,
					confirmationText
				};
				window.openDialog("chrome://zotero/content/hardConfirmationDialog.xhtml", "",
					"chrome,dialog,dependent,modal,centerscreen", io);

				if (io.accept) {
					let resetButton = document.getElementById('sync-reset-button');
					resetButton.disabled = true;
					try {
						await Zotero.Sync.Runner.sync({
							libraries: [libraryID],
							resetMode: Zotero.Sync.Runner.RESET_MODE_TO_SERVER
						});
					}
					finally {
						resetButton.disabled = false;
					}
				}
				break;
			}

			case 'reset-file-sync-history':
				var buttonFlags = ps.BUTTON_POS_0 * ps.BUTTON_TITLE_IS_STRING
					+ ps.BUTTON_POS_1 * ps.BUTTON_TITLE_CANCEL
					+ ps.BUTTON_POS_1_DEFAULT;
				var index = ps.confirmEx(
					null,
					Zotero.getString('general.warning'),
					Zotero.getString(
						'zotero.preferences.sync.reset.fileSyncHistory',
						[Zotero.clientName, library.name]
					),
					buttonFlags,
					Zotero.getString('general.reset'),
					null, null, null, {}
				);

				switch (index) {
					case 0:
						await Zotero.Sync.Storage.Local.resetAllSyncStates(libraryID);
						ps.alert(
							null,
							Zotero.getString('general.success'),
							Zotero.getString(
								'zotero.preferences.sync.reset.fileSyncHistory.cleared',
								library.name
							)
						);
						break;

					// Cancel
					case 1:
						return;
				}

				break;

			default:
				throw new Error(`Invalid action '${action}' in handleSyncReset()`);
		}
	}
};
