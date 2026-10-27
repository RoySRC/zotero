/**
 * Notification-only binary update client, independent from MAR updates, account
 * credentials and translator/style updates. Source builds check only on demand.
 */
Zotero.EpiLibUpdates = new function () {
	const { FEED_URL, RELEASES_URL, validateFeed, parseVersion, compareVersions, releaseURL }
		= ChromeUtils.importESModule('resource://zotero/epilibUpdates.mjs');
	const INTERVAL = 24 * 60 * 60 * 1000;
	let timer, pending, buildPromise;
	let stopped = false;

	/** Read the bundled release stamp, never a user-overridable version preference. */
	this.getBuildInfo = function () {
		if (!buildPromise) {
			buildPromise = Zotero.File.getResourceAsync('resource://zotero/epilib-release.json').then((text) => {
				let build = JSON.parse(text);
				if (build.channel === 'stable') parseVersion(build.version);
				else if (build.channel !== 'development' || build.version !== null) {
					throw new Error('Invalid EpiLib build identity');
				}
				return Object.freeze(build);
			});
		}
		return buildPromise;
	};

	/**
	 * Fetch anonymously with a timeout; concurrent checks share one request. A
	 * missing/invalid feed is an error, never an assertion that the app is current.
	 */
	this.check = function () {
		if (pending) return pending;
		pending = (async () => {
			let build = await this.getBuildInfo();
			let response = await Zotero.HTTP.request('GET', FEED_URL, {
				anon: true, timeout: 20000, responseType: 'text',
				headers: { Accept: 'application/json' }, successCodes: [200]
			});
			if (response.responseText.length > 65536) throw new Error('EpiLib update feed is too large');
			let feed = validateFeed(JSON.parse(response.responseText));
			return {
				version: feed.version, currentVersion: build.version,
				available: !build.version || compareVersions(feed.version, build.version) > 0,
				development: build.channel === 'development'
			};
		})();
		pending = pending.finally(() => {
			pending = null;
		});
		return pending;
	};

	/** Open only a locally constructed, EpiLib-controlled GitHub release page. */
	this.openReleasePage = function (version) {
		Zotero.launchURL(version ? releaseURL(version) : RELEASES_URL);
	};

	/**
	 * Attempt at most once a day, including after failures/restarts. Save the attempt
	 * before networking to avoid startup retry loops. Manual checks bypass this timer.
	 */
	this.checkInBackground = async function () {
		let build = await this.getBuildInfo();
		if (build.channel !== 'stable' || !Zotero.Prefs.get('epilib.updates.enabled')) return;
		let now = Date.now();
		let last = Number(Zotero.Prefs.get('epilib.updates.lastAttempt'));
		if (last <= now && now - last < INTERVAL) return;
		Zotero.Prefs.set('epilib.updates.lastAttempt', String(now));
		try {
			let result = await this.check();
			if (!stopped && result.available && Zotero.getMainWindow()
				&& Zotero.Prefs.get('epilib.updates.lastNotified') !== result.version) {
				Zotero.openCheckForUpdatesWindow({ result });
				Zotero.Prefs.set('epilib.updates.lastNotified', result.version);
			}
		}
		catch (error) {
			Zotero.debug(`EpiLib update check unavailable: ${error.message}`, 2);
		}
	};

	/** Delay the first check until after startup and cancel scheduled work on exit. */
	this.init = function () {
		if (Zotero.test || timer) return;
		stopped = false;
		let tick = async () => {
			try {
				await this.checkInBackground();
			}
			catch (error) {
				Zotero.logError(error);
			}
			if (!stopped) timer = setTimeout(tick, INTERVAL);
		};
		timer = setTimeout(tick, 120000);
		Zotero.addShutdownListener(() => {
			stopped = true;
			clearTimeout(timer);
		});
	};
};
