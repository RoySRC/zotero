/* global describe, before, after, afterEach, it, assert,
 loadZoteroPane, importFileAttachment, waitForDOMEvent, waitForCallback */
"use strict";

/**
 * Regression coverage for disabled PDF split/zoom context-menu commands.
 *
 * Reader menu descriptors may omit `disabled`: omission means enabled. These
 * tests use Gecko's real XUL elements because a hand-written DOM mock can miss
 * the WebIDL distinction between toggleAttribute(name, false) and an undefined
 * optional argument. The integration cases also exercise the PDF context-menu
 * callback, the bundled reader's descriptors, the iframe bridge and actual view
 * changes. All documents and windows belong to the runner's disposable profile.
 */
describe('Reader native context menus', function () {
	// Exercise each popup container lifecycle, including a preserved document
	// whose original window is closed after it moves to another main window.
	['PDF tab', 'reader-only main window', 'moved PDF tab'].forEach((view) => {
		describe(view, function () {
			let win, reader, internal, attachment, transferWindow;

			before(async function () {
				win = await loadZoteroPane();
				attachment = await importFileAttachment('test.pdf');
				reader = await Zotero.Reader.open(attachment.id, null, {
					openInWindow: view === 'reader-only main window', window: win
				});
				await reader._initPromise;
				internal = reader._internalReader;
				await internal._primaryView.initializedPromise;
				if (view === 'moved PDF tab') {
					transferWindow = await loadZoteroPane();
					let frame = reader._iframeWindow;
					await win.Zotero_Tabs.moveToWindow(reader.tabID, transferWindow);
					win.close();
					win = transferWindow;
					assert.strictEqual(reader._iframeWindow, frame);
					assert.strictEqual(reader._window, transferWindow);
				}
				assert.include(Zotero.getMainWindows(), reader._window);
			});

			/** Close native popups even when an assertion fails partway through. */
			afterEach(async function () {
				if (!reader) return;
				for (const popup of [...reader._popupset.children]) {
					if (popup.state === 'open' || popup.state === 'showing') {
						await closeMenu(popup);
					}
				}
				internal.disableSplitView();
			});

			/** Tear down readers before deleting their disposable attachments. */
			after(async function () {
				reader?.close();
				win?.Zotero_Tabs.closeAll();
				await Zotero.Promise.delay(100);
				win?.close();
				if (transferWindow && !transferWindow.closed) transferWindow.close();
				if (attachment) await attachment.eraseTx();
			});

			/**
			 * Register before opening: native popupshown can fire before the caller
			 * regains control. Returning the displayed node lets assertions inspect
			 * the exact menu the user sees, not a separately constructed test menu.
			 */
			async function openMenu(trigger) {
				const shown = waitForDOMEvent(reader._popupset, 'popupshown');
				trigger();
				return (await shown).target;
			}

			/**
			 * Wait for dismissal before opening another menu. A command may itself
			 * move focus to the PDF and close/remove its popup, so closing an already
			 * dismissed menu must not wait for a second event that will never fire.
			 */
			async function closeMenu(popup) {
				if (!popup.isConnected || popup.state === 'closed') return;
				const hidden = waitForDOMEvent(popup, 'popuphidden');
				popup.hidePopup();
				await hidden;
			}

			/** Find commands by their actual localized label in the native menu. */
			function menuItem(popup, label) {
				const item = [...popup.querySelectorAll('menuitem')]
					.find(node => node.getAttribute('label') === label);
				assert.isOk(item, `Missing menu command: ${label}`);
				return item;
			}

			/** Check both attribute presence and the native control's disabled state. */
			function assertEnabled(item) {
				assert.isFalse(item.hasAttribute('disabled'), `${item.label} has a disabled attribute`);
				assert.isFalse(item.disabled, `${item.label} is disabled`);
			}

			/**
			 * Deliver the command event native selection sends to the bridge. The
			 * explicit enabled assertion is essential: synthetic events alone can
			 * reach listeners even on disabled controls and would hide this bug.
			 * macOS may defer delivery until native menu tracking ends, so await
			 * the listener instead of assuming dispatchEvent executes it inline.
			 */
			async function invoke(item) {
				assertEnabled(item);
				const commanded = waitForDOMEvent(item, 'command');
				item.dispatchEvent(new reader._window.Event('command', { bubbles: true }));
				await commanded;
			}

			/**
			 * Enter at the callback used after the PDF has hit-tested a right-click.
			 * This avoids synthesizing an OS mouse gesture across nested iframes.
			 * No menu descriptors, callbacks or split/zoom actions are substituted:
			 * the bundled reader must generate and display its real native menu.
			 */
			async function openPDFMenu() {
				return openMenu(() => {
					internal.focusView(true);
					internal._primaryView._onOpenViewContextMenu({ x: 100, y: 100 });
				});
			}

			it('defaults omitted/undefined disabled flags to enabled, including nested and checked commands', async function () {
				const calls = [];
				const command = label => ({ label, onCommand: () => calls.push(label) });
				const popup = await openMenu(() => reader._openContextMenu({ x: 100, y: 100, itemGroups: [[
					command('Omitted'),
					{ ...command('Undefined'), disabled: undefined },
					{ ...command('Unchecked'), checked: false },
					{ ...command('Checked'), checked: true },
					{ ...command('Color'), color: '#ffd400', checked: true },
					{ label: 'Nested', groups: [[command('Nested omitted')]] }
				]] }));
				for (const label of ['Omitted', 'Undefined', 'Unchecked', 'Checked', 'Color', 'Nested omitted']) {
					const item = menuItem(popup, label);
					assertEnabled(item);
					await invoke(item);
				}
				assert.sameMembers(calls, ['Omitted', 'Undefined', 'Unchecked', 'Checked', 'Color', 'Nested omitted'],
					'Enabled actions must retain their original command callbacks');
				assert.equal(menuItem(popup, 'Checked').getAttribute('type'), 'checkbox');
				assert.isTrue(menuItem(popup, 'Checked').hasAttribute('checked'));
				assert.isFalse(menuItem(popup, 'Unchecked').hasAttribute('checked'));
			});

			it('preserves explicitly enabled and disabled actions', async function () {
				const popup = await openMenu(() => reader._openContextMenu({ x: 100, y: 100, itemGroups: [[
					{ label: 'Allowed', disabled: false, onCommand() {} },
					{ label: 'Unavailable', disabled: true, onCommand() {} }
				]] }));
				assertEnabled(menuItem(popup, 'Allowed'));
				assert.isTrue(menuItem(popup, 'Unavailable').hasAttribute('disabled'));
				assert.isTrue(menuItem(popup, 'Unavailable').disabled);
			});

			['horizontal', 'vertical'].forEach((direction) => {
				it(`opens and closes a ${direction} split using the PDF right-click menu`, async function () {
					const label = internal._getString(`reader-split-${direction}ly`);
					let popup = await openPDFMenu();
					let item = menuItem(popup, label);
					assertEnabled(item);
					assert.isFalse(item.hasAttribute('checked'));
					await invoke(item);
					await closeMenu(popup);
					assert.equal(internal.splitType, direction);
					assert.isOk(internal._secondaryView, 'The command must create a second PDF view');
					await internal._secondaryView.initializedPromise;

					// The checked state is only an indicator of the selected layout;
					// it must never disable the command that switches splitting off.
					popup = await openPDFMenu();
					item = menuItem(popup, label);
					assertEnabled(item);
					assert.isTrue(item.hasAttribute('checked'));
					await invoke(item);
					await closeMenu(popup);
					assert.isNull(internal.splitType);
					assert.isNull(internal._secondaryView);
				});
			});

			[
				['auto', 'zoomAutoEnabled'],
				['page-width', 'zoomPageWidthEnabled'],
				['page-height', 'zoomPageHeightEnabled']
			].forEach(([mode, state]) => {
				it(`enables PDF ${mode} zoom and reflects the selected mode on reopening`, async function () {
					// Start at a numeric zoom to prove that the command changes the
					// view, instead of passing because its mode was already selected.
					internal.zoomIn();
					await waitForCallback(() => !internal[state]);
					const label = internal._getString(`reader-zoom-${mode}`);
					let popup = await openPDFMenu();
					const item = menuItem(popup, label);
					assertEnabled(item);
					await invoke(item);
					await closeMenu(popup);
					await waitForCallback(() => internal[state]);
					popup = await openPDFMenu();
					assertEnabled(menuItem(popup, label));
					assert.isTrue(menuItem(popup, label).hasAttribute('checked'));
				});
			});
		});
	});
});
