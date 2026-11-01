/* global describe, before, after, beforeEach, afterEach, it, assert, sinon,
 loadZoteroPane, importFileAttachment, waitForCallback, createDataObject, getPromiseError, dump */
/*
 * macOS tab tear-off regression/integration tests. The real React tab bar and
 * real PDF/note windows run in the test runner's disposable profile. Synthetic
 * drag events exercise the production event wiring without driving the user's
 * mouse. Native mouse-drag smoke testing complements these deterministic tests.
 */
describe('macOS tab detachment', function () {
	let win, tabs, sandbox, alerts, loggedErrors;

	before(async function () {
		if (!Zotero.isMac) this.skip();
		win = await loadZoteroPane();
		tabs = win.Zotero_Tabs;
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
		for (const reader of [...Zotero.Reader._readers]) {
			if (!reader.tabID) reader.close();
		}
		for (const editor of [...Zotero.Notes._editorInstances]) {
			if (editor.viewMode === 'window') editor._iframeWindow.top.close();
		}
		tabs.closeAll();
		await Zotero.Promise.delay(100);
	});

	after(function () {
		win?.close();
	});

	/** Open a genuine PDF and wait for its tab to appear in React's DOM. */
	async function openPDF(filename = 'test.pdf') {
		const attachment = await importFileAttachment(filename);
		const reader = await Zotero.Reader.open(attachment.id);
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
			screenY: win.screenY + 100 }));
	}

	it('dragging a PDF outside opens a reader window and removes only its original tab', async function () {
		const { attachment, reader } = await openPDF();
		drag(reader.tabID);
		await waitForCallback(() => alerts.length || Zotero.Reader._readers.some(r => r.itemID === attachment.id && !r.tabID), 50, 5);
		assert.isEmpty(alerts, String(loggedErrors.lastCall?.args[0]?.stack || loggedErrors.lastCall?.args[0]));
		const destination = Zotero.Reader._readers.find(r => r.itemID === attachment.id && !r.tabID);
		await destination._initPromise;
		await waitForCallback(() => !tabs._getTab(reader.tabID).tab);
		assert.isFalse(destination._window.closed);
		assert.isOk(tabs._getTab('zotero-pane').tab);
	});

	it('cancelled, internal, accepted, foreign, and duplicate drag-end events never open windows', async function () {
		const { reader } = await openPDF();
		const open = sandbox.spy(Zotero.Reader, 'open');
		for (const options of [{ cancelled: true }, { outside: false }, { dropEffect: 'move' }, { start: false }]) {
			drag(reader.tabID, options);
		}
		await Zotero.Promise.delay(100);
		assert.isFalse(open.called);
		assert.isOk(tabs._getTab(reader.tabID).tab);
	});

	it('window-opening failure keeps the source tab and permits a later retry', async function () {
		const { reader } = await openPDF();
		const open = sandbox.stub(Zotero.Reader, 'open').rejects(new Error('test: window open failed'));
		assert.include((await getPromiseError(tabs.detachTab(reader.tabID))).message, 'window open failed');
		assert.isOk(tabs._getTab(reader.tabID).tab);
		assert.strictEqual(Zotero.Reader.getByTabID(reader.tabID), reader);
		open.restore();
		assert.isTrue(await tabs.detachTab(reader.tabID));
	});

	it('normal tab-bar dragging still reorders PDFs without opening a window', async function () {
		const first = await openPDF();
		const second = await openPDF();
		const node = win.document.querySelector(`.tab[data-id="${first.reader.tabID}"]`);
		const last = win.document.querySelector(`.tab[data-id="${second.reader.tabID}"]`);
		const dt = new win.DataTransfer();
		const open = sandbox.spy(Zotero.Reader, 'open');
		node.dispatchEvent(new win.DragEvent('dragstart', { bubbles: true, dataTransfer: dt,
			clientX: node.offsetLeft + 10 }));
		last.dispatchEvent(new win.DragEvent('dragover', { bubbles: true, cancelable: true,
			dataTransfer: dt, clientX: last.offsetLeft + last.offsetWidth + 30 }));
		drag(first.reader.tabID, { outside: false, start: false });
		await Zotero.Promise.delay(100);
		assert.isAbove(tabs._getTab(first.reader.tabID).tabIndex, tabs._getTab(second.reader.tabID).tabIndex);
		assert.isFalse(open.called);
	});

	it('the source stays open until the destination is ready, and repeated requests coalesce', async function () {
		const { reader } = await openPDF();
		const ready = Zotero.Promise.defer();
		const destination = { _window: { closed: false, focus() {} }, _openPromise: ready.promise };
		const open = sandbox.stub(Zotero.Reader, 'open').resolves(destination);
		const first = tabs.detachTab(reader.tabID);
		const second = tabs.detachTab(reader.tabID);
		await waitForCallback(() => open.called);
		assert.isOk(tabs._getTab(reader.tabID).tab);
		ready.resolve();
		await Promise.all([first, second]);
		assert.equal(open.callCount, 1);
		assert.isNotOk(tabs._getTab(reader.tabID).tab);
	});

	it('a failed destination initialization closes that window while preserving the original', async function () {
		const { reader } = await openPDF();
		const ready = Zotero.Promise.defer();
		const close = sandbox.spy();
		sandbox.stub(Zotero.Reader, 'open').resolves({ _window: { closed: false }, _openPromise: ready.promise, close });
		const transfer = tabs.detachTab(reader.tabID);
		await Zotero.Promise.delay(10);
		ready.reject(new Error('test: reader initialization failed'));
		assert.include((await getPromiseError(transfer)).message, 'reader initialization failed');
		assert.isTrue(close.calledOnce);
		assert.isOk(tabs._getTab(reader.tabID).tab);
	});

	it('a document that fails to initialize must not replace the usable original tab', async function () {
		const { reader } = await openPDF();
		const close = sandbox.spy();
		sandbox.stub(Zotero.Reader, 'open').resolves({ _window: { closed: false, focus() {} },
			_openPromise: Promise.resolve(),
			_internalReader: { _primaryView: { initializedPromise: Promise.resolve(false) } }, close });
		const error = await getPromiseError(tabs.detachTab(reader.tabID));
		assert.include(error.message, 'document');
		assert.isTrue(close.calledOnce);
		assert.isOk(tabs._getTab(reader.tabID).tab);
	});

	it('failed annotation persistence prevents opening a replacement and restores normal saving', async function () {
		const { reader } = await openPDF();
		const manager = reader._internalReader._annotationManager;
		const previous = manager._skipAnnotationSavingDebounce;
		// Simulate a queued edit and a failed storage operation at the persistence
		// boundary. No real data is lost; the synthetic queue is removed afterward.
		manager._unsavedAnnotations.set('TESTFAIL', { id: 'TESTFAIL' });
		const save = sandbox.stub(manager, '_triggerSaving').rejects(new Error('test: annotation save failed'));
		const open = sandbox.spy(Zotero.Reader, 'open');
		try {
			assert.include((await getPromiseError(tabs.detachTab(reader.tabID))).message, 'annotation save failed');
			assert.isOk(tabs._getTab(reader.tabID).tab);
			assert.isFalse(open.called);
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
		const split = { pageIndex: 1, scale: 'page-width', splitType: 'vertical', splitSize: '50%' };
		// Navigate a real multi-page PDF, then transfer without waiting for the
		// five-second disk-write debounce. The handoff must explicitly flush it.
		await reader.navigate({ pageIndex: 2 });
		await waitForCallback(() => attachment.getAttachmentLastPageIndex() === 2);
		sandbox.stub(reader, 'getSecondViewState').returns(split);
		const open = sandbox.spy(Zotero.Reader, 'open');
		await tabs.detachTab(reader.tabID);
		const destination = Zotero.Reader._readers.find(r => r.itemID === attachment.id && !r.tabID);
		assert.equal((await destination._getState()).pageIndex, 2);
		assert.deepEqual(open.firstCall.args[2].secondViewState, split);
		assert.deepEqual(annotation.toJSON(), before);
		assert.deepEqual(attachment.getCollections(), [collection.id]);
		assert.isTrue(await attachment.fileExists());
	});

	it('detaches an unloaded PDF without selecting and reopening the old tab', async function () {
		const { reader, attachment } = await openPDF();
		tabs.select('zotero-pane');
		tabs.unload(reader.tabID);
		assert.isTrue(await tabs.detachTab(reader.tabID));
		assert.isNotOk(tabs._getTab(reader.tabID).tab);
		assert.isOk(Zotero.Reader._readers.find(r => r.itemID === attachment.id && !r.tabID));
	});

	it('flushes an annotation edit still waiting on the reader save debounce', async function () {
		const { reader, attachment } = await openPDF();
		const annotation = await addHighlight(attachment);
		const manager = reader._internalReader._annotationManager;
		await waitForCallback(() => manager._annotations.some(a => a.id === annotation.key && a.position.pageIndex === 0));
		manager.updateAnnotations(Components.utils.cloneInto([
			{ id: annotation.key, comment: 'Last edit before tear-off' }
		], reader._iframeWindow));
		await tabs.detachTab(reader.tabID);
		assert.equal(annotation.annotationComment, 'Last edit before tear-off');
		const destination = Zotero.Reader._readers.find(r => r.itemID === attachment.id && !r.tabID);
		assert.equal(destination._internalReader._annotationManager._annotations
			.find(a => a.id === annotation.key).comment, 'Last edit before tear-off');
	});

	it('reuses an existing reader window for the same attachment', async function () {
		const { reader, attachment } = await openPDF();
		const existing = await Zotero.Reader.open(attachment.id, null, { openInWindow: true });
		await existing._initPromise;
		assert.isTrue(await tabs.detachTab(reader.tabID));
		assert.lengthOf(Zotero.Reader._readers.filter(r => r.itemID === attachment.id && !r.tabID), 1);
		assert.isFalse(existing._window.closed);
	});

	it('notes open in their own window with pending note content saved', async function () {
		const note = await createDataObject('item', { itemType: 'note', note: '<p>Original</p>' });
		const editor = await Zotero.Notes.open(note.id);
		const tabID = editor.tabID;
		// Notes.open resolves when the editor is ready; the tab's load hook marks
		// it loaded in a following microtask, before a person can start dragging.
		await waitForCallback(() => tabs._getTab(tabID).tab.type === 'note');
		const html = '<div data-schema-version="9"><p>Pending edit before tear-off</p></div>';
		// Mock only the editor bridge's latest unsaved payload; saving and both
		// editor windows use the actual application/database implementation.
		sandbox.stub(editor._iframeWindow.wrappedJSObject, 'getDataSync').returns({ html });
		assert.isTrue(await tabs.detachTab(tabID));
		assert.include(note.getNote(), 'Pending edit before tear-off');
		assert.isNotOk(tabs._getTab(tabID).tab);
		assert.isOk(Zotero.Notes._editorInstances.find(e => e.itemID === note.id && e.viewMode === 'window'));
	});

	it('ignores missing, library, and unsupported tab types', async function () {
		assert.isFalse(await tabs.detachTab('missing-tab'));
		assert.isFalse(await tabs.detachTab('zotero-pane'));
		const { id } = tabs.add({ type: 'test-custom', title: 'Extension-owned tab', data: {} });
		assert.isFalse(await tabs.detachTab(id));
		assert.isOk(tabs._getTab(id).tab);
	});

	/**
	 * Optional real mouse smoke test, not part of unattended CI:
	 * EPILIB_TAB_DETACH_SMOKE=1 CI=1 test/runtests.sh -b -g 'native pointer smoke' tabDetach
	 * Drag the "test.pdf" tab beyond the resized main window within 90 seconds.
	 * This exercises macOS's actual drag session, including native screen data.
	 */
	it('native pointer smoke', async function () {
		if (Services.env.get('EPILIB_TAB_DETACH_SMOKE') !== '1') this.skip();
		this.timeout(120000);
		const { reader, attachment } = await openPDF();
		win.resizeTo(850, 650);
		win.moveTo(80, 80);
		win.focus();
		dump('Ready for native tab drag: drag test.pdf outside the EpiLib window.\n');
		await waitForCallback(() => alerts.length || !tabs._getTab(reader.tabID).tab, 100, 90);
		assert.isEmpty(alerts, String(loggedErrors.lastCall?.args[0]));
		const destination = Zotero.Reader._readers.find(r => r.itemID === attachment.id && !r.tabID);
		assert.isOk(destination);
		assert.isFalse(destination._window.closed);
		await Zotero.Promise.delay(5000);
	});
});
