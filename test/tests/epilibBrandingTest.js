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
});
