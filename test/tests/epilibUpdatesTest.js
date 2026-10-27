/* global describe, beforeEach, afterEach, it, sinon, assert, loadWindow, waitForWindow, waitForDOMEvent, getPromiseError */
describe('EpiLib update isolation', function () {
	const contract = ChromeUtils.importESModule('resource://zotero/epilibUpdates.mjs');
	let sandbox, win;
	const feed = {
		schemaVersion: 1, repository: contract.REPOSITORY, channel: 'stable',
		version: '1.10.0', tag: 'epilib-v1.10.0', commit: 'a'.repeat(40),
		assets: Object.keys(contract.PLATFORMS).map(platform => ({
			platform, name: contract.assetName('1.10.0', platform), size: 42, sha256: 'b'.repeat(64)
		}))
	};

	beforeEach(function () {
		sandbox = sinon.createSandbox();
	});
	afterEach(async function () {
		if (win && !win.closed) {
			let closed = waitForDOMEvent(win, 'unload');
			win.close();
			await closed;
		}
		win = null;
		sandbox.restore();
		for (let name of ['enabled', 'lastAttempt', 'lastNotified']) Zotero.Prefs.clear(`epilib.updates.${name}`);
	});

	it('reads its real bundled release identity locally, without an HTTP request', async function () {
		let request = sandbox.stub(Zotero.HTTP, 'request').rejects(new Error('Unexpected HTTP request'));
		let expected = JSON.parse(await Zotero.File.getResourceAsync('resource://zotero/epilib-release.json'));
		assert.deepEqual(await Zotero.EpiLibUpdates.getBuildInfo(), expected);
		assert.isFalse(request.called);
	});

	it('blocks native foreground/background checks even with inherited automatic-update preferences', async function () {
		let original = Services.prefs.getBoolPref('app.update.auto');
		try {
			Services.prefs.setBoolPref('app.update.auto', true);
			let service = Cc['@mozilla.org/updates/update-service;1'].getService(Ci.nsIApplicationUpdateService);
			assert.isTrue(service.disabled);
			assert.isFalse(service.canCheckForUpdates);
			let checker = Cc['@mozilla.org/updates/update-checker;1'].getService(Ci.nsIUpdateChecker);
			for (let type of [Ci.nsIUpdateChecker.FOREGROUND_CHECK, Ci.nsIUpdateChecker.BACKGROUND_CHECK]) {
				let result = await checker.checkForUpdates(type).result;
				assert.isFalse(result.checksAllowed);
				assert.isNull(result.request);
				assert.lengthOf(result.updates, 0);
			}
			assert.match((await getPromiseError(service.internal.downloadUpdate(null))).message, /EPILIB_NATIVE_UPDATES_DISABLED/);
		}
		finally {
			Services.prefs.setBoolPref('app.update.auto', original);
		}
	});

	it('queries only the EpiLib feed without account credentials and compares release versions', async function () {
		sandbox.stub(Zotero.EpiLibUpdates, 'getBuildInfo').resolves({ version: '1.9.0', channel: 'stable' });
		let request = sandbox.stub(Zotero.HTTP, 'request').resolves({ responseText: JSON.stringify(feed) });
		let result = await Zotero.EpiLibUpdates.check();
		assert.isTrue(result.available);
		assert.equal(request.firstCall.args[1], contract.FEED_URL);
		assert.isTrue(request.firstCall.args[2].anon);
		assert.deepEqual(request.firstCall.args[2].headers, { Accept: 'application/json' });
	});

	it('does not treat offline/404/invalid feeds as an up-to-date result', async function () {
		sandbox.stub(Zotero.EpiLibUpdates, 'getBuildInfo').resolves({ version: '1.9.0', channel: 'stable' });
		sandbox.stub(Zotero.HTTP, 'request').resolves({ responseText: '<html>Not found</html>' });
		assert.ok(await getPromiseError(Zotero.EpiLibUpdates.check()));
		Zotero.HTTP.request.resetBehavior();
		Zotero.HTTP.request.rejects(new Error('404'));
		assert.match((await getPromiseError(Zotero.EpiLibUpdates.check())).message, /404/);
	});

	it('opens a labeled native EpiLib dialog and navigates only to its release page', async function () {
		sandbox.stub(Zotero.EpiLibUpdates, 'getBuildInfo').resolves({ version: '1.9.0', channel: 'stable' });
		sandbox.stub(Zotero.HTTP, 'request').resolves({ responseText: JSON.stringify(feed) });
		win = await loadWindow('chrome://zotero/content/update/epilibUpdates.xhtml');
		await win.EpiLibUpdateWindow.refresh();
		await win.document.l10n.translateRoots();
		let status = win.document.getElementById('epilib-update-status');
		assert.include(status.textContent, '1.10.0');
		assert.include(status.textContent, '1.9.0');
		for (let id of ['epilib-update-check', 'epilib-update-release', 'epilib-update-auto']) {
			let element = win.document.getElementById(id);
			assert.isNotEmpty(element.getAttribute('label'));
			assert.isAbove(element.getBoundingClientRect().width, 0);
		}
		let launch = sandbox.stub(Zotero, 'launchURL');
		win.document.getElementById('epilib-update-release').doCommand();
		assert.equal(launch.firstCall.args[0], contract.releaseURL('1.10.0'));
		assert.isNull(Services.wm.getMostRecentWindow('Update:Wizard'));
	});

	it('shows unavailable instead of up-to-date in the native error state', async function () {
		sandbox.stub(Zotero.EpiLibUpdates, 'getBuildInfo').resolves({ version: '1.9.0', channel: 'stable' });
		sandbox.stub(Zotero.HTTP, 'request').rejects(new Error('offline'));
		win = await loadWindow('chrome://zotero/content/update/epilibUpdates.xhtml');
		await win.EpiLibUpdateWindow.refresh();
		await win.document.l10n.translateRoots();
		assert.include(win.document.getElementById('epilib-update-status').textContent, 'unavailable');
		assert.isFalse(win.document.getElementById('epilib-update-check').disabled);
	});

	it('reuses background results and updates an already open notification without another request', async function () {
		let request = sandbox.stub(Zotero.HTTP, 'request').rejects(new Error('Unexpected network request'));
		let result = { version: '1.10.0', currentVersion: '1.9.0', available: true };
		let opened = waitForWindow('chrome://zotero/content/update/epilibUpdates.xhtml');
		Zotero.openCheckForUpdatesWindow({ result });
		win = await opened;
		await win.document.l10n.translateRoots();
		assert.include(win.document.getElementById('epilib-update-status').textContent, '1.10.0');
		Zotero.openCheckForUpdatesWindow({ result: { ...result, version: '1.11.0' } });
		await win.document.l10n.translateRoots();
		assert.include(win.document.getElementById('epilib-update-status').textContent, '1.11.0');
		assert.isFalse(request.called);
	});

	it('keeps translator/style repository updates operational when binary checks are disabled', async function () {
		let { ZOTERO_CONFIG } = ChromeUtils.importESModule('resource://zotero/config.mjs');
		assert.equal(ZOTERO_CONFIG.REPOSITORY_URL, 'https://repo.zotero.org/repo/');
		await Zotero.Styles.init();
		// The harness disables repository polling in its user prefs; verify the
		// shipped default separately and explicitly enable it for this exercise.
		assert.isTrue(Services.prefs.getDefaultBranch('').getBoolPref('extensions.zotero.automaticScraperUpdates'));
		let automatic = Zotero.Prefs.get('automaticScraperUpdates');
		Zotero.Prefs.set('automaticScraperUpdates', true);
		Zotero.Prefs.set('epilib.updates.enabled', false);
		let skipped = Zotero.skipBundledFiles;
		let request = sandbox.stub(Zotero.HTTP, 'request').resolves({
			status: 200,
			responseXML: new DOMParser().parseFromString('<xml><currentTime>1700000000</currentTime></xml>', 'application/xml')
		});
		try {
			Zotero.skipBundledFiles = false;
			assert.isTrue(await Zotero.Schema.updateFromRepository(Zotero.Schema.REPO_UPDATE_MANUAL));
			assert.equal(request.firstCall.args[0], 'POST');
			assert.include(request.firstCall.args[1], 'https://repo.zotero.org/repo/updated?');
			assert.match(request.firstCall.args[2].body, /^styles=/);
			assert.equal(await Zotero.Schema.getDBVersion('repository'), 1700000000);
		}
		finally {
			Zotero.skipBundledFiles = skipped;
			Zotero.Prefs.set('automaticScraperUpdates', automatic);
		}
	});
});
