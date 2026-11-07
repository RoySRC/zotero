/* global describe, before, after, beforeEach, afterEach, it, assert, sinon,
 loadZoteroPane, importFileAttachment, waitForCallback, createDataObject, getPromiseError, closeItemTabs, dump */
/*
 * macOS tab tear-off regression/integration tests. The real React tab bar and
 * real PDF/note main-window tabs run in the test runner's disposable profile. Synthetic
 * drag events exercise the production event wiring without driving the user's
 * mouse. Native mouse-drag smoke testing complements these deterministic tests.
 */
describe('macOS tab detachment', function () {
	let win, tabs, sandbox, alerts, loggedErrors, originalWindows;

	before(async function () {
		if (!Zotero.isMac) this.skip();
		win = await loadZoteroPane();
		tabs = win.Zotero_Tabs;
		originalWindows = Zotero.getMainWindows();
	});

	beforeEach(function () {
		sandbox = sinon.createSandbox();
		alerts = [];
		// A regression must fail an assertion, not block the unattended runner
		// behind a modal alert. Preserve logged exceptions for useful diagnostics.
		sandbox.stub(Zotero, 'alert').callsFake((_owner, _title, message) => alerts.push(message));
		loggedErrors = sandbox.spy(Zotero, 'logError');
	});

	afterEach(async function () {
		sandbox.restore();
		for (const other of Zotero.getMainWindows()) {
			if (!originalWindows.includes(other)) other.close();
		}
		closeItemTabs(win);
		await Zotero.Promise.delay(100);
	});

	after(function () {
		win?.close();
	});

	/** Open a genuine PDF and wait for its tab to appear in React's DOM. */
	async function openPDF(filename = 'test.pdf') {
		const attachment = await importFileAttachment(filename);
		const reader = await Zotero.Reader.open(attachment.id, null, { window: win });
		await reader._initPromise;
		await reader._internalReader._primaryView.initializedPromise;
		await waitForCallback(() => win.document.querySelector(`.tab[data-id="${reader.tabID}"]`));
		return { attachment, reader };
	}

	/** Create a renderable highlight, with every required field set before saving. */
	async function addHighlight(attachment) {
		const annotation = new Zotero.Item('annotation');
		annotation.libraryID = attachment.libraryID;
		annotation.parentID = attachment.id;
		annotation.annotationType = 'highlight';
		annotation.annotationText = 'Fixture highlight';
		annotation.annotationComment = 'Original comment';
		annotation.annotationColor = '#ffd400';
		annotation.annotationPosition = JSON.stringify({ pageIndex: 0, rects: [[20, 20, 100, 35]] });
		annotation.annotationPageLabel = '1';
		annotation.annotationSortIndex = '00000|000020|00000';
		await annotation.saveTx();
		return annotation;
	}

	/** Dispatch the same start/end pair React receives from Gecko's native drag. */
	function drag(tabID, { outside = true, cancelled = false, dropEffect = 'none', start = true } = {}) {
		const node = win.document.querySelector(`.tab[data-id="${tabID}"]`);
		const dt = new win.DataTransfer();
		if (start) {
			node.dispatchEvent(new win.DragEvent('dragstart', { bubbles: true, cancelable: true,
				dataTransfer: dt, clientX: node.getBoundingClientRect().x + 20 }));
		}
		// mozUserCancelled is a native read-only property. Override it only on
		// this test event; no production cancellation checks are bypassed.
		Object.defineProperty(dt, 'mozUserCancelled', { value: cancelled });
		dt.dropEffect = dropEffect;
		node.dispatchEvent(new win.DragEvent('dragend', { bubbles: true, dataTransfer: dt,
			screenX: outside ? win.screenX + win.outerWidth + 100 : win.screenX + 100,
			screenY: outside ? win.screenY + 100 : win.mozInnerScreenY + 15 }));
	}

	/**
	 * Keep a synthetic drag open across multiple events. Only the OS drag-image
	 * transport is intercepted: the real React handlers, snapshot renderer, tab
	 * layout and reader lifecycle still run. This lets assertions inspect the
	 * intermediate state while the mouse button would still be held down.
	 */
	function beginPreviewDrag(tabID) {
		const node = win.document.querySelector(`.tab[data-id="${tabID}"]`);
		const dt = new win.DataTransfer();
		const images = sandbox.stub(dt, 'updateDragImage');
		node.dispatchEvent(new win.DragEvent('dragstart', { bubbles: true, dataTransfer: dt,
			clientX: node.getBoundingClientRect().x + 20, clientY: 15 }));
		return {
			node, dt, images,
			move(outside, relatedTarget = null) {
				win.document.dispatchEvent(new win.DragEvent(outside ? 'dragleave' : 'dragover', {
					bubbles: true, dataTransfer: dt, relatedTarget,
					screenX: outside ? win.screenX + win.outerWidth + 100 : win.screenX + 100,
					screenY: win.screenY + 100
				}));
			},
			end({ cancelled = true, dropEffect = 'none' } = {}) {
				Object.defineProperty(dt, 'mozUserCancelled', { value: cancelled });
				dt.dropEffect = dropEffect;
				node.dispatchEvent(new win.DragEvent('dragend', { bubbles: true, dataTransfer: dt,
					screenX: win.screenX + win.outerWidth + 100, screenY: win.screenY + 100 }));
			}
		};
	}

	it('shows a document drag preview and removes the source tab from layout before mouse release', async function () {
		const { reader } = await openPDF();
		const gesture = beginPreviewDrag(reader.tabID);
		try {
			gesture.move(true);
			assert.equal(win.getComputedStyle(gesture.node).visibility, 'hidden');
			assert.equal(win.getComputedStyle(gesture.node).position, 'absolute');
			assert.isOk(tabs._getTab(reader.tabID).tab, 'The source stays alive until the drop commits');
			assert.isEmpty(Zotero.Reader._readers.filter(r => !r.tabID), 'Preview must not open another reader');
			await waitForCallback(() => gesture.images.lastCall?.args[0].dataset.snapshotReady === 'true');
			const canvas = gesture.images.lastCall.args[0];
			assert.isAbove(canvas.width, 200);
			assert.isAbove(canvas.height, 150);
			// A populated PDF thumbnail has varied pixels below the title bar,
			// rather than merely an opaque rectangle or a title-only placeholder.
			const pixels = canvas.getContext('2d').getImageData(0, 80, canvas.width, canvas.height - 80).data;
			assert.isAbove(new Set(pixels).size, 10);
		}
		finally {
			gesture.end();
		}
	});

	it('dragging back restores the same tab and hides the native preview without reopening the reader', async function () {
		const { reader } = await openPDF();
		const gesture = beginPreviewDrag(reader.tabID);
		gesture.move(true);
		assert.equal(win.getComputedStyle(gesture.node).visibility, 'hidden');
		gesture.move(false);
		assert.equal(win.getComputedStyle(gesture.node).visibility, 'visible');
		assert.equal(win.getComputedStyle(gesture.node).position, 'relative');
		assert.equal(gesture.images.lastCall.args[0].width, 1, 'Reordering uses a transparent native image');
		assert.strictEqual(Zotero.Reader.getByTabID(reader.tabID), reader);
		gesture.end();
	});

	it('Escape and accepted drops restore preview-hidden tabs and discard all drag listeners', async function () {
		const { reader } = await openPDF();
		for (const outcome of [{ cancelled: true }, { cancelled: false, dropEffect: 'copy' }]) {
			const gesture = beginPreviewDrag(reader.tabID);
			gesture.move(true);
			assert.equal(win.getComputedStyle(gesture.node).visibility, 'hidden');
			gesture.end(outcome);
			await Zotero.Promise.delay(100);
			assert.equal(win.getComputedStyle(gesture.node).visibility, 'visible');
			const count = gesture.images.callCount;
			gesture.move(true);
			assert.equal(gesture.images.callCount, count, 'Finished drags cannot reactivate previews');
			assert.strictEqual(Zotero.Reader.getByTabID(reader.tabID), reader);
		}
	});

	it('moving between child elements never hides a tab as though it left the window', async function () {
		const { reader } = await openPDF();
		const gesture = beginPreviewDrag(reader.tabID);
		gesture.move(true, win.document.getElementById('tabs-deck'));
		assert.equal(win.getComputedStyle(gesture.node).visibility, 'visible');
		gesture.end();
	});

	it('macOS source drags with stale coordinates show a preview when no source-window dragover follows', async function () {
		const { reader } = await openPDF();
		const gesture = beginPreviewDrag(reader.tabID);
		const sourceEvent = () => gesture.node.dispatchEvent(new win.DragEvent('drag', {
			bubbles: true, dataTransfer: gesture.dt, clientX: 0, clientY: 0,
			screenX: win.screenX, screenY: win.screenY
		}));
		try {
			// Native macOS can report only the source window's origin and omit
			// dragleave entirely. Each internal dragover still cancels the preview.
			sourceEvent();
			gesture.move(false);
			await Zotero.Promise.delay(100);
			assert.equal(win.getComputedStyle(gesture.node).visibility, 'visible');
			sourceEvent();
			await waitForCallback(() => win.getComputedStyle(gesture.node).visibility === 'hidden', 10, 2);
			gesture.move(false);
			assert.equal(win.getComputedStyle(gesture.node).visibility, 'visible');
		}
		finally {
			gesture.end();
		}
	});

	it('a late document snapshot is disposed without reactivating a cancelled preview', async function () {
		const { reader } = await openPDF();
		const capture = Zotero.Promise.defer();
		sandbox.stub(win.browsingContext.currentWindowGlobal, 'drawSnapshot').returns(capture.promise);
		const gesture = beginPreviewDrag(reader.tabID);
		gesture.move(true);
		gesture.end();
		const count = gesture.images.callCount;
		const close = sandbox.spy();
		capture.resolve({ close });
		await waitForCallback(() => close.called);
		assert.equal(gesture.images.callCount, count);
		assert.equal(win.getComputedStyle(gesture.node).visibility, 'visible');
	});

	it('snapshot failure retains a usable title preview and restores the source on cancellation', async function () {
		const { reader } = await openPDF();
		sandbox.stub(win.browsingContext.currentWindowGlobal, 'drawSnapshot').rejects(new Error('test: snapshot failed'));
		const gesture = beginPreviewDrag(reader.tabID);
		await Zotero.Promise.delay(20);
		gesture.move(true);
		assert.isAbove(gesture.images.lastCall.args[0].width, 200);
		assert.equal(win.getComputedStyle(gesture.node).visibility, 'hidden');
		gesture.end();
		assert.equal(win.getComputedStyle(gesture.node).visibility, 'visible');
		assert.isEmpty(alerts);
	});

	it('a rejected native preview leaves the source visible rather than losing the dragged tab', async function () {
		const { reader } = await openPDF();
		const gesture = beginPreviewDrag(reader.tabID);
		gesture.images.throws(new Error('test: native drag session ended'));
		gesture.move(true);
		assert.equal(win.getComputedStyle(gesture.node).visibility, 'visible');
		gesture.end();
		assert.strictEqual(Zotero.Reader.getByTabID(reader.tabID), reader);
	});

	it('a failed drop restores the preview-hidden source after the handoff promise rejects', async function () {
		const { reader } = await openPDF();
		const opening = Zotero.Promise.defer();
		const open = sandbox.stub(tabs, '_moveToNewWindow').returns(opening.promise);
		const gesture = beginPreviewDrag(reader.tabID);
		gesture.move(true);
		gesture.end({ cancelled: false });
		await waitForCallback(() => open.called);
		assert.equal(win.getComputedStyle(gesture.node).visibility, 'hidden', 'No source-tab flash during handoff');
		opening.reject(new Error('test: destination failed'));
		await waitForCallback(() => alerts.length);
		assert.equal(win.getComputedStyle(gesture.node).visibility, 'visible');
		assert.strictEqual(Zotero.Reader.getByTabID(reader.tabID), reader);
	});

	it('dragging a PDF outside moves its live document into a new main window', async function () {
		const { reader } = await openPDF();
		const sourceID = reader.tabID;
		const document = reader._internalReader;
		drag(sourceID);
		await waitForCallback(() => alerts.length || reader._window !== win, 50, 5);
		assert.isEmpty(alerts, String(loggedErrors.lastCall?.args[0]?.stack || loggedErrors.lastCall?.args[0]));
		assert.isNotOk(tabs._getTab(sourceID).tab);
		assert.isOk(reader._window.Zotero_Tabs._getTab(reader.tabID).tab);
		assert.strictEqual(reader._internalReader, document);
		assert.isFalse(reader._window.closed);
		assert.isOk(tabs._getTab('zotero-pane').tab);
	});

	it('cancelled, tab-bar, accepted, foreign, and duplicate drag-end events never open windows', async function () {
		const { reader } = await openPDF();
		const open = sandbox.spy(Zotero, 'openMainWindow');
		for (const options of [{ cancelled: true }, { outside: false }, { dropEffect: 'move' }, { start: false }]) {
			drag(reader.tabID, options);
		}
		await Zotero.Promise.delay(100);
		assert.isFalse(open.called);
		assert.isOk(tabs._getTab(reader.tabID).tab);
	});

	it('window-opening failure keeps the source tab and permits a later retry', async function () {
		const { reader } = await openPDF();
		const sourceID = reader.tabID;
		const open = sandbox.stub(Zotero, 'openMainWindow').throws(new Error('test: window open failed'));
		assert.include((await getPromiseError(tabs._moveToNewWindow(sourceID))).message, 'window open failed');
		assert.isOk(tabs._getTab(sourceID).tab);
		assert.strictEqual(Zotero.Reader.getByTabID(sourceID), reader);
		open.restore();
		assert.isOk(await tabs._moveToNewWindow(sourceID));
		assert.notEqual(reader._window, win);
	});

	it('normal tab-bar dragging still reorders PDFs without opening a window', async function () {
		const first = await openPDF();
		const second = await openPDF();
		const node = win.document.querySelector(`.tab[data-id="${first.reader.tabID}"]`);
		const last = win.document.querySelector(`.tab[data-id="${second.reader.tabID}"]`);
		const dt = new win.DataTransfer();
		const open = sandbox.spy(Zotero, 'openMainWindow');
		node.dispatchEvent(new win.DragEvent('dragstart', { bubbles: true, dataTransfer: dt,
			clientX: node.offsetLeft + 10 }));
		last.dispatchEvent(new win.DragEvent('dragover', { bubbles: true, cancelable: true,
			dataTransfer: dt, clientX: last.offsetLeft + last.offsetWidth + 30 }));
		drag(first.reader.tabID, { outside: false, start: false });
		await Zotero.Promise.delay(100);
		assert.isAbove(tabs._getTab(first.reader.tabID).tabIndex, tabs._getTab(second.reader.tabID).tabIndex);
		assert.isFalse(open.called);
	});

	it('the source stays open while the main window initializes, and repeated requests coalesce', async function () {
		const { reader } = await openPDF();
		let transfer;
		const destination = { closed: false, close() {} };
		const open = sandbox.stub(Zotero, 'openMainWindow').callsFake(({ movedTab }) => {
			transfer = movedTab;
			return destination;
		});
		const first = tabs._moveToNewWindow(reader.tabID);
		const second = tabs._moveToNewWindow(reader.tabID);
		assert.strictEqual(first, second);
		assert.isOk(tabs._getTab(reader.tabID).tab);
		transfer.onError(new Error('test: main window failed'));
		assert.include((await getPromiseError(first)).message, 'main window failed');
		assert.equal(open.callCount, 1);
		assert.isTrue(transfer.cancelled);
		assert.isOk(tabs._getTab(reader.tabID).tab);
	});

	it('a failed live reader move closes the new window while preserving the original', async function () {
		const { reader } = await openPDF();
		const sourceID = reader.tabID;
		sandbox.stub(reader, 'moveToWindow').throws(new Error('test: reader move failed'));
		const windows = Zotero.getMainWindows();
		assert.include((await getPromiseError(tabs._moveToNewWindow(sourceID))).message, 'reader move failed');
		assert.isOk(tabs._getTab(sourceID).tab);
		assert.strictEqual(Zotero.Reader.getByTabID(sourceID), reader);
		await waitForCallback(() => Zotero.getMainWindows().every(other => windows.includes(other)));
	});

	it('failed annotation persistence preserves the source and restores normal saving', async function () {
		const { reader } = await openPDF();
		const manager = reader._internalReader._annotationManager;
		const previous = manager._skipAnnotationSavingDebounce;
		manager._unsavedAnnotations.set('TESTFAIL', { id: 'TESTFAIL' });
		const save = sandbox.stub(manager, '_triggerSaving').rejects(new Error('test: annotation save failed'));
		const move = sandbox.spy(reader, 'moveToWindow');
		try {
			assert.include((await getPromiseError(tabs._moveToNewWindow(reader.tabID))).message, 'annotation save failed');
			assert.isOk(tabs._getTab(reader.tabID).tab);
			assert.isFalse(move.called);
			assert.strictEqual(manager._skipAnnotationSavingDebounce, previous);
		}
		finally {
			manager._unsavedAnnotations.delete('TESTFAIL');
			save.restore();
		}
	});

	it('preserves document identity, annotations, collections, current page and split view', async function () {
		const { reader, attachment } = await openPDF('wonderland_short.pdf');
		const collection = await createDataObject('collection');
		attachment.addToCollection(collection.id);
		await attachment.saveTx();
		const annotation = await addHighlight(attachment);
		const before = annotation.toJSON();
		await reader.navigate({ pageIndex: 2 });
		await waitForCallback(() => attachment.getAttachmentLastPageIndex() === 2);
		reader._internalReader.toggleVerticalSplit(true);
		await reader._internalReader._secondaryView.initializedPromise;
		const document = reader._internalReader;
		const secondView = document._secondaryView;
		// The bundled reader publishes split state through its debounced
		// onChangeViewState callback, after the secondary view initializes.
		await waitForCallback(() => tabs._getTab(reader.tabID).tab.data.secondViewState?.splitType === 'vertical');
		const split = JSON.parse(JSON.stringify(tabs._getTab(reader.tabID).tab.data.secondViewState));
		assert.isOk(split);
		await tabs._moveToNewWindow(reader.tabID);
		assert.strictEqual(reader._internalReader, document);
		assert.strictEqual(document._secondaryView, secondView);
		assert.equal((await reader._getState()).pageIndex, 2);
		assert.deepEqual(reader._window.Zotero_Tabs._getTab(reader.tabID).tab.data.secondViewState, split);
		assert.deepEqual(annotation.toJSON(), before);
		assert.deepEqual(attachment.getCollections(), [collection.id]);
		assert.isTrue(await attachment.fileExists());
	});

	it('moves an unloaded PDF without selecting and reopening the old tab', async function () {
		const { reader, attachment } = await openPDF();
		const sourceID = reader.tabID;
		tabs.select('zotero-pane');
		tabs.unload(sourceID);
		assert.isOk(await tabs._moveToNewWindow(sourceID));
		assert.isNotOk(tabs._getTab(sourceID).tab);
		assert.isOk(Zotero.Reader._readers.find(r => r.itemID === attachment.id && r._window !== win));
	});

	it('flushes an annotation edit still waiting on the reader save debounce', async function () {
		const { reader, attachment } = await openPDF();
		const annotation = await addHighlight(attachment);
		const manager = reader._internalReader._annotationManager;
		await waitForCallback(() => manager._annotations.some(a => a.id === annotation.key && a.position.pageIndex === 0));
		manager.updateAnnotations(Components.utils.cloneInto([
			{ id: annotation.key, comment: 'Last edit before tear-off' }
		], reader._iframeWindow));
		await tabs._moveToNewWindow(reader.tabID);
		assert.equal(annotation.annotationComment, 'Last edit before tear-off');
		assert.equal(reader._internalReader._annotationManager._annotations
			.find(a => a.id === annotation.key).comment, 'Last edit before tear-off');
	});

	it('moves a reader into an existing main window without replacing another copy', async function () {
		const { reader, attachment } = await openPDF();
		const sourceID = reader.tabID;
		const target = await loadZoteroPane();
		const existing = await Zotero.Reader.open(attachment.id, null, { window: target, allowDuplicate: true });
		await existing._openPromise;
		assert.notStrictEqual(existing, reader);
		assert.isOk(await tabs.moveToWindow(sourceID, target));
		assert.strictEqual(reader._window, target);
		assert.isOk(target.Zotero_Tabs._getTab(existing.tabID).tab);
		assert.isOk(target.Zotero_Tabs._getTab(reader.tabID).tab);
		assert.notEqual(reader.tabID, existing.tabID);
		assert.strictEqual(Zotero.Reader.getByTabID(existing.tabID), existing);
		assert.strictEqual(Zotero.Reader.getByTabID(reader.tabID), reader);
	});

	it('notes move into main-window tabs with pending note content saved', async function () {
		const note = await createDataObject('item', { itemType: 'note', note: '<p>Original</p>' });
		const editor = await Zotero.Notes.open(note.id, null, { window: win });
		const tabID = editor.tabID;
		await waitForCallback(() => tabs._getTab(tabID).tab.type === 'note');
		const html = '<div data-schema-version="9"><p>Pending edit before tear-off</p></div>';
		sandbox.stub(editor._iframeWindow.wrappedJSObject, 'getDataSync').returns({ html });
		const newID = await tabs._moveToNewWindow(tabID);
		assert.isOk(newID);
		assert.include(note.getNote(), 'Pending edit before tear-off');
		assert.isNotOk(tabs._getTab(tabID).tab);
		assert.isOk(Zotero.Notes.getByTabID(newID));
	});

	it('library tabs use the same new-main-window handoff', async function () {
		win.ZoteroPane.newLibraryTab();
		const sourceID = tabs.selectedID;
		await tabs.getLoadPromise(sourceID);
		const newID = await tabs._moveToNewWindow(sourceID);
		assert.isOk(newID);
		assert.isNotOk(tabs._getTab(sourceID).tab);
		const target = Zotero.getMainWindows().find(other => !originalWindows.includes(other));
		assert.isTrue(target.Zotero_Tabs.isLibraryTab(newID));
		assert.isTrue(target.ZoteroPane.getLibraryView(newID).loaded);
	});

	it('ignores missing and unsupported tab types', async function () {
		assert.isNull(await tabs._onTabTearOff('missing-tab', 100, 100));
		const { id } = tabs.add({ type: 'test-custom', title: 'Extension-owned tab', data: {} });
		assert.isNull(await tabs._onTabTearOff(id, 100, 100));
		assert.isOk(tabs._getTab(id).tab);
	});

	/**
	 * Optional real mouse smoke test, not part of unattended CI:
	 * EPILIB_TAB_DETACH_SMOKE=1 CI=1 test/runtests.sh -b -g 'native pointer smoke' tabDetach
	 * Drag the "test.pdf" tab beyond the resized main window within 90 seconds.
	 * This exercises macOS's actual drag session, including native screen data.
	 * Use a physical mouse if an automation tool reports the starting point for
	 * every dragover and only updates the position on release: that sequence
	 * cannot verify any while-held visual, irrespective of the implementation.
	 */
	it('native pointer smoke', async function () {
		if (Services.env.get('EPILIB_TAB_DETACH_SMOKE') !== '1') this.skip();
		this.timeout(120000);
		const { reader, attachment } = await openPDF();
		// Observe the actual OS-facing calls without stubbing them. This catches
		// regressions that synthetic events cannot: hiding only on mouse release,
		// or drawing a canvas that Gecko never receives during the drag session.
		const updates = sandbox.spy(win.DataTransfer.prototype, 'updateDragImage');
		let hiddenBeforeRelease = false;
		const node = win.document.querySelector(`.tab[data-id="${reader.tabID}"]`);
		const observeEnd = () => {
			hiddenBeforeRelease = win.getComputedStyle(node).visibility === 'hidden';
		};
		win.document.addEventListener('dragend', observeEnd, { capture: true, once: true });
		win.resizeTo(850, 650);
		win.moveTo(80, 80);
		win.focus();
		dump('Ready for native tab drag: drag test.pdf outside the EpiLib window.\n');
		await waitForCallback(() => alerts.length || !tabs._getTab(reader.tabID).tab, 100, 90);
		assert.isEmpty(alerts, String(loggedErrors.lastCall?.args[0]));
		assert.isTrue(hiddenBeforeRelease, 'The native drag must hide the source before mouse release');
		assert.isTrue(updates.getCalls().some(call => call.args[0].width > 200), 'Native preview was updated during the drag');
		const destination = Zotero.Reader._readers.find(r => r.itemID === attachment.id && r._window !== win);
		assert.isOk(destination);
		assert.isFalse(destination._window.closed);
		await Zotero.Promise.delay(5000);
	});
});
