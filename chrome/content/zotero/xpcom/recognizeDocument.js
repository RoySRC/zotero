/*
    ***** BEGIN LICENSE BLOCK *****
    
    Copyright © 2018 Center for History and New Media
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

Zotero.RecognizeDocument = new function () {
	const OFFLINE_RECHECK_DELAY = 60 * 1000;
	const MAX_PAGES = 5;
	const UNRECOGNIZE_TIMEOUT = 86400 * 1000;
	const NOTE_EDIT_THRESHOLD = 1000;
	const EPUB_MAX_SECTIONS = 5;
	
	let _newItems = new WeakMap();
	// Feedback must use the original recognizer, even if Settings changes later.
	let _recognitionOrigins = new WeakMap();
	
	let _queue = [];
	let _queueProcessing = false;
	let _processingItemID = null;
	let _localRequest = null;
	let _cancelRevision = 0;
	
	let _progressQueue = Zotero.ProgressQueues.create({
		id: 'recognize',
		title: 'recognizePDF.title',
		columns: [
			'recognizePDF.attachmentName.label',
			'recognizePDF.itemName.label'
		]
	});
	
	_progressQueue.addListener('cancel', function () {
		_queue = [];
		_cancelRevision++;
		_localRequest?.abort();
		if (Zotero.Prefs.get('recognize.engine') == 'epilib-local') Zotero.LocalRecognition.cancelAll();
	});
	
	this.recognizeStub = null;
	
	/**
	 * Triggers queue processing and returns when all items in the queue are processed
	 * @return {Promise}
	 */
	async function _processQueue() {
		await Zotero.Schema.schemaUpdatePromise;
		
		if (_queueProcessing) return _queueProcessing.promise;
		_queueProcessing = Zotero.Promise.defer();
		
		while (1) {
			// While all current progress queue usages are related with
			// online APIs, check internet connectivity here
			if (Zotero.HTTP.browserIsOffline()) {
				await Zotero.Promise.delay(OFFLINE_RECHECK_DELAY);
				continue;
			}
			
			let itemID = _queue.pop();
			if (!itemID) break;
			
			_processingItemID = itemID;
			
			_progressQueue.updateRow(itemID, Zotero.ProgressQueue.ROW_PROCESSING, Zotero.getString('general.processing'));
			
			try {
				let item = await Zotero.Items.getAsync(itemID);
				
				if (!item) {
					throw new Error();
				}
				
				let parentItem = await _processItem(item);
				_progressQueue.updateRow(itemID, Zotero.ProgressQueue.ROW_SUCCEEDED, parentItem.getField('title'));
			}
			catch (e) {
				Zotero.logError(e);
				
				_progressQueue.updateRow(
					itemID,
					Zotero.ProgressQueue.ROW_FAILED,
					e instanceof Zotero.Exception.Alert
						? e.message
						: Zotero.getString('general.error')
				);
			}
		}
		
		_queueProcessing.resolve();
		_queueProcessing = false;
		_processingItemID = null;
	}
	
	
	/**
	 * Adds items to the queue and triggers processing
	 * @param {Zotero.Item[]} items
	 */
	this.recognizeItems = async function (items) {
		for (let item of items) {
			if(
				_processingItemID === item.id ||
				_queue.includes(item.id) ||
				!this.canRecognize(item)
			) {
				continue;
			}
			_queue.unshift(item.id);
			_progressQueue.addRow(item);
		}
		await _processQueue();
	};
	
	
	/**
	 * Checks whether a given attachment could theoretically be recognized
	 * @param {Zotero.Item} item
	 * @return {Boolean} True if the PDF can be recognized, false if it cannot be
	 */
	this.canRecognize = function (item) {
		return item.attachmentContentType
			// Keep in sync with dragging out of parent in ItemTree::canDropCheck()
			&& (item.isPDFAttachment() || item.isEPUBAttachment())
			&& item.isTopLevelItem();
	};
	
	
	this.autoRecognizeItems = async function (items) {
		if (!Zotero.Prefs.get('autoRecognizeFiles')) return;
		
		var docs = items.filter((item) => {
			return item && this.canRecognize(item);
		});
		if (!docs.length) {
			return;
		}
		var queue = Zotero.ProgressQueues.get('recognize');
		var dialog = queue.getDialog();
		var numInQueue = queue.getTotal();
		var promise = this.recognizeItems(docs);
		// If the queue wasn't empty or more than one file is being saved, show the dialog
		if (numInQueue > 0 || docs.length > 1) {
			dialog.open();
			return promise;
		}
		await promise;
		// If dialog wasn't opened automatically and wasn't opened manually, clear it after
		// recognizing files
		if (!dialog.isOpen()) {
			queue.cancel();
		}
	};
	
	
	this.canUnrecognize = function (item) {
		var { dateModified } = _newItems.get(item) || {};
		// Item must have been recognized recently, must not have been modified since it was
		// created, and must have only one attachment and no other children
		if (!dateModified
				|| Zotero.Date.sqlToDate(dateModified, true) < new Date() - UNRECOGNIZE_TIMEOUT
				|| item.dateModified != dateModified
				|| item.numAttachments(true) != 1) {
			_newItems.delete(item);
			return false;
		}
		
		// Child attachment must be not be in trash and must be a PDF or EPUB
		var attachments = Zotero.Items.get(item.getAttachments());
		if (!attachments.length || (!attachments[0].isPDFAttachment() && !attachments[0].isEPUBAttachment())) {
			_newItems.delete(item);
			return false;
		}
		
		// Notes must have been modified within one second of the item
		var notes = Zotero.Items.get(item.getNotes());
		if (notes.some(note => note.dateModified > dateModified + NOTE_EDIT_THRESHOLD)) {
			_newItems.delete(item);
			return false;
		}
		
		return true;
	};
	
	
	this.unrecognize = async function (item) {
		var { originalTitle, originalFilename } = _newItems.get(item);
		var attachment = Zotero.Items.get(item.getAttachments()[0]);
		
		try {
			let currentFilename = attachment.attachmentFilename;
			if (currentFilename != originalFilename) {
				await attachment.renameAttachmentFile(originalFilename);
			}
			attachment.setField('title', originalTitle);
		}
		catch (e) {
			Zotero.logError(e);
		}
		
		return Zotero.DB.executeTransaction(async function () {
			let collections = item.getCollections();
			attachment.parentItemID = null
			attachment.setCollections(collections);
			await attachment.save();
			
			await item.erase();
		}.bind(this));
	};
	
	
	/**
	 * Send user-requested feedback only to the service that recognized this item
	 * in this session. EpiLib intentionally has no document-feedback storage.
	 * @param {Zotero.Item} item - Recognized parent item, not the PDF attachment.
	 * @param {string} description - User-supplied explanation of the incorrect match.
	 * @returns {Promise<void>} Resolves after the original service accepts feedback.
	 */
	this.report = async function (item, description) {
		let configuration = _recognitionOrigins.get(item);
		if (!configuration || configuration.engine != 'zotero') {
			throw new Error(Zotero.getString('recognition-feedback-unavailable'));
		}
		var attachment = Zotero.Items.get(item.getAttachments()[0]);
		var filePath = await attachment.getFilePath();
		if (!filePath || !(await OS.File.exists(filePath))) {
			throw new Error("File not found when reporting metadata");
		}
		
		var version = Zotero.version;
		var json = await extractPDFJSON(attachment.id);
		var metadata = item.toJSON();
		
		var data = { description, version, json, metadata };
		await _request(configuration, 'report', data, [200, 204]);
	};
	
	
	/**
	 * Processes the item and places it as a children of the new item
	 * @param itemID
	 * @return {Promise} A promise that resolves to a newly created, recognized parent item
	 */
	async function _processItem(attachment) {
		Zotero.debug(`RecognizeDocument: Recognizing attachment ${attachment.getDisplayTitle()}`);
		// Make sure the attachment still doesn't have a parent
		if (attachment.parentItemID) {
			throw new Error('Already has parent');
		}
		
		var zp = Zotero.getActiveZoteroPane();
		var selectParent = false;
		if (zp) {
			let selected = zp.getSelectedItems();
			if (selected.length) {
				// If only the attachment was selected, select the parent when we're done
				selectParent = selected.length == 1 && selected[0] == attachment;
			}
		}
		
		let parentItem = await Zotero.RecognizeDocument._recognize(attachment);
		if (!parentItem) {
			Zotero.debug(`RecognizeDocument: No matches for attachment ${attachment.getDisplayTitle()}`);
			throw new Zotero.Exception.Alert("recognizePDF.noMatches");
		}
		Zotero.debug(`RecognizeDocument: Recognized attachment ${attachment.getDisplayTitle()}`);
		
		// Put new item in same collections as the old one
		let collections = attachment.getCollections();
		await Zotero.DB.executeTransaction(async function () {
			if (collections.length) {
				for (let collectionID of collections) {
					parentItem.addToCollection(collectionID);
				}
				await parentItem.save();
			}
			
			// Put old item as a child of the new item
			attachment.parentID = parentItem.id;
			await attachment.save();
		});
		
		var originalTitle = attachment.getField('title');
		var path = attachment.getFilePath();
		var originalFilename = PathUtils.filename(path);
		
		// Rename attachment file to match new metadata
		if (Zotero.Attachments.shouldAutoRenameAttachment(attachment)) {
			let fileBaseName = Zotero.Attachments.getFileBaseNameFromItem(parentItem, { attachmentTitle: originalTitle });
			let ext = Zotero.Attachments.getCorrectFileExtension(attachment);
			let newName = fileBaseName + (ext ? '.' + ext : '');
			let result = await attachment.renameAttachmentFile(newName, { overwrite: false, unique: true });
			if (result !== true) {
				throw new Error("Error renaming " + path);
			}
			attachment.setAutoAttachmentTitle();
			await attachment.saveTx();
		}

		try {
			let win = Zotero.getMainWindow();
			if (selectParent && win && win.Zotero_Tabs.selectedID == 'zotero-pane') {
				await win.ZoteroPane.selectItem(parentItem.id);
			}
		}
		catch (e) {
			Zotero.logError(e);
		}
		
		_newItems.set(
			parentItem,
			{
				originalTitle,
				originalFilename,
				dateModified: parentItem.dateModified
			}
		);
		return parentItem;
	}
	
	/**
	 * Get recognizer data from PDF file
	 * @param {Number} itemID Attachment item id
	 * @return {Promise}
	 */
	async function extractPDFJSON(itemID) {
		try {
			return await Zotero.PDFWorker.getRecognizerData(itemID, true);
		}
		catch (e) {
			Zotero.logError(e);
			throw new Zotero.Exception.Alert("recognizePDF.couldNotRead");
		}
	}
	
	/**
	 * Attach appropriate handlers to a Zotero.Translate instance and begin translation
	 * @return {Promise}
	 */
	async function _promiseTranslate(translate, libraryID) {
		translate.setHandler('select', function (translate, items, callback) {
			for (let i in items) {
				let obj = {};
				obj[i] = items[i];
				callback(obj);
				return;
			}
		});
		
		let newItems = await translate.translate({
			libraryID,
			saveAttachments: false
		});
		if (newItems.length) {
			return newItems[0];
		}
		throw new Error('No items found');
	}
	
	/**
	 * Validate a recognition API base URL, without rewriting the saved preference.
	 * Credentials belong in authentication headers, never in URLs or query strings.
	 * A trailing slash ensures that appending "health" or "recognize" keeps the
	 * configured path instead of accidentally merging it with the operation name.
	 * @param {string} value - Absolute HTTP(S) base URL.
	 * @returns {string} Canonical URL with a trailing slash.
	 */
	function _normalizeRecognitionURL(value) {
		try {
			let url = new URL(value.trim());
			if (!['https:', 'http:'].includes(url.protocol)
					|| url.username || url.password || url.search || url.hash) {
				throw new Error('Invalid recognition URL');
			}
			if (!url.pathname.endsWith('/')) url.pathname += '/';
			return url.href;
		}
		catch (_e) {
			throw new Error(Zotero.getString('recognition-url-invalid'));
		}
	}

	/**
	 * Return the account-authenticated gateway used when no override is saved.
	 * This is also the settings field's placeholder, so its fallback stays visible
	 * without storing a duplicate URL that would stop following Account Settings.
	 * @returns {string} Gateway base URL, not the private worker's address.
	 */
	this.getDefaultRecognitionURL = function () {
		let server;
		try {
			server = Zotero.Sync.Metadata.getPostgreSQLBaseURL();
		}
		catch (_e) {
			throw new Error(Zotero.getString('recognition-server-required'));
		}
		if (!server) throw new Error(Zotero.getString('recognition-server-required'));
		return _normalizeRecognitionURL(server + 'recognizer/');
	};

	/**
	 * Resolve the EpiLib override independently of the selected engine. Requests
	 * use this again after asynchronous work to detect destination/auth changes.
	 * Only the exact account gateway may receive the account token. A different
	 * path, port, scheme, or hostname is a separate service and is anonymous; we
	 * must not grant it sync-account access merely because its URL was typed here.
	 * @returns {{baseURL: string, accountURL: string|null}} No credentials retained.
	 */
	function _getEpiLibConfiguration() {
		let override = (Zotero.Prefs.get('recognize.epilib.url') || '').trim();
		let accountURL = null;
		try {
			accountURL = Zotero.RecognizeDocument.getDefaultRecognitionURL();
		}
		catch (error) {
			if (!override) throw error;
		}
		let baseURL = override ? _normalizeRecognitionURL(override) : accountURL;
		return { baseURL, accountURL: baseURL == accountURL ? accountURL : null };
	}

	/** Supported fields are explicit so passwords cannot become arbitrary request options. */
	this.providerCredentialNames = Object.freeze([
		'googleBooks', 'openAlex', 'semanticScholar', 'pubmed', 'crossref', 'worldcatClientID', 'worldcatClientSecret'
	]);

	/** Bind personal keys to one destination and local account, never to every recognizer. */
	this.getProviderCredentialScope = function () {
		// Retain saved keys from the former gateway without ever contacting it.
		// A fresh local-only installation needs neither a server URL nor login.
		if (Zotero.Prefs.get('recognize.engine') == 'epilib-local') {
			try { return { baseURL: _getEpiLibConfiguration().baseURL, userID: Zotero.Users.getCurrentUserID() || 0 }; }
			catch { return { baseURL: 'epilib-local:', userID: Zotero.Users.getCurrentUserID() || 0 }; }
		}
		return { baseURL: _getEpiLibConfiguration().baseURL, userID: Zotero.Users.getCurrentUserID() || 0 };
	};

	let _providerCredentialRevision = 0;

	/** Retain the exact legacy scope; migrate into a separate OS-protected realm. */
	function _providerCredentialDescriptor(scope) {
		const legacyRealm = 'EpiLib PDF provider credentials: ' + JSON.stringify([scope.baseURL, scope.userID]);
		return { realm: legacyRealm + ' [OSKeyStore v1]', legacyRealm, username: 'providerKeys' };
	}

	/** Cancel a delayed keychain operation if the UI changed account or a newer save began. */
	function _providerCredentialGuard(scope, revision) {
		return () => {
			if (revision != _providerCredentialRevision
				|| JSON.stringify(scope) != JSON.stringify(Zotero.RecognizeDocument.getProviderCredentialScope())) {
				throw new Error(Zotero.getString('recognition-server-changed'));
			}
		};
	}

	/** Reject malformed keys before touching stored credentials; never echo their values. */
	function _validateProviderCredentials(keys) {
		if (!keys || typeof keys != 'object' || Array.isArray(keys)) {
			throw new Error(Zotero.getString('recognition-provider-keys-invalid'));
		}
		let clean = {};
		for (let [name, value] of Object.entries(keys)) {
			if (!Zotero.RecognizeDocument.providerCredentialNames.includes(name) || typeof value != 'string'
					|| !value.trim() || value.length > 512 || /[\x00-\x1f\x7f]/.test(value)) {
				throw new Error(Zotero.getString('recognition-provider-keys-invalid'));
			}
			clean[name] = value.trim();
		}
		if (!!clean.worldcatClientID != !!clean.worldcatClientSecret) {
			throw new Error(Zotero.getString('recognition-provider-worldcat-pair'));
		}
		return clean;
	}

	/** Read/migrate the full set through the OS keychain, never ordinary preferences. */
	this.getProviderCredentials = async function (scope = this.getProviderCredentialScope()) {
		const secret = await Zotero.CredentialStore.get(_providerCredentialDescriptor(scope), {
			guard: _providerCredentialGuard(scope, _providerCredentialRevision), validate: _validateProviderSecret
		});
		return secret === null ? {} : _validateProviderSecret(secret);
	};

	/** A corrupt legacy JSON blob must not overwrite a working encrypted set. */
	function _validateProviderSecret(secret) {
		let keys;
		try { keys = JSON.parse(secret); }
		catch { throw new Error(Zotero.getString('recognition-provider-keys-invalid')); }
		return _validateProviderCredentials(keys);
	}

	/** Save a complete set after checking that the settings pane still targets the same account. */
	this.setProviderCredentials = async function (keys, scope = this.getProviderCredentialScope()) {
		let clean = _validateProviderCredentials(keys);
		const guard = _providerCredentialGuard(scope, ++_providerCredentialRevision);
		guard();
		const descriptor = _providerCredentialDescriptor(scope);
		if (!Object.keys(clean).length) {
			return Zotero.CredentialStore.remove(descriptor, guard);
		}
		return Zotero.CredentialStore.set(descriptor, JSON.stringify(clean), { guard, validate: _validateProviderSecret });
	};

	/**
	 * Snapshot the selected engine and destination before starting asynchronous PDF
	 * work. Tokens are deliberately NOT stored here or in the feedback-origin map.
	 * Legacy URL overrides apply only to the explicitly selected Zotero service.
	 * @returns {object} Immutable engine/destination, local fallback preferences,
	 * and cancellation revision. No password or API token is retained.
	 */
	this.getRecognitionConfiguration = function () {
		let engine = Zotero.Prefs.get('recognize.engine');
		if (engine == 'epilib-local') {
			return Object.freeze({ engine: 'epilib', execution: 'local', baseURL: null, accountURL: null,
				credentialScope: this.getProviderCredentialScope(),
				credentialUserID: Zotero.Users.getCurrentUserID() || 0,
				grobidEnabled: Zotero.Prefs.get('recognize.grobid.enabled'),
				grobidURL: Zotero.Prefs.get('recognize.grobid.url'), cancelRevision: _cancelRevision });
		}
		let baseURL;
		let accountURL = null;
		if (engine == 'zotero') {
			baseURL = _normalizeRecognitionURL(_getBaseURL());
		}
		else if (engine == 'epilib') {
			({ baseURL, accountURL } = _getEpiLibConfiguration());
		}
		else {
			throw new Error(Zotero.getString('recognition-engine-invalid'));
		}
		return Object.freeze({ engine, baseURL, accountURL, credentialUserID: Zotero.Users.getCurrentUserID() || 0,
			grobidEnabled: engine == 'epilib' && Zotero.Prefs.get('recognize.grobid.enabled'),
			grobidURL: Zotero.Prefs.get('recognize.grobid.url'), cancelRevision: _cancelRevision });
	};

	/**
	 * Perform a single-provider request. Never retry against another engine, follow
	 * redirects, log PDF text, or send the PostgreSQL token to Zotero. A server change
	 * during extraction/token retrieval aborts the request instead of leaking a token.
	 * @param {object} configuration - Snapshot from getRecognitionConfiguration().
	 * @param {'recognize'|'health'|'report'} endpoint - Relative API operation.
	 * @param {object} [body] - Extracted PDF data; omitted for a health check.
	 * @param {number[]} [successCodes] - Accepted HTTP statuses.
	 * @returns {Promise<XMLHttpRequest>} Successful response, without JSON parsing.
	 */
	async function _request(configuration, endpoint, body, successCodes = [200]) {
		if (endpoint == 'recognize' && configuration.cancelRevision != _cancelRevision) {
			throw new Error(Zotero.getString('recognition-cancelled'));
		}
		let headers = { 'Content-Type': 'application/json' };
		if (configuration.engine == 'epilib') {
			// Compare both destination and authentication scope: an old gateway URL
			// can remain in the override after the user switches metadata accounts.
			let assertCurrentServer = () => {
				let current = _getEpiLibConfiguration();
				if (configuration.baseURL != current.baseURL || configuration.accountURL != current.accountURL
						|| configuration.credentialUserID != (Zotero.Users.getCurrentUserID() || 0)) {
					throw new Error(Zotero.getString('recognition-server-changed'));
				}
			};
			assertCurrentServer();
			if (configuration.accountURL) {
				let key = await Zotero.Sync.Metadata.getPostgreSQLAPIKey();
				assertCurrentServer();
				if (!key) throw new Error(Zotero.getString('recognition-login-required'));
				headers['Zotero-API-Key'] = key;
			}
			if (endpoint == 'recognize') {
				let keys = await Zotero.RecognizeDocument.getProviderCredentials({
					baseURL: configuration.baseURL, userID: configuration.credentialUserID });
				assertCurrentServer();
				// Ignore caller-injected credentials. Only the scoped login-manager set
				// may cross the network, and never to Zotero, feedback or local GROBID.
				body = { ...body };
				delete body.providerKeys;
				if (Object.keys(keys).length) {
					let url = new URL(configuration.baseURL);
					if (url.protocol != 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
						throw new Error(Zotero.getString('recognition-provider-keys-https'));
					}
					// Older workers ignore unknown input fields. Check capability first
					// so a saved key cannot silently fail to enable its provider.
					let health = _parseResponse(await _request(configuration, 'health'));
					assertCurrentServer();
					if (health?.engine != 'epilib' || health.providerCredentials !== 1) {
						throw new Error(Zotero.getString('recognition-provider-keys-upgrade'));
					}
					body.providerKeys = keys;
				}
			}
		}
		else if (body && Object.hasOwn(body, 'providerKeys')) {
			body = { ...body };
			delete body.providerKeys;
		}
		let response;
		if (endpoint == 'recognize' && configuration.cancelRevision != _cancelRevision) {
			throw new Error(Zotero.getString('recognition-cancelled'));
		}
		try {
			response = await Zotero.HTTP.request(body === undefined ? 'GET' : 'POST',
				configuration.baseURL + endpoint, {
					headers,
					body: body === undefined ? undefined : JSON.stringify(body),
					logBodyLength: 0,
					anon: true,
					followRedirects: false,
					timeout: 30000,
					errorDelayMax: 0,
					successCodes
				});
			// HTTP.request returns redirects when following is disabled, even if the
			// status is outside successCodes. Reject before consuming their contents.
			if (!successCodes.includes(response.status)) throw new Error('Unexpected status');
		}
		catch (e) {
			let status = e.status || response?.status;
			if (status == 401 || status == 403) {
				throw new Error(Zotero.getString(configuration.engine == 'epilib' && !configuration.accountURL
					? 'recognition-custom-access-denied' : 'recognition-access-denied'));
			}
			throw new Error(Zotero.getString('recognition-request-failed'));
		}
		return response;
	}

	/** Parse JSON without echoing a possibly sensitive HTML/error response. */
	function _parseResponse(response) {
		try {
			return JSON.parse(response.responseText);
		}
		catch (_e) {
			throw new Error(Zotero.getString('recognition-response-invalid'));
		}
	}

	/**
	 * Query either engine using the existing extraction payload and recognition
	 * response contract. Null is a valid no-match result; malformed results must
	 * never reach item creation and create a partial bibliographic record.
	 * @param {object} json - PDF worker output plus fileName, unchanged.
	 * @param {object} [configuration] - Optional already-captured provider snapshot.
	 * @returns {Promise<object|null>} Identifier or bibliographic recognition result.
	 */
	this.queryPDFMetadata = async function (json, configuration = this.getRecognitionConfiguration()) {
		let result;
		if (configuration.execution == 'local') {
			const assertCurrent = () => {
				if (configuration.cancelRevision != _cancelRevision) throw new Error(Zotero.getString('recognition-cancelled'));
				if (Zotero.Prefs.get('recognize.engine') != 'epilib-local'
					|| JSON.stringify(configuration.credentialScope) != JSON.stringify(this.getProviderCredentialScope())) {
					throw new Error(Zotero.getString('recognition-server-changed'));
				}
			};
			assertCurrent();
			const keys = await this.getProviderCredentials(configuration.credentialScope);
			assertCurrent();
			const payload = { ...json };
			delete payload.providerKeys;
			result = await Zotero.LocalRecognition.recognize(payload, keys, JSON.stringify(configuration.credentialScope));
			assertCurrent();
		}
		else result = _parseResponse(await _request(configuration, 'recognize', json));
		if (result === null) return null;
		if (configuration.engine == 'epilib' && result?.version == 2 && result.engine == 'epilib') {
			if (result.status == 'no_match') return result;
			if (result.review) result.review = _validateReview(result.review);
			if (result.status == 'matched') {
				result.item = _validateResolvedItem(result.item);
				return result;
			}
			if (result.status == 'needs_review' && Array.isArray(result.candidates)
					&& result.candidates.length > 0 && result.candidates.length <= 5) {
				for (let candidate of result.candidates) candidate.item = _validateResolvedItem(candidate.item);
				return result;
			}
			throw new Error(Zotero.getString('recognition-response-invalid'));
		}
		let fields = ['doi', 'arxiv', 'isbn', 'title'];
		if (!result || typeof result != 'object' || Array.isArray(result)
				|| !fields.some(key => typeof result[key] == 'string' && result[key].trim())
				|| fields.some(key => result[key] !== undefined && typeof result[key] != 'string')
				|| (result.title && (!Array.isArray(result.authors) || result.authors.some(author => (
					!author || (author.firstName !== undefined && typeof author.firstName != 'string')
					|| typeof author.lastName != 'string'
				))))) {
			throw new Error(Zotero.getString('recognition-response-invalid'));
		}
		return result;
	};

	/** Verify EpiLib protocol availability without extracting or uploading a PDF. */
	this.verifyRecognitionServer = async function () {
		let configuration = this.getRecognitionConfiguration();
		if (configuration.execution == 'local') {
			return { engine: 'epilib', version: 2, protocol: 'epilib-recognition-v2', execution: 'local' };
		}
		if (configuration.engine != 'epilib') throw new Error(Zotero.getString('recognition-engine-invalid'));
		let result = _parseResponse(await _request(configuration, 'health'));
		if (result?.engine != 'epilib' || !((result.version == 1 && result.protocol == 'zotero-recognizer-json')
				|| (result.version == 2 && result.protocol == 'epilib-recognition-v2'))) {
			throw new Error(Zotero.getString('recognition-response-invalid'));
		}
		return result;
	};

	/**
	 * Accept only bibliographic fields from the worker, never record identities,
	 * children, library assignments, HTML notes, or sync state. Unknown fields are
	 * omitted and fields invalid for the selected item type cannot reach fromJSON.
	 */
	function _validateResolvedItem(record) {
		let types = ['journalArticle', 'book', 'bookSection', 'conferencePaper', 'thesis', 'report', 'preprint'];
		if (!record || !types.includes(record.itemType) || typeof record.title != 'string'
				|| !record.title.trim() || record.title.length > 4000 || !Array.isArray(record.creators)
				|| record.creators.length > 200) throw new Error(Zotero.getString('recognition-response-invalid'));
		let clean = { itemType: record.itemType, title: record.title, creators: [] };
		for (let creator of record.creators) {
			if (!creator || typeof creator != 'object'
					|| !(typeof creator.lastName == 'string' || typeof creator.name == 'string')) {
				throw new Error(Zotero.getString('recognition-response-invalid'));
			}
			clean.creators.push(typeof creator.name == 'string'
				? { creatorType: 'author', name: creator.name.slice(0, 4000) }
				: { creatorType: 'author', firstName: typeof creator.firstName == 'string' ? creator.firstName.slice(0, 4000) : '',
					lastName: creator.lastName.slice(0, 4000) });
		}
		let typeID = Zotero.ItemTypes.getID(record.itemType);
		for (let field of ['DOI', 'ISBN', 'ISSN', 'date', 'publicationTitle', 'volume', 'issue', 'pages',
			'bookTitle', 'proceedingsTitle', 'publisher', 'url', 'libraryCatalog', 'archiveID', 'repository',
			'abstractNote', 'language', 'rights', 'university', 'institution', 'conferenceName',
			'eventPlace', 'place', 'series', 'seriesNumber', 'edition', 'shortTitle',
			'thesisType', 'reportNumber', 'numPages']) {
			// Abstracts are bibliographic text, not executable notes. Give them a
			// larger bounded allowance while keeping all fields type-checked.
			let limit = field == 'abstractNote' ? 20000 : 4000;
			if (typeof record[field] != 'string' || record[field].length > limit) continue;
			if (field == 'url' && !/^https?:\/\//i.test(record[field])) continue;
			let id = Zotero.ItemFields.getID(field);
			if (id && Zotero.ItemFields.isValidForType(id, typeID)) clean[field] = record[field];
			else if (field == 'DOI' && record.DOI) clean.extra = `DOI: ${record.DOI.replace(/[\r\n]/g, '')}`;
			// Older schemas may lack an ISBN field for a recognized item type.
			// Preserve only a valid identifier, never server-supplied Extra text.
			else if (field == 'ISBN' && record.ISBN) {
				let isbn = Zotero.Utilities.cleanISBN(record.ISBN);
				if (isbn) clean.extra = [clean.extra, `ISBN: ${isbn}`].filter(Boolean).join('\n');
			}
		}
		// A published paper has no archiveID field. Preserve only a validated
		// alternate arXiv identifier in Extra, never arbitrary provider Extra text.
		let arxiv = record.alternateIdentifiers?.arxiv;
		if (typeof arxiv == 'string' && /^(?:\d{4}\.\d{4,5}|[a-z.-]+\/\d{7})$/i.test(arxiv)) {
			clean.extra = [clean.extra, `arXiv: ${arxiv}`].filter(Boolean).join('\n');
		}
		// Import subject labels only. Do not trust provider-supplied tag objects,
		// identifiers or manual-tag flags; recognized subjects are automatic tags.
		if (Array.isArray(record.tags)) {
			clean.tags = [...new Set(record.tags.filter(tag => typeof tag?.tag == 'string'
				&& tag.tag.trim() && tag.tag.length <= 255).map(tag => tag.tag.trim()))]
				.slice(0, 100).map(tag => ({ tag, type: 1 }));
		}
		return clean;
	}

	/**
	 * Validate comparison records at the same boundary as ordinary recognition.
	 * Provider labels are plain text; field selectors can reference only validated
	 * bibliographic fields, never item type/identity or prototype properties.
	 */
	function _validateReview(review) {
		if (!Array.isArray(review.sources) || !review.sources.length || review.sources.length > 21) {
			throw new Error(Zotero.getString('recognition-response-invalid'));
		}
		let ids = new Set();
		let blocked = ['itemType', 'DOI', 'url', 'archiveID', 'repository', 'extra', 'libraryCatalog', 'citationKey'];
		let sources = review.sources.map(source => {
			if (!/^[a-z0-9-]{1,40}$/.test(source.id) || source.id == 'custom' || ids.has(source.id)
					|| typeof source.label != 'string' || source.label.length > 100) {
				throw new Error(Zotero.getString('recognition-response-invalid'));
			}
			ids.add(source.id);
			let item = _validateResolvedItem(source.item);
			let mergeFields = Array.isArray(source.mergeFields) ? source.mergeFields
				.filter(field => Object.hasOwn(item, field) && !blocked.includes(field)) : [];
			return { id: source.id, label: source.label, item, mergeFields };
		});
		let item = _validateResolvedItem(review.custom?.item);
		let fieldSources = Object.fromEntries(Object.entries(review.custom?.fieldSources || {})
			.filter(([field, id]) => Object.hasOwn(item, field) && ids.has(id)));
		let providers = (Array.isArray(review.providers) ? review.providers : []).slice(0, 16)
			.filter(p => typeof p.name == 'string' && p.name.length <= 100
				&& ['matched', 'no_match', 'unavailable', 'not_configured'].includes(p.status))
			.map(p => ({ name: p.name, status: p.status }));
		return { sources, custom: { item, fieldSources }, providers };
	}

	/**
	 * Open a native comparison window with source records and a combined option.
	 * Only the accepted output leaves the dialog; browsing/closing makes no edits.
	 * Older workers still get a source list, but cannot authorize cross-source merges.
	 */
	this.chooseRecognitionCandidate = function (candidates, options = {}) {
		if (!candidates.length) return null;
		let review = options.review || {
			sources: candidates.map((candidate, i) => ({ id: 'candidate-' + i,
				label: candidate.item.libraryCatalog || Zotero.getString('recognition-review-result'),
				item: candidate.item, mergeFields: [] })),
			custom: { item: candidates[0].item, fieldSources: {} }, providers: []
		};
		let io = { review, refresh: !!options.refresh, requiredDOI: options.requiredDOI,
			allowedTypes: options.allowedTypes, out: null, replaceExisting: false };
		let args = ['chrome://zotero/content/recognitionReview.xhtml', '', 'chrome,modal,centerscreen,resizable', io];
		let win = Zotero.getMainWindow();
		if (win) win.openDialog(...args);
		else {
			io.wrappedJSObject = io;
			Services.ww.openWindow(null, ...args);
		}
		options.replaceExisting = io.replaceExisting;
		return io.out;
	};

	/**
	 * Offer refresh for supported bibliographic items, including DOI-less records.
	 * Recognition can resolve their title/byline or ISBN; a DOI is not mandatory.
	 * Attachments still use Retrieve Metadata, and read-only/deleted items cannot change.
	 */
	this.canRefreshMetadata = function (item) {
		let types = ['preprint', 'journalArticle', 'conferencePaper', 'bookSection', 'book', 'thesis', 'report'];
		return !!(['epilib', 'epilib-local'].includes(Zotero.Prefs.get('recognize.engine'))
			&& item && types.some(type => item.itemTypeID == Zotero.ItemTypes.getID(type))
			&& !item.deleted && !item.isFeedItem && item.isEditable());
	};

	/** Publication upgrades are a separate action; ordinary refresh never changes type. */
	this.canRefreshPublishedMetadata = function (item) {
		return this.canRefreshMetadata(item) && item.itemTypeID == Zotero.ItemTypes.getID('preprint');
	};

	/** Explicitly opt into replacing a preprint's bibliographic version after review. */
	this.refreshPublishedMetadata = function (item) {
		return this.refreshMetadata(item, { publishedOnly: true });
	};

	/**
	 * Citation keys are local labels, not DOI metadata. Generate one only when
	 * absent; the native item key disambiguates author/year/title collisions in
	 * this library and keeps the label stable across sync and later refreshes.
	 * Never accept a provider's CSL `id` or replace a user/plugin-defined key.
	 */
	function _ensureCitationKey(item) {
		if (item.getField('citationKey')) return;
		if (!item.key) throw new Error('Save the item before generating a citation key');
		let normalize = value => value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
			.replace(/[^a-zA-Z0-9]/g, '');
		let author = item.getCreators().find(c => c.creatorTypeID == Zotero.CreatorTypes.getID('author'));
		let family = author?.fieldMode ? author.lastName.split(/\s+/).pop() : author?.lastName;
		let name = normalize(family || '').slice(0, 40) || 'anon';
		let year = item.getField('date').match(/\b(?:19|20)\d{2}\b/)?.[0] || 'nd';
		let title = item.getField('title').split(/\s+/).map(normalize)
			.filter(word => word && !/^(a|an|the|in|of|to|for|and)$/i.test(word)).slice(0, 3).join('').slice(0, 60);
		item.setField('citationKey', `${name.toLowerCase()}${year}${title}-${item.key}`);
	}

	/**
	 * Resolve an existing record using its bibliographic identifiers/byline, then
	 * ask before filling missing fields. Only the separate publication action opts
	 * into a type change; ordinary refresh restricts review to the current type/DOI.
	 * No temporary parent is created, no PDF is
	 * uploaded, and attachments, annotations, collections and tags are untouched.
	 * Compare a snapshot again inside the transaction to avoid overwriting an edit
	 * or sync that completed while the network request/confirmation was pending.
	 * @param {Zotero.Item} item - Saved bibliographic item to enrich in place.
	 * @param {Object} [options]
	 * @param {boolean} [options.publishedOnly=false] - Require a preprint upgrade.
	 * @returns {Promise<boolean>} Whether the user accepted the metadata update.
	 */
	this.refreshMetadata = async function (item, { publishedOnly = false } = {}) {
		let canRefresh = () => publishedOnly ? this.canRefreshPublishedMetadata(item) : this.canRefreshMetadata(item);
		if (!canRefresh()) throw new Error(Zotero.getString('recognition-refresh-unavailable'));
		let before = JSON.stringify(item.toJSON());
		let preprint = item.itemTypeID == Zotero.ItemTypes.getID('preprint');
		let configuration = this.getRecognitionConfiguration();
		let metadata = { Title: item.getField('title'), Author: item.getCreators()
			.map(c => [c.firstName, c.lastName].filter(Boolean).join(' ')).join('; ') };
		let arxiv = preprint ? item.getField('archiveID').replace(/^arxiv:\s*/i, '').replace(/v\d+$/i, '') : '';
		if (/^(?:\d{4}\.\d{4,5}|[a-z.-]+\/\d{7})$/i.test(arxiv)) metadata.arxiv = arxiv;
		else if (item.getField('DOI')) metadata.DOI = item.getField('DOI');
		if (['book', 'bookSection'].includes(Zotero.ItemTypes.getName(item.itemTypeID)) && item.getField('ISBN')) {
			metadata.ISBN = item.getField('ISBN');
		}
		let result = await this.queryPDFMetadata({ metadata, totalPages: 0, pages: [], includeAlternatives: true }, configuration);
		let candidates = result?.status == 'matched' ? [{ item: result.item }] : result?.candidates || [];
		let selection = { review: result?.review, refresh: true,
			requiredDOI: publishedOnly ? null : item.getField('DOI'),
			allowedTypes: publishedOnly ? ['conferencePaper', 'journalArticle', 'bookSection'] : [Zotero.ItemTypes.getName(item.itemTypeID)] };
		let canAccept = record => selection.allowedTypes.includes(record.itemType)
			&& (!selection.requiredDOI || record.DOI?.toLowerCase() == selection.requiredDOI.toLowerCase());
		// The engine may rank a publication ahead of its preprint. Inspect all
		// validated alternatives so refresh can still review the current version.
		if (result?.review) {
			candidates = candidates.concat(result.review.sources, { item: result.review.custom.item });
		}
		candidates = candidates.filter(({ item: record }) => canAccept(record));
		if (!candidates.length) throw new Error(Zotero.getString('recognition-refresh-no-publication'));
		let record = this.chooseRecognitionCandidate(candidates, selection);
		if (!record) return false;
		if (!canAccept(record)) {
			throw new Error(Zotero.getString('recognition-refresh-no-publication'));
		}
		if (configuration.cancelRevision != _cancelRevision) throw new Error(Zotero.getString('recognition-cancelled'));
		await Zotero.DB.executeTransaction(async () => {
			if (!canRefresh() || JSON.stringify(item.toJSON()) != before) {
				throw new Error(Zotero.getString('recognition-refresh-changed'));
			}
			// Existing publications fill blanks unless replacement was explicitly
			// checked. A preprint upgrade changes type/date/venue, never citation keys.
			// Preserve user Extra and repository identifiers. Do not carry a preprint
			// DOI into the published DOI field when the publication has no DOI.
			let extra = [item.getField('extra'), record.extra];
			if (arxiv && !record.extra?.includes(`arXiv: ${arxiv}`)) extra.push(`arXiv: ${arxiv}`);
			let oldDOI = item.getField('DOI');
			if (publishedOnly && oldDOI && oldDOI != record.DOI) extra.push(`Preprint DOI: ${oldDOI}`);
			item.setType(Zotero.ItemTypes.getID(record.itemType));
			if (publishedOnly) item.setField('DOI', record.DOI || '');
			for (let [field, value] of Object.entries(record)) {
				if (['itemType', 'creators', 'tags', 'extra', 'citationKey'].includes(field) || !value) continue;
				if (!publishedOnly && !selection.replaceExisting && item.getField(field)) continue;
				item.setField(field, value);
			}
			if (record.creators.length && (publishedOnly || selection.replaceExisting || !item.getCreators().length)) item.setCreators(record.creators);
			item.setField('extra', [...new Set(extra.filter(Boolean))].join('\n'));
			_ensureCitationKey(item);
			await item.save();
		});
		return true;
	};

	/** Validate before opening a file: local extraction must never become remote upload. */
	this.getLocalGROBIDURL = function (value = Zotero.Prefs.get('recognize.grobid.url')) {
		let url;
		try { url = new URL(value); }
		catch (_error) { throw new Error(Zotero.getString('recognition-grobid-url-invalid')); }
		if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', '[::1]'].includes(url.hostname)
				|| url.username || url.password || url.search || url.hash) {
			throw new Error(Zotero.getString('recognition-grobid-url-invalid'));
		}
		if (!url.pathname.endsWith('/')) url.pathname += '/';
		return url.href;
	};

	/** Check only liveness; this never starts/installs GROBID or submits a document. */
	this.verifyLocalGROBID = async function () {
		let url = this.getLocalGROBIDURL();
		try {
			let response = await Zotero.HTTP.request('GET', url + 'api/isalive', {
				anon: true, followRedirects: false, timeout: 5000, errorDelayMax: 0, logBodyLength: 0
			});
			if (response.status != 200 || response.responseText.trim() != 'true') throw new Error();
		}
		catch (_error) { throw new Error(Zotero.getString('recognition-grobid-failed')); }
	};

	/**
	 * Convert TEI header output to a minimal second lookup request. GROBID performs
	 * extraction only (consolidation is disabled below), while the EpiLib worker
	 * resolves these hints through the same audited provider/matching path.
	 */
	this.parseGROBIDHeader = function (xml) {
		if (typeof xml != 'string' || xml.length > 1024 * 1024 || /<!DOCTYPE|<!ENTITY/i.test(xml)) {
			throw new Error(Zotero.getString('recognition-grobid-failed'));
		}
		let doc = new DOMParser().parseFromString(xml, 'application/xml');
		let ns = 'http://www.tei-c.org/ns/1.0';
		let header = doc.getElementsByTagNameNS(ns, 'teiHeader')[0];
		if (!header || doc.getElementsByTagName('parsererror').length) throw new Error(Zotero.getString('recognition-grobid-failed'));
		let analytic = header.getElementsByTagNameNS(ns, 'analytic')[0];
		let title = (analytic || header).getElementsByTagNameNS(ns, 'title')[0]?.textContent.trim() || '';
		let authors = [...(analytic || header).getElementsByTagNameNS(ns, 'persName')].map(node => {
			let parts = [...node.getElementsByTagNameNS(ns, 'forename'), ...node.getElementsByTagNameNS(ns, 'surname')];
			return parts.length ? parts.map(part => part.textContent.trim()).join(' ') : node.textContent.trim();
		}).join(' ');
		let date = header.getElementsByTagNameNS(ns, 'date')[0];
		let year = (date?.getAttribute('when') || date?.textContent || '').match(/\b\d{4}\b/)?.[0] || '';
		let dois = [...header.getElementsByTagNameNS(ns, 'idno')]
			.filter(node => node.getAttribute('type')?.toLowerCase() == 'doi').map(node => node.textContent.trim());
		if (!title && !dois.length) throw new Error(Zotero.getString('recognition-grobid-failed'));
		return { totalPages: 0, pages: [], metadata: { DOI: dois.join(' ') },
			hints: { title: title.slice(0, 500), author: authors.slice(0, 200), year } };
	};

	/**
	 * Send at most 50 MB to an explicitly enabled, already-running local service.
	 * One queue item runs at a time; cancel aborts its XHR. No session credentials,
	 * cookies, redirects, full-text logs, or PDF uploads to the remote worker occur.
	 */
	this.extractLocalGROBID = async function (filePath, configuration) {
		let url = this.getLocalGROBIDURL(configuration.grobidURL);
		if ((await IOUtils.stat(filePath)).size > 50 * 1024 * 1024) {
			throw new Error(Zotero.getString('recognition-grobid-too-large'));
		}
		Components.utils.importGlobalProperties(['File', 'FormData']);
		let file = await File.createFromFileName(filePath);
		let body = new FormData();
		body.append('input', file, 'document.pdf');
		body.append('consolidateHeader', '0');
		body.append('start', '0');
		body.append('end', '2');
		try {
			if (configuration.cancelRevision != _cancelRevision) throw new Error('Cancelled');
			let response = await Zotero.HTTP.request('POST', url + 'api/processHeaderDocument', {
				body, headers: { 'Content-Type': 'multipart/form-data', Accept: 'application/xml' },
				anon: true, followRedirects: false, timeout: 60000, errorDelayMax: 0, logBodyLength: 0,
				requestObserver: xhr => { _localRequest = xhr; }
			});
			if (response.status != 200) throw new Error('Unexpected status');
			return this.parseGROBIDHeader(response.responseText);
		}
		catch (_error) { throw new Error(Zotero.getString('recognition-grobid-failed')); }
		finally { _localRequest = null; }
	};
	
	/**
	 * Retrieves metadata for a PDF or EPUB and saves it as an item
	 * @param {Zotero.Item} item
	 * @return {Promise<Zotero.Item>} - New item
	 */
	this._recognize = async function (item) {
		let configuration = item.isPDFAttachment() ? this.getRecognitionConfiguration() : null;
		let filePath = await item.getFilePath();
		
		if (!filePath || !(await OS.File.exists(filePath))) throw new Zotero.Exception.Alert('recognizePDF.fileNotFound');

		if (item.isPDFAttachment()) {
			let parent = await _recognizePDF(item, filePath, configuration);
			if (parent) _recognitionOrigins.set(parent, configuration);
			return parent;
		}
		else if (item.isEPUBAttachment()) {
			return _recognizeEPUB(item, filePath);
		}
		else {
			throw new Error('Item must be PDF or EPUB');
		}
	}
	
	/**
	 * Preserve upstream extraction and item-saving behavior. Version 2 EpiLib
	 * responses already contain resolved records and bypass desktop translators.
	 * Legacy EpiLib/Zotero responses retain the existing identifier lookup below.
	 * @param {Zotero.Item} item - Standalone PDF attachment to recognize.
	 * @param {string} filePath - Existing local attachment path.
	 * @param {object} configuration - Provider snapshot captured before file I/O.
	 * @returns {Promise<Zotero.Item|null>} Saved parent item, or no match.
	 */
	async function _recognizePDF(item, filePath, configuration) {
		let json = await extractPDFJSON(item.id);
		json.fileName = PathUtils.filename(filePath);
		
		let containingTextPages = 0;
		
		for(let page of json.pages) {
			if(page[2].length) {
				containingTextPages++;
			}
		}
		
		if(!containingTextPages) {
			throw new Zotero.Exception.Alert('recognizePDF.noOCR');
		}
		
		let libraryID = item.libraryID;
		
		let res = await Zotero.RecognizeDocument.queryPDFMetadata(json, configuration);
		if (configuration.engine == 'epilib' && res?.engine == 'epilib' && res.version == 2) {
			if (res.status == 'no_match' && configuration.grobidEnabled) {
				let hints = await Zotero.RecognizeDocument.extractLocalGROBID(filePath, configuration);
				res = await Zotero.RecognizeDocument.queryPDFMetadata(hints, configuration);
			}
			if (configuration.cancelRevision != _cancelRevision) throw new Error(Zotero.getString('recognition-cancelled'));
			let record = res?.status == 'matched' ? res.item : res?.status == 'needs_review'
				? Zotero.RecognizeDocument.chooseRecognitionCandidate(res.candidates, { review: res.review }) : null;
			if (!record) return null;
			let parent = new Zotero.Item();
			parent.libraryID = libraryID;
			// Match translator imports: provider subjects are automatic tags and
			// must respect the user's global preference for importing such tags.
			parent.fromJSON(Zotero.Prefs.get('automaticTags') ? record : { ...record, tags: [] });
			// Let the normal save allocate identity. Setting key after fromJSON is
			// forbidden; both saves share a transaction so no partial parent escapes.
			await Zotero.DB.executeTransaction(async () => {
				await parent.save();
				_ensureCitationKey(parent);
				await parent.save();
			});
			return parent;
		}
		if (!res) return null;
		
		if (res.arxiv) {
			Zotero.debug(`RecognizeDocument: Getting metadata for arXiv ID ${res.arxiv}`);
			let translate = new Zotero.Translate.Search();
			translate.setIdentifier({arXiv: res.arxiv});
			let translators = await translate.getTranslators();
			translate.setTranslator(translators);
			
			try {
				let newItem = await _promiseTranslate(translate, libraryID);
				if (!newItem.abstractNote && res.abstract) {
					newItem.setField('abstractNote', res.abstract);
				}
				if (!newItem.language && res.language) {
					newItem.setField('language', res.language);
				}
				await newItem.saveTx();
				return newItem;
			}
			catch (e) {
				Zotero.debug('RecognizeDocument: ' + e);
			}
		}
		
		if (res.doi) {
			Zotero.debug(`RecognizeDocument: Getting metadata for DOI (${res.doi})`);
			let translate = new Zotero.Translate.Search();
			translate.setIdentifier({
				DOI: res.doi
			});
			let translators = await translate.getTranslators();
			if (translators.length) {
				translate.setTranslator(translators);
				try {
					let newItem = await _promiseTranslate(translate, libraryID);
					if (!newItem.abstractNote && res.abstract) {
						newItem.setField('abstractNote', res.abstract);
					}
					if (!newItem.language && res.language) {
						newItem.setField('language', res.language);
					}
					await newItem.saveTx();
					return newItem;
				}
				catch (e) {
					Zotero.debug('RecognizeDocument: ' + e);
				}
			}
			else {
				Zotero.debug("RecognizeDocument: No translators found");
			}
		}
		
		if (res.isbn) {
			Zotero.debug(`RecognizeDocument: Getting metadata by ISBN ${res.isbn}`);
			let translate = new Zotero.Translate.Search();
			translate.setSearch({'itemType': 'book', 'ISBN': res.isbn});
			try {
				let translatedItems = await translate.translate({
					libraryID: false,
					saveAttachments: false
				});
				Zotero.debug('RecognizeDocument: Translated items:');
				Zotero.debug(translatedItems);
				if (translatedItems.length) {
					let newItem = new Zotero.Item;
					newItem.libraryID = libraryID;
					// Convert tags to automatic. For other items this is done automatically in
					// translate.js, but for ISBNs we just get the data (libraryID=false) and do the
					// saving manually.
					if (Zotero.Prefs.get('automaticTags')) {
						translatedItems[0].tags = translatedItems[0].tags.map(tag => {
							if (typeof tag == 'string') {
								return {
									tag,
									type: 1
								};
							}
							tag.type = 1;
							return tag;
						});
					}
					else {
						translatedItems[0].tags = [];
					}
					newItem.fromJSON(translatedItems[0]);
					if (!newItem.abstractNote && res.abstract) {
						newItem.setField('abstractNote', res.abstract);
					}
					if (!newItem.language && res.language) {
						newItem.setField('language', res.language);
					}
					await newItem.saveTx();
					return newItem;
				}
			}
			catch (e) {
				Zotero.debug('RecognizeDocument: ' + e);
			}
		}
		
		if (res.title) {
			let type = 'journalArticle';
			
			if (res.type === 'book-chapter') {
				type = 'bookSection';
			}
			
			let newItem = new Zotero.Item(type);
			newItem.libraryID = libraryID;
			newItem.setField('title', res.title);
			
			let creators = [];
			for (let author of res.authors) {
				creators.push({
					firstName: author.firstName,
					lastName: author.lastName,
					creatorType: 'author'
				})
			}
			
			newItem.setCreators(creators);
			
			if (res.abstract) newItem.setField('abstractNote', res.abstract);
			if (res.year) newItem.setField('date', res.year);
			if (res.pages) newItem.setField('pages', res.pages);
			if (res.volume) newItem.setField('volume', res.volume);
			if (res.url) newItem.setField('url', res.url);
			if (res.language) newItem.setField('language', res.language);
			
			if (type === 'journalArticle') {
				if (res.issue) newItem.setField('issue', res.issue);
				if (res.ISSN) newItem.setField('issn', res.issn);
				if (res.container) newItem.setField('publicationTitle', res.container);
			}
			else if (type === 'bookSection') {
				if (res.container) newItem.setField('bookTitle', res.container);
				if (res.publisher) newItem.setField('publisher', res.publisher);
			}
			
			newItem.setField('libraryCatalog', configuration.engine == 'epilib' ? 'EpiLib' : 'Zotero');
			
			await newItem.saveTx();
			return newItem;
		}
		
		return null;
	}
	
	async function _recognizeEPUB(item, filePath) {
		const { EPUB } = ChromeUtils.importESModule("chrome://zotero/content/EPUB.mjs");
		
		let epub = new EPUB(filePath);
		try {
			let search = {};

			let rdfItemJSON = await _translateEPUBMetadata(epub);
			if (rdfItemJSON && rdfItemJSON.ISBN) {
				let clean = rdfItemJSON.ISBN.split(' ')
					.map(isbn => Zotero.Utilities.cleanISBN(isbn))
					.filter(Boolean);
				if (clean.length) {
					Zotero.debug('RecognizeEPUB: Found ISBN in RDF metadata');
					search.ISBN = clean.join(' ');
				}
			}

			for await (let doc of _getFirstSectionDocuments(epub)) {
				if (search.DOI && search.ISBN) break;
				if (!search.DOI) {
					let dois = _getDOIsFromDocument(doc);
					if (dois.length) {
						Zotero.debug('RecognizeEPUB: Found DOI in section document');
						search.DOI = dois[0];
					}
				}
				if (!search.ISBN) {
					let isbn = _getISBNFromDocument(doc);
					if (isbn) {
						Zotero.debug('RecognizeEPUB: Found ISBN in section document');
						search.ISBN = isbn;
					}
				}
			}

			let itemJSON;
			if (search.ISBN || search.DOI) {
				try {
					Zotero.debug('RecognizeEPUB: Searching by ' + Object.keys(search)
						.join(', '));
					let translate = new Zotero.Translate.Search();
					translate.setSearch(search);
					let [searchItemJSON] = await translate.translate({
						libraryID: false,
						saveAttachments: false
					});
					if (searchItemJSON) {
						itemJSON = searchItemJSON;
						if (search.ISBN && searchItemJSON.ISBN && !searchItemJSON.ISBN.split(' ')
								.map(resolvedISBN => Zotero.Utilities.cleanISBN(resolvedISBN))
								.includes(search.ISBN)) {
							Zotero.debug(`RecognizeDocument: ISBN mismatch (was ${search.ISBN}, got ${searchItemJSON.ISBN})`);
							itemJSON = null;
						}
						else {
							Zotero.debug('RecognizeDocument: Using search result');
						}
					}
				}
				catch (e) {
					Zotero.debug('RecognizeDocument: Error while resolving ISBN: ' + e);
				}
			}
			if (!itemJSON) {
				Zotero.debug('RecognizeEPUB: Falling back to RDF metadata');
				itemJSON = rdfItemJSON;
			}
			if (!itemJSON) {
				throw new Zotero.Exception.Alert("recognizePDF.couldNotRead");
			}

			if (Zotero.Prefs.get('automaticTags')) {
				itemJSON.tags = itemJSON.tags.map((tag) => {
					if (typeof tag == 'string') {
						return {
							tag,
							type: 1
						};
					}
					tag.type = 1;
					return tag;
				});
			}
			else {
				itemJSON.tags = [];
			}

			let translatedItem = new Zotero.Item();
			translatedItem.libraryID = item.libraryID;
			translatedItem.fromJSON(itemJSON);
			await translatedItem.saveTx();
			return translatedItem;
		}
		finally {
			epub.close();
		}
	}
	
	async function _translateEPUBMetadata(epub) {
		let metadata = await epub.getMetadataRDF();
		if (!metadata) {
			return null;
		}

		let translate = new Zotero.Translate.Import();
		translate.setTranslator(Zotero.Translators.TRANSLATOR_ID_RDF);
		translate.setString(metadata);

		try {
			let [itemJSON] = await translate.translate({
				libraryID: false,
				saveAttachments: false
			});
			return itemJSON;
		}
		catch (e) {
			Zotero.logError(e);
			return null;
		}
	}
	
	async function* _getFirstSectionDocuments(epub) {
		let copyrightDoc = await epub.getDocumentByReferenceType('copyright-page');
		if (copyrightDoc) {
			yield copyrightDoc;
		}
		let i = 0;
		for await (let { doc: sectionDoc } of epub.getSectionDocuments()) {
			yield sectionDoc;
			if (++i >= EPUB_MAX_SECTIONS) {
				break;
			}
		}
	}
	
	function _getDOIsFromDocument(doc) {
		// Copied from DOI translator
		
		const DOIre = /\b10\.[0-9]{4,}\/[^\s&"']*[^\s&"'.,]/g;
		var dois = new Set();

		var m, DOI;
		var treeWalker = doc.createTreeWalker(doc.documentElement, NodeFilter.SHOW_TEXT);
		var ignore = ['script', 'style'];
		while (treeWalker.nextNode()) {
			if (ignore.includes(treeWalker.currentNode.parentNode.tagName.toLowerCase())) continue;
			DOIre.lastIndex = 0;
			while ((m = DOIre.exec(treeWalker.currentNode.nodeValue))) {
				DOI = m[0];
				if (DOI.endsWith(")") && !DOI.includes("(")) {
					DOI = DOI.substring(0, DOI.length - 1);
				}
				if (DOI.endsWith("}") && !DOI.includes("{")) {
					DOI = DOI.substring(0, DOI.length - 1);
				}
				dois.add(DOI);
			}
		}

		var links = doc.querySelectorAll('a[href]');
		for (let link of links) {
			DOIre.lastIndex = 0;
			let m = DOIre.exec(link.href);
			if (m) {
				let doi = m[0];
				if (doi.endsWith(")") && !doi.includes("(")) {
					doi = doi.substring(0, doi.length - 1);
				}
				if (doi.endsWith("}") && !doi.includes("{")) {
					doi = doi.substring(0, doi.length - 1);
				}
				// only add new DOIs
				if (!dois.has(doi) && !dois.has(doi.replace(/#.*/, ''))) {
					dois.add(doi);
				}
			}
		}

		return Array.from(dois);
	}
	
	function _getISBNFromDocument(doc) {
		if (!doc.body) {
			return null;
		}
		return Zotero.Utilities.cleanISBN(doc.body.innerText) || null;
	}
	
	/**
	 * Resolve the Zotero provider's existing endpoint overrides. These preferences
	 * are intentionally ignored for EpiLib, which uses the authenticated Account
	 * server. recognize.url is direct; services.url receives a recognizer/ suffix.
	 * @returns {string} Zotero-provider base URL with trailing slash.
	 */
	function _getBaseURL() {
		var url = Zotero.Prefs.get("recognize.url");
		if (url) {
			if (!url.endsWith('/')) {
				url += '/';
			}
			return url;
		}
		url = Zotero.Prefs.get("services.url") || ZOTERO_CONFIG.SERVICES_URL;
		if (!url.endsWith('/')) {
			url += '/';
		}
		return url + "recognizer/";
	}
};
