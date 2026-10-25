'use strict';

const path = require('path');
const fs = require('fs-extra');
const { promisify } = require('util');
const execFile = promisify(require('child_process').execFile);
const { createHash } = require('crypto');

/**
 * Consume the sibling engine checkout without copying its editable source into
 * the desktop. Release checkouts use the hash-verified, checked-in build artifact.
 * Developers can rebuild from the sibling repository or explicitly select a
 * checkout with EPILIB_RECOGNITION_SOURCE. A broken explicit override is an error.
 */
module.exports = async function getRecognitionEngine() {
	const started = Date.now();
	const source = process.env.EPILIB_RECOGNITION_SOURCE
		|| path.resolve(__dirname, '../../epilib-pdf-recognition-engine');
	const target = path.resolve(__dirname, '../build/resource/recognition-engine');
	const script = path.join(source, 'scripts/build-desktop.mjs');
	// Own this generated directory exclusively, including removal of old symlinks.
	await fs.remove(target);
	if (await fs.pathExists(script)) {
		await execFile(process.execPath, [script, target]);
	}
	else {
		if (process.env.EPILIB_RECOGNITION_SOURCE) throw new Error('EPILIB_RECOGNITION_SOURCE is not an engine checkout');
		const artifact = path.resolve(__dirname, '../resource/recognition-engine');
		const manifest = await fs.readJSON(path.join(artifact, 'manifest.json'));
		for (const filename of ['worker.js', 'host.mjs', 'LICENSES.txt']) {
			const digest = createHash('sha256').update(await fs.readFile(path.join(artifact, filename))).digest('hex');
			if (digest != manifest.files[filename]) throw new Error('Recognition bundle integrity failure: ' + filename);
		}
		await fs.copy(artifact, target);
	}
	return { action: 'recognition-engine', count: 4, totalCount: 4, processingTime: Date.now() - started };
};
