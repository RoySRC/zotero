"use strict";

describe("EpiLib branding smoke test", function () {
	let main, about, preferences;

	it("uses an EpiLib runtime profile root and isolated data and scratch directories", function () {
		// -profile isolates this test run; UAppData still reveals the runtime's
		// normal profile root, so this catches packaging errors in application.ini.
		assert.equal(Services.appinfo.name, 'EpiLib');
		assert.equal(Services.appinfo.vendor, 'EpiLib');
		const root = Services.dirsvc.get('UAppData', Ci.nsIFile).path;
		assert.equal(PathUtils.filename(root).toLowerCase(), 'epilib');
		assert.equal(PathUtils.filename(Zotero.DataDirectory.defaultDir), 'EpiLib');
		const scratch = PathUtils.filename(Zotero.getTempDirectory().path);
		assert.equal(scratch, Zotero.isMac ? 'org.epilib.epilib' : (Zotero.isWin ? 'EpiLib' : 'epilib'));
	});
	after(function () {
		preferences?.close();
		about?.close();
		main?.close();
	});

	it("opens the library, branded About dialog, artwork and account controls", async function () {
		main = await loadZoteroPane();
		assert.equal(Zotero.appName, 'EpiLib');
		assert.ok(main.ZoteroPane.collectionsView);
		const startupErrors = [];
		const listener = {
			observe(message) {
				if (message instanceof Ci.nsIScriptError
						&& /(?:about\.xhtml|elements\/dialog\.js)$/.test(message.sourceName)) {
					startupErrors.push(message.errorMessage);
				}
			}
		};
		Services.console.registerListener(listener);
		try {
			about = await loadWindow('chrome://zotero/content/about.xhtml');
		}
		finally {
			Services.console.unregisterListener(listener);
		}
		assert.deepEqual(startupErrors, [], 'About dialog startup must not throw');
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

	it("sizes About before positioning and invokes the positioning method on its dialog", function () {
		const calls = [];
		const dialog = {
			moveToAlertPosition() {
				assert.strictEqual(this, dialog, 'Gecko needs the dialog as the method receiver');
				assert.deepEqual(calls, ['size']);
				calls.push('position');
			},
			getButton(name) {
				assert.equal(name, 'accept');
				return { focus() { calls.push('focus'); } };
			}
		};
		// Execute the shipped load handler without relying on the OS to produce
		// a one-pixel initial window. The old global/unbound call always fails here.
		const handler = new about.Function('document', 'sizeToContent', 'moveToAlertPosition',
			about.document.documentElement.getAttribute('onload'));
		handler({ getElementById(id) {
			assert.equal(id, 'zotero-about');
			return dialog;
		} }, () => calls.push('size'), () => assert.fail('Unbound dialog method'));
		assert.deepEqual(calls, ['size', 'position', 'focus']);
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

	it("ignores tag-selector callbacks after the window's container has been removed", function () {
		const pane = main.ZoteroPane;
		const element = main.document.getElementById('zotero-tag-selector-container');
		// Retain collection rows while removing the DOM, as a pending resize
		// callback can observe this exact combination during window shutdown.
		const stub = sinon.stub(pane, 'getCollectionTreeRows').returns([{}]);
		element.id = 'detached-tag-selector-test';
		try {
			assert.isFalse(pane.tagSelectorShown());
		}
		finally {
			element.id = 'zotero-tag-selector-container';
			stub.restore();
		}
	});

	it("ships a decodable asset for every spinner background, including preload variants", async function () {
		const css = await Zotero.File.getContentsFromURLAsync('chrome://zotero-platform/content/zotero.css');
		const urls = new Set(css.match(/chrome:\/\/zotero\/skin\/[^"')\s]*\/loading\.svg/g));
		assert.isAbove(urls.size, 0);
		for (const url of urls) {
			const image = new main.Image();
			image.src = url;
			await image.decode();
			assert.equal(image.naturalWidth, 16, url);
		}
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
