import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { assetSVG, loadAsset, sourceDirectory } from './assets.mjs';

test('all supplied artwork is embedded unchanged, with aspect-preserving crop bounds', () => {
	for (const name of ['compact', 'full', 'macos-compact']) {
		const asset = loadAsset(name);
		const svg = assetSVG(asset, 128, 96);
		assert.deepEqual(Buffer.from(svg.match(/base64,([^"]+)/)[1], 'base64'),
			fs.readFileSync(path.join(sourceDirectory, asset.filename)));
		assert(svg.includes('preserveAspectRatio="xMidYMid meet"'));
		assert(svg.includes(`viewBox="${asset.bounds.x} ${asset.bounds.y} ${asset.bounds.width} ${asset.bounds.height}"`));
		assert(!svg.includes('<text') && !svg.includes('<filter'));
	}
	assert.deepEqual(loadAsset('macos-compact').bounds, { x: 0, y: 0, width: 1254, height: 1254 });
	assert.equal(loadAsset('full').filename, 'full-transparent.png');
	assert.equal(loadAsset('full').data[25], 6, 'Full logo must be an RGBA PNG');
	assert.throws(() => loadAsset('../full'), /Unknown brand asset/);
});

test('raster-backed SVGs render at requested app-icon and wordmark dimensions', () => {
	for (const [name, width, height] of [['compact', 32, 32], ['full', 272, 101], ['macos-compact', 128, 128]]) {
		const png = execFileSync('rsvg-convert', [], { input: assetSVG(loadAsset(name), width, height) });
		assert.equal(png.toString('ascii', 1, 4), 'PNG');
		assert.equal(png.readUInt32BE(16), width);
		assert.equal(png.readUInt32BE(20), height);
		assert(png.length > 500, 'Artwork should not render as an empty PNG');
	}
});
