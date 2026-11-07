'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const path = require('node:path');
const babel = require('@babel/core');
const { withTimeout } = require('../../chrome/content/zotero/tabDrag');

// Run the actual tab manager, replacing only Gecko's window/services boundary.
const source = babel.transformFileSync(path.join(__dirname, '../../chrome/content/zotero/tabs.js'), {
	presets: ['@babel/preset-react'], plugins: ['transform-es2015-modules-commonjs'],
	babelrc: false, configFile: false
}).code;
const deferred = () => {
	let resolve, reject;
	let promise = new Promise((res, rej) => {
		resolve = res; reject = rej;
	});
	return { promise, resolve, reject };
};
function manager(timeout = 1000) {
	const errors = [];
	const context = {
		require: id => (id === 'react'
			? { createRef: () => ({ current: null }) }
			: id === 'zotero/tabDrag' ? { withTimeout: operation => withTimeout(operation, timeout) } : {}),
		Services: { sysinfo: { getProperty: () => 16e9 } },
		Zotero: {
			Utilities: { randomString: () => 'test' },
			Notifier: { registerObserver() {} }, Prefs: { registerObserver() {} },
			Reader: { getByTabID() {} }, Notes: { getByTabID() {} },
			logError: error => errors.push(error)
		},
		window: { addEventListener() {}, closed: false }, document: {},
		setInterval() {}, setTimeout, clearTimeout
	};
	vm.createContext(context);
	vm.runInContext(source, context);
	const tabs = context.Zotero_Tabs;
	tabs._tabs = [{ id: 'source', type: 'note', title: 'Note', data: { itemID: 1 } }];
	tabs.close = (id) => {
		tabs._tabs = tabs._tabs.filter(tab => tab.id !== id);
	};
	return { tabs, Zotero: context.Zotero, window: context.window, errors };
}
function destination() {
	const removed = [];
	return {
		closed: false, focus() {}, close() {
			this.closed = true;
		},
		Zotero_Tabs: { addTransferredTab: async () => 'target', close: id => removed.push(id) }, removed
	};
}

test('note save and destination initialization finish before source removal; requests coalesce', async () => {
	const { tabs, Zotero } = manager();
	const saved = deferred(), loaded = deferred();
	let saves = 0, opens = 0;
	Zotero.Notes.getByTabID = () => ({ saveSync: () => {
		saves++; return saved.promise;
	} });
	const target = destination();
	target.Zotero_Tabs.addTransferredTab = () => {
		opens++; return loaded.promise;
	};
	const first = tabs.moveToWindow('source', target);
	assert.equal(tabs.moveToWindow('source', target), first);
	assert.equal(opens, 0);
	saved.resolve();
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(tabs._tabs.length, 1);
	loaded.resolve('ready');
	assert.equal(await first, 'ready');
	assert.equal(tabs._tabs.length, 0);
	assert.equal(saves, 1);
	assert.equal(opens, 1);
});

test('failed save leaves source usable and permits retry', async () => {
	const { tabs, Zotero } = manager();
	Zotero.Notes.getByTabID = () => ({ saveSync: () => Promise.reject(new Error('disk full')) });
	await assert.rejects(tabs.moveToWindow('source', destination()), /disk full/);
	assert.equal(tabs._tabs.length, 1);
	assert.equal(tabs._transferringTabs.size, 0);
	Zotero.Notes.getByTabID = () => ({ saveSync() {} });
	assert.equal(await tabs.moveToWindow('source', destination()), 'target');
});

test('cancellation during target load removes the new tab and preserves the source', async () => {
	const { tabs } = manager();
	const loaded = deferred(), target = destination(), token = {};
	target.Zotero_Tabs.addTransferredTab = () => loaded.promise;
	const moving = tabs.moveToWindow('source', target, undefined, token);
	await new Promise(resolve => setImmediate(resolve));
	token.cancelled = true;
	loaded.resolve('target');
	assert.equal(await moving, null);
	assert.equal(tabs._tabs.length, 1);
	assert.deepEqual(target.removed, ['target']);
});

test('cancellation during reader save prevents the native document swap', async () => {
	const { tabs, Zotero } = manager();
	tabs._tabs[0].type = 'reader';
	const saved = deferred(), token = {};
	let swaps = 0;
	Zotero.Reader.getByTabID = () => ({ canMoveToWindow: () => true, moveToWindow: () => {
		swaps++;
	} });
	tabs._flushReaderForTransfer = () => saved.promise;
	const moving = tabs.moveToWindow('source', destination(), undefined, token);
	token.cancelled = true;
	saved.resolve();
	assert.equal(await moving, null);
	assert.equal(swaps, 0);
	assert.equal(tabs._tabs.length, 1);
});

test('native reader failure preserves source; focus failure after success preserves destination', async () => {
	const { tabs, Zotero, errors } = manager();
	tabs._tabs[0].type = 'reader';
	tabs._flushReaderForTransfer = async () => {};
	const reader = { canMoveToWindow: () => true, moveToWindow: () => {
		throw new Error('swap failed');
	} };
	Zotero.Reader.getByTabID = () => reader;
	await assert.rejects(tabs.moveToWindow('source', destination()), /swap failed/);
	assert.equal(tabs._tabs.length, 1);
	reader.moveToWindow = () => 'moved-reader';
	const target = destination();
	target.focus = () => {
		throw new Error('focus failed');
	};
	assert.equal(await tabs.moveToWindow('source', target), 'moved-reader');
	assert.equal(target.closed, false);
	assert.equal(tabs._tabs.length, 0);
	assert.match(errors[0].message, /focus failed/);
});

test('new-window requests coalesce and source remains while the window initializes', async () => {
	const { tabs, Zotero } = manager();
	let token, calls = 0;
	Zotero.openMainWindow = ({ movedTab }) => {
		token = movedTab; calls++; return destination();
	};
	const first = tabs._moveToNewWindow('source');
	assert.equal(tabs._moveToNewWindow('source'), first);
	assert.equal(tabs._tabs.length, 1);
	token.onComplete('ready');
	assert.equal(await first, 'ready');
	assert.equal(calls, 1);
});

test('failed or stalled new windows close and cancel late transfers while preserving source', async () => {
	for (const stalls of [false, true]) {
		const { tabs, Zotero } = manager(10);
		let token;
		const target = destination();
		Zotero.openMainWindow = ({ movedTab }) => {
			token = movedTab; return target;
		};
		const moving = tabs._moveToNewWindow('source');
		if (!stalls) token.onError(new Error('load failed'));
		await assert.rejects(moving, stalls ? /Timed out/ : /load failed/);
		assert.equal(token.cancelled, true);
		assert.equal(target.closed, true);
		assert.equal(tabs._tabs.length, 1);
		assert.equal(tabs._detachingTabs.size, 0);
	}
});

test('recreated library tab must finish loading, and failed initialization removes its placeholder', async () => {
	const { tabs } = manager();
	const loaded = deferred();
	tabs.tabHooks.restoreState.library = async () => {
		tabs._tabs.push({ id: 'new-library', type: 'library-loading', loadPromise: loaded.promise });
		return { id: 'new-library' };
	};
	const adding = tabs.addTransferredTab({ type: 'library', title: 'Library', data: {} });
	await new Promise(resolve => setImmediate(resolve));
	assert.ok(tabs._getTab('new-library').tab);
	loaded.reject(new Error('library load failed'));
	await assert.rejects(adding, /library load failed/);
	assert.equal(tabs._getTab('new-library').tab, undefined);
	assert.ok(tabs._getTab('source').tab);
});

test('reader document resolving false cannot replace its source', async () => {
	const { tabs, Zotero } = manager();
	tabs.tabHooks.restoreState.reader = async () => {
		tabs._tabs.push({ id: 'new-reader', type: 'reader', loadPromise: Promise.resolve() });
		return { id: 'new-reader' };
	};
	Zotero.Reader.getByTabID = () => ({ _openPromise: Promise.resolve(false) });
	await assert.rejects(tabs.addTransferredTab({ type: 'reader', title: 'PDF', data: {} }), /document did not initialize/);
	assert.equal(tabs._getTab('new-reader').tab, undefined);
	assert.ok(tabs._getTab('source').tab);
});


test('completion failure after commit never closes the destination containing the moved tab', async () => {
	const { tabs, Zotero } = manager();
	let token;
	const target = destination();
	Zotero.openMainWindow = ({ movedTab }) => {
		token = movedTab;
		return target;
	};
	const moving = tabs._moveToNewWindow('source');
	token.completedID = 'committed';
	token.onError(new Error('completion callback failed'));
	assert.equal(await moving, 'committed');
	assert.equal(target.closed, false);
	assert.equal(token.cancelled, false);
});


test('a concurrent request for a different window cannot adopt another destination’s tab', async () => {
	const { tabs, Zotero } = manager();
	const saved = deferred();
	Zotero.Notes.getByTabID = () => ({ saveSync: () => saved.promise });
	const firstTarget = destination(), secondTarget = destination();
	const first = tabs.moveToWindow('source', firstTarget);
	assert.equal(await tabs.moveToWindow('source', secondTarget), null);
	assert.equal(tabs.moveToWindow('source', firstTarget), first);
	assert.equal(tabs._tabs.length, 1);
	saved.resolve();
	assert.equal(await first, 'target');
	assert.equal(secondTarget.closed, false);
});
