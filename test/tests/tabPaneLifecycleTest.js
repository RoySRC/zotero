/* global describe, before, after, beforeEach, afterEach, it, assert, sinon,
 loadZoteroPane, importFileAttachment, createDataObject */

/**
 * Regression coverage for asynchronous sidebar callbacks surviving tab closure.
 * These tests exercise real custom elements and disposable library records;
 * only the completion time of filesystem work and library removal are controlled.
 */
describe('Tab sidebar teardown', function () {
	let win, sandbox, elements;
	before(async function () {
		win = await loadZoteroPane();
	});
	beforeEach(function () {
		sandbox = sinon.createSandbox();
		elements = [];
	});
	afterEach(function () {
		sandbox.restore();
		for (const element of elements) element.remove();
	});
	after(function () {
		win.close();
	});

	/** Mount a real pane so it follows the same init/destroy path as a tab. */
	function mount(name, item) {
		const element = win.document.createXULElement(name);
		win.document.documentElement.append(element);
		element.item = item;
		elements.push(element);
		return element;
	}

	it('ignores attachment information arriving after the pane was disconnected', async function () {
		const item = await importFileAttachment('test.pdf');
		const box = mount('attachment-box', item);
		const pending = Zotero.Promise.defer();
		sandbox.stub(item, 'fileExists').returns(pending.promise);
		const updating = box.updateInfo();
		box.remove();
		pending.resolve(true);
		await updating;
		assert.isNull(box.querySelector('[data-id="title"]'));
	});

	it('ignores attachment counts after the containing tab is removed', async function () {
		const item = await createDataObject('item');
		const box = mount('attachments-box', item);
		box.remove();
		assert.doesNotThrow(() => box.updateCount());
	});

	it('ignores a queued context request for a library that no longer exists', async function () {
		const item = await importFileAttachment('test.pdf');
		const getLibrary = Zotero.Libraries.get.bind(Zotero.Libraries);
		sandbox.stub(Zotero.Libraries, 'get').callsFake(id => (id === item.libraryID ? false : getLibrary(id)));
		const pane = win.document.getElementById('zotero-context-pane-inner');
		await pane._addItemContext('removed-tab', item.id, 'reader');
		assert.isNull(pane._getItemContext('removed-tab'));
	});
});
