/* global describe, it, beforeEach, afterEach, assert,
	loadZoteroPane, createDataObject, waitForDOMEvent */
"use strict";

/** Native integration coverage for both formerly iconless metadata commands. */
describe('Metadata menu icon integration', function () {
	let win, item, engine, theme;
	const themePref = 'ui.systemUsesDarkTheme';

	beforeEach(function () {
		engine = Zotero.Prefs.get('recognize.engine');
		theme = Services.prefs.prefHasUserValue(themePref) ? Services.prefs.getIntPref(themePref) : null;
		Zotero.Prefs.set('recognize.engine', 'epilib-local');
	});

	/** Never retain theme changes or test records in the next native test. */
	afterEach(async function () {
		if (win && !win.closed) win.close();
		win = null;
		if (item) await item.eraseTx();
		item = null;
		Zotero.Prefs.set('recognize.engine', engine);
		if (theme === null) Services.prefs.clearUserPref(themePref);
		else Services.prefs.setIntPref(themePref, theme);
	});

	['light', 'dark'].forEach((mode) => {
		[
			{ name: 'Refresh Metadata', action: 'refresh-metadata', icon: 'refresh', type: 'preprint' },
			{ name: 'Update to Published Version', action: 'refresh-publication', icon: 'retrieve-metadata', type: 'preprint' },
			{ name: 'Refresh Metadata on a DOI-less publication', action: 'refresh-metadata', icon: 'refresh', type: 'conferencePaper' }
		].forEach((scenario) => {
			it(`${scenario.name} has a loaded, theme-consistent icon in ${mode} mode`, async function () {
				Services.prefs.setIntPref(themePref, mode == 'dark' ? 1 : 0);
				win = await loadZoteroPane();
				assert.equal(win.matchMedia('(prefers-color-scheme: dark)').matches, mode == 'dark');
				item = await createDataObject('item', { itemType: scenario.type, title: 'Synthetic icon test' });
				await win.ZoteroPane.selectItem(item.id);
				await win.ZoteroPane.buildItemContextMenu();
				let popup = win.document.getElementById('zotero-itemmenu');
				let shown = waitForDOMEvent(popup, 'popupshown');
				popup.openPopup(win.document.getElementById('zotero-items-tree'), 'after_start', 0, 0, true);
				await shown;
				try {
					// Open the actual popup before reading styles: hidden XUL menus do
					// not resolve their computed icon properties until first display.
					let command = popup.querySelector('.zotero-menuitem-' + scenario.action);
					assert.isFalse(command.hidden);
					assert.isTrue(command.classList.contains('menuitem-iconic'));
					let reference = win.getComputedStyle(popup.querySelector('.zotero-menuitem-duplicate-item'));
					let style = win.getComputedStyle(command);
					let url = `chrome://zotero/skin/16/universal/${scenario.icon}.svg`;
					assert.include(style.getPropertyValue('--menuitem-icon'), url);
					// Follow the platform's native-menu visibility policy instead of
					// forcing icons on platforms that deliberately suppress all of them.
					if (reference.listStyleImage == 'none') assert.equal(style.listStyleImage, 'none');
					else assert.include(style.listStyleImage, url);
					assert.equal(style.fill, reference.fill);
					assert.equal(style.getPropertyValue('-moz-context-properties'), reference.getPropertyValue('-moz-context-properties'));
					let image = new win.Image();
					image.src = url;
					await image.decode();
					assert.equal(image.naturalWidth, 16);
					assert.equal(image.naturalHeight, 16);
					if (scenario.type == 'preprint') {
						assert.isFalse(popup.querySelector('.zotero-menuitem-refresh-metadata').hidden);
						assert.isFalse(popup.querySelector('.zotero-menuitem-refresh-publication').hidden);
					}
				}
				finally {
					popup.hidePopup();
				}
			});
		});
	});
});
