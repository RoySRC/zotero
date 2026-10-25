"use strict";

/**
 * Desktop host for the separately maintained recognition engine. The unprivileged
 * worker owns extraction/matching. This host owns a disposable, profile-local
 * SQLite cache and tightly constrained, cookie-free provider requests. Nothing
 * Recognition stays local. Optional repository requests contain only bounded
 * public lookup hints/records, never PDF extraction or catalog credentials.
 */
Zotero.LocalRecognitionClient = class {
	constructor({ cachePath = PathUtils.join(PathUtils.profileDir, 'epilib-recognition-cache.sqlite') } = {}) {
		this.cachePath = cachePath;
		this._jobs = new Map();
		this._requests = new Map();
		this._nextJob = 0;
		this._worker = null;
		this._cachePromise = null;
		this._connection = null;
		this._closing = false;
		this._revision = 0;
		this._contributions = new Set();
		this._host = ChromeUtils.importESModule('resource://zotero/recognition-engine/host.mjs');
	}

	/** Open only the cache database, never zotero.sqlite or a remote PostgreSQL DB. */
	async _openCache() {
		if (!this._cachePromise) {
			this._cachePromise = (async () => {
				const { Sqlite } = ChromeUtils.importESModule('resource://gre/modules/Sqlite.sys.mjs');
				this._connection = await Sqlite.openConnection({ path: this.cachePath });
				return this._host.createSQLiteStore({ execute: (sql, params) => this._connection.execute(sql, params) });
			})().catch(() => {
				// A broken or unwritable disposable cache must not break recognition.
				// Preserve the file for inspection instead of deleting user files.
				Zotero.warn('Recognition cache unavailable; continuing without persistent caching');
				return null;
			});
		}
		return this._cachePromise;
	}

	/** Start one reusable worker; a failure is recoverable on the next request. */
	_startWorker() {
		if (this._worker) return;
		const worker = new Worker('resource://zotero/recognition-engine/worker.js');
		this._worker = worker;
		worker.onmessage = event => this._onMessage(worker, event.data);
		worker.onerror = event => {
			event.preventDefault();
			if (this._worker == worker) this.cancelAll('Local recognition worker failed');
		};
	}

	/**
	 * Start bounded background work. Credentials are transferred only to this
	 * local worker; job bookkeeping contains no PDF input or secret values.
	 */
	async recognize(payload, credentials = {}, scope = 'local') {
		if (this._closing) throw new Error('Local recognition is shutting down');
		if (this._jobs.size >= 2) throw new Error('Local recognition is busy');
		if (new TextEncoder().encode(JSON.stringify(payload)).length > 5 * 1024 * 1024) {
			throw new Error('Recognition input is too large');
		}
		this._startWorker();
		const job = ++this._nextJob;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => this.cancelAll('Local recognition timed out'), 30000);
			const repository = this._repositoryConfiguration();
			this._jobs.set(job, { resolve, reject, timer, scope, repository });
			try { this._worker.postMessage({ job, payload, credentials,
				repository: repository && { namespace: JSON.stringify(repository), contribute: repository.contribute } }); }
			catch {
				clearTimeout(timer);
				this._jobs.delete(job);
				reject(new Error('Invalid local recognition input'));
			}
		});
	}

	/** Dispatch only known worker operations; late replies after cancellation vanish. */
	async _onMessage(worker, message) {
		const job = this._jobs.get(message.job);
		if (!job || worker != this._worker) return;
		if ('result' in message || message.error) {
			clearTimeout(job.timer);
			this._jobs.delete(message.job);
			if (message.error) job.reject(new Error('Local recognition could not complete provider lookups'));
			else job.resolve(message.result);
			return;
		}
		if (message.action == 'abort') {
			this._requests.get(`${message.job}:${message.id}`)?.();
			this._requests.delete(`${message.job}:${message.id}`);
			return;
		}
		let data, error;
		try {
			if (message.action == 'repository-submit') {
				// Dispatch before the result message removes this job, but do not make
				// recognition wait for a write. Bound background work during large imports.
				if (job.repository?.contribute && this._contributions.size < 4) {
					const task = this._requestRepository(job.repository, 'records', message.data,
						`repository-submit:${message.job}`).catch(() => null);
					this._contributions.add(task);
					task.finally(() => this._contributions.delete(task));
				}
				return;
			}
			if (message.action == 'repository-query') {
				data = await this._requestRepository(job.repository, 'query', message.data, `${message.job}:${message.id}`);
			}
			else if (message.action == 'fetch') data = await this._fetchProvider(`${message.job}:${message.id}`, message.data);
			else if (['get', 'put'].includes(message.action)) {
				try {
					const cache = await this._openCache();
					data = cache ? await cache[message.action](job.scope, message.data.key, message.data.record) : null;
				}
				catch { data = null; }
			}
			else throw new Error('Unknown worker request');
		}
		catch { error = true; }
		if (this._worker == worker && this._jobs.has(message.job)) worker.postMessage({ reply: message.id, data, error });
	}

	/** Use only the account server, never a PDF-supplied URL or a provider endpoint. */
	_repositoryConfiguration() {
		if (this._closing || !Zotero.Prefs.get('recognize.repository.enabled')) return null;
		try {
			const url = new URL(Zotero.Sync.Metadata.getPostgreSQLBaseURL());
			const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
			if ((url.protocol != 'https:' && !(url.protocol == 'http:' && loopback))
				|| url.username || url.password || url.search || url.hash
				|| /(^|\.)zotero\.org$/i.test(url.hostname)) return null;
			return { base: url.href.replace(/\/?$/, '/'), userID: Zotero.Users.getCurrentUserID(),
				contribute: !!Zotero.Prefs.get('recognize.repository.contribute') };
		}
		catch { return null; }
	}

	/**
	 * Account tokens stay in the privileged host. Recheck account/settings after
	 * awaiting the login manager and after HTTP so a logout/switch cannot leak a
	 * credential or accept a stale response. Failure is always a catalog fallback.
	 */
	async _requestRepository(configuration, operation, input, id) {
		const revision = this._revision;
		const current = () => configuration && revision == this._revision
			&& JSON.stringify(configuration) == JSON.stringify(this._repositoryConfiguration());
		if (!current() || Services.io.offline) return null;
		try {
			let body;
			if (operation == 'query') body = this._host.validateRepositoryQuery(input);
			else if (operation == 'records' && configuration.contribute && input?.schema === 1) {
				body = { schema: 1, record: this._host.projectRepositoryRecord(input.record) };
			}
			else return null;
			const token = await Zotero.Sync.Metadata.getPostgreSQLAPIKey();
			if (!token || !current()) return null;
			const xhr = await Zotero.HTTP.request('POST', configuration.base + 'metadata-repository/v1/' + operation, {
				headers: { 'Content-Type': 'application/json', 'Zotero-API-Key': token }, body: JSON.stringify(body),
				anon: true, followRedirects: false, responseType: 'arraybuffer', logBodyLength: 0,
				timeout: 2000, errorDelayMax: 0, successCodes: false, debug: false,
				cancellerReceiver: cancel => this._requests.set(id, cancel),
				requestObserver: xhr => xhr.addEventListener('progress', event => {
					if (event.loaded > 128 * 1024) xhr.abort();
				})
			});
			if (!current() || ![200, 201].includes(xhr.status) || !xhr.response || xhr.response.byteLength > 128 * 1024) return null;
			return JSON.parse(new TextDecoder().decode(xhr.response));
		}
		catch { return null; }
		finally { this._requests.delete(id); }
	}

	/**
	 * Privileged HTTP adapter with no cookies, account tokens, redirects, body
	 * logging or automatic retries. Abort oversized downloads while streaming.
	 * The engine handles narrowly allowed DOI redirects itself, re-scoping keys.
	 */
	async _fetchProvider(id, input) {
		const request = this._host.validateProviderRequest(input);
		if (Services.io.offline) throw new Error('Offline');
		try {
			const xhr = await Zotero.HTTP.request(request.method, request.url, {
				headers: request.headers, body: request.body, anon: true, followRedirects: false,
				responseType: 'arraybuffer', logBodyLength: 0, timeout: 8000, errorDelayMax: 0,
				successCodes: false, debug: false,
				cancellerReceiver: cancel => this._requests.set(id, cancel),
				requestObserver: xhr => xhr.addEventListener('progress', (event) => {
					if (event.loaded > 2 * 1024 * 1024) xhr.abort();
				})
			});
			const body = xhr.response || new ArrayBuffer(0);
			if (body.byteLength > 2 * 1024 * 1024) throw new Error('Provider response too large');
			return { status: xhr.status, body, headers: {
				'Content-Type': xhr.getResponseHeader('Content-Type') || '',
				'Location': xhr.getResponseHeader('Location') || '',
				'Retry-After': xhr.getResponseHeader('Retry-After') || ''
			} };
		}
		finally { this._requests.delete(id); }
	}

	/** Terminate CPU work and HTTP together, rejecting callers rather than hanging. */
	cancelAll(message = 'Recognition cancelled') {
		this._revision++;
		this._worker?.terminate();
		this._worker = null;
		for (const cancel of this._requests.values()) cancel();
		this._requests.clear();
		for (const job of this._jobs.values()) {
			clearTimeout(job.timer);
			job.reject(new Error(message));
		}
		this._jobs.clear();
	}

	/** Flush cache writes before releasing the native SQLite connection at shutdown. */
	async close() {
		this._closing = true;
		this.cancelAll();
		await Promise.allSettled(this._contributions);
		const cache = await this._cachePromise;
		await cache?.drain();
		await this._connection?.close();
	}
};

// Lazy construction keeps startup cheap and permits isolated test instances.
Zotero.defineProperty(Zotero, 'LocalRecognition', {
	get() {
		const client = new Zotero.LocalRecognitionClient();
		Zotero.addShutdownListener(() => client.close());
		return client;
	}
}, { lazy: true });
