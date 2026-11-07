'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { shouldDetachTab, detachedWindowBounds, withTimeout } = require('../../chrome/content/zotero/tabDrag');

// These coordinates deliberately include a monitor to the left of the primary
// display. Negative screen coordinates are valid, not missing event data.
const source = { screenX: 100, screenY: 100, outerWidth: 900, tabBarBottom: 150, tabBarHeight: 30 };
const drop = { tabID: 'reader-test', screenX: 1100, screenY: 250,
	dropEffect: 'none', userCancelled: false };

test('deliberate drops outside the tab-bar boundary tear off on every platform', () => {
	for (const point of [[1100, 250], [-100, 250], [400, 900], [400, 50], [400, 400]]) {
		assert.equal(shouldDetachTab({ ...drop, screenX: point[0], screenY: point[1] }, source), true);
	}
	assert.equal(shouldDetachTab({ ...drop, tabID: 'zotero-pane', isMac: false }, source), true);
});

test('reordering, title bar, and the tab-bar lower margin do not tear off', () => {
	for (const point of [[400, 120], [400, 150], [400, 194]]) {
		assert.equal(shouldDetachTab({ ...drop, screenX: point[0], screenY: point[1] }, source), false);
	}
});

test('Escape, accepted drops, and foreign drags do not tear off', () => {
	for (const override of [
		{ userCancelled: true },
		{ dropEffect: 'move' },
		{ dropEffect: 'copy' },
		{ dropEffect: 'link' },
		{ dropEffect: undefined },
		{ tabID: null }
	]) {
		assert.equal(shouldDetachTab({ ...drop, ...override }, source), false);
	}
});

test('missing or invalid screen data fails closed', () => {
	for (const value of [undefined, NaN, Infinity, '1100']) {
		assert.equal(shouldDetachTab({ ...drop, screenX: value }, source), false);
	}
	assert.equal(shouldDetachTab(drop, { ...source, outerWidth: 0 }), false);
	assert.equal(shouldDetachTab(drop, { ...source, tabBarHeight: 0 }), false);
});

test('window positioning keeps the title bar and entire window on the destination monitor', () => {
	const screen = { left: -1440, top: 25, width: 1440, height: 875 };
	const result = detachedWindowBounds({ x: -1300, y: 50 }, { width: 900, height: 700 }, screen);
	assert.equal(result.left, -1340);
	assert.equal(result.top, 30);
	assert.equal(result.width, 900);
	assert.equal(result.height, 700);
	assert.deepEqual(detachedWindowBounds({ x: -5, y: 899 }, { width: 2000, height: 1000 }, screen),
		{ left: -1440, top: 25, width: 1440, height: 875 });
});

test('fractional Retina coordinates are rounded without changing screen coordinate systems', () => {
	assert.deepEqual(detachedWindowBounds({ x: 1520.4, y: 180.7 }, { width: 800, height: 600 },
		{ left: 1440, top: 25, width: 1920, height: 1055 }),
	{ left: 1480, top: 161, width: 800, height: 600 });
});

test('handoff waits work with native promises, propagate rejection, and bound stalled editors', async () => {
	assert.equal(await withTimeout(Promise.resolve('ready'), 50), 'ready');
	await assert.rejects(withTimeout(Promise.reject(new Error('load failed')), 50), /load failed/);
	await assert.rejects(withTimeout(new Promise(() => {}), 10), /Timed out/);
});
