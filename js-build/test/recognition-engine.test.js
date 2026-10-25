'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('fs-extra');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');

/** Load the real build hook against an isolated clean checkout with no sibling source. */
async function fixture(t, env = {}) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'epilib-artifact-test-'));
	t.after(() => fs.remove(root));
	const desktop = path.join(root, 'desktop');
	const artifact = path.join(desktop, 'resource/recognition-engine');
	await fs.copy(path.resolve(__dirname, '../../resource/recognition-engine'), artifact);
	const module = { exports: {} };
	const source = await fs.readFile(path.resolve(__dirname, '../recognition-engine.js'), 'utf8');
	vm.runInNewContext(source, { require, module, __dirname: path.join(desktop, 'js-build'),
		process: { env, execPath: process.execPath } });
	return { run: module.exports, artifact, target: path.join(desktop, 'build/resource/recognition-engine') };
}

test('clean desktop builds copy the verified engine without a sibling checkout', async t => {
	const { run, artifact, target } = await fixture(t);
	assert.equal((await run()).count, 4);
	for (const filename of ['worker.js', 'host.mjs', 'manifest.json', 'LICENSES.txt']) {
		assert.deepEqual(await fs.readFile(path.join(target, filename)), await fs.readFile(path.join(artifact, filename)));
		assert.equal((await fs.lstat(path.join(target, filename))).isSymbolicLink(), false);
	}
});

test('a corrupt vendored worker fails the build instead of silently shipping', async t => {
	const { run, artifact } = await fixture(t);
	await fs.appendFile(path.join(artifact, 'worker.js'), '\n// corrupt fixture\n');
	await assert.rejects(run(), /integrity failure: worker.js/);
});

test('an explicit missing source checkout never silently falls back to old artifacts', async t => {
	const { run } = await fixture(t, { EPILIB_RECOGNITION_SOURCE: '/nonexistent-epilib-test-source' });
	await assert.rejects(run(), /not an engine checkout/);
});
