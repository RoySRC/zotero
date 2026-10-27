"use strict";

describe("EpiLib branding smoke test", function () {
	let main, about, preferences;
	after(function () {
		preferences?.close();
		about?.close();
		main?.close();
	});

	it("opens the library, branded About dialog, artwork and account controls", async function () {
		main = await loadZoteroPane();
		assert.equal(Zotero.appName, 'EpiLib');
		assert.ok(main.ZoteroPane.collectionsView);
		about = await loadWindow('chrome://zotero/content/about.xhtml');
		let logo = about.document.getElementById('logo');
		await logo.decode();
		assert.equal(logo.alt, 'EpiLib');
		assert.isAbove(logo.naturalWidth, 0);
		assert.isAbove(logo.getBoundingClientRect().width, 0);
		assert.include(about.document.getElementById('fork-notice').textContent, 'EpiLib');
		assert.include(about.document.getElementById('created-by').textContent, 'Zotero');
		preferences = await loadPrefPane('account');
		let doc = preferences.document;
		for (let id of ['metadata-backend', 'metadata-postgresql-settings', 'storage-profile-selector']) {
			assert.ok(doc.getElementById(id), `Missing Account control: ${id}`);
		}
		assert.equal(typeof preferences.Zotero_Preferences.Sync.loginPostgreSQLMetadataServer, 'function');
	});

	it("serves the branded connector status without changing the JSON protocol", async function () {
		let ping = new Zotero.Server.Connector.Ping();
		let [status, contentType, body] = await ping.init({ method: 'GET' });
		assert.equal(status, 200);
		assert.equal(contentType, 'text/html');
		assert.include(body, 'EpiLib is running');
		assert.notInclude(body, 'Zotero is running');
		let result = await ping.init({ method: 'POST', data: {}, headers: {} });
		assert.equal(result[1], 'application/json');
		assert.property(JSON.parse(result[2]), 'prefs');
	});

	it("uses the configured EpiLib account message for missing and expired tokens", async function () {
		for (let code of [Zotero.Error.ERROR_API_KEY_NOT_SET, Zotero.Error.ERROR_API_KEY_INVALID]) {
			let error = new Zotero.Error('test', code);
			await Zotero.Sync.Runner.checkError(error);
			assert.include(error.message, 'EpiLib account');
			assert.include(error.message, 'configured metadata server');
			assert.notInclude(error.message, 'Zotero account');
			assert.isFunction(error.dialogButtonCallback);
		}
	});

	it("opens EpiLib downloads from architecture warnings, including beta builds", async function () {
		let sandbox = sinon.createSandbox();
		let saved = Zotero.Prefs.get('architecture.warning.lastDisplayed');
		try {
			Zotero.Prefs.set('architecture.warning.lastDisplayed', 0);
			sandbox.stub(Zotero, 'isWin64EmulatedOnArm').returns(true);
			let launch = sandbox.stub(Zotero, 'launchURL');
			let betaFlag = sandbox.stub(Zotero, 'isBetaBuild');
			for (let beta of [false, true]) {
				betaFlag.value(beta);
				await main.ZoteroPane.showArchitectureWarning();
				main.document.getElementById('architecture-warning-action').click();
				assert.equal(launch.lastCall.args[0], 'https://epilib.org/downloads');
			}
		}
		finally {
			sandbox.restore();
			main.ZoteroPane.hideArchitectureWarning();
			if (saved === undefined) Zotero.Prefs.clear('architecture.warning.lastDisplayed');
			else Zotero.Prefs.set('architecture.warning.lastDisplayed', saved);
		}
	});
});
