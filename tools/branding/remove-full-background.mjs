// One-time, source-specific background extraction. Requires the optional sharp package.
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
const sharp = createRequire(import.meta.url)('sharp');
const directory = path.resolve(import.meta.dirname, '../../epilib-icons');
const source = path.join(directory, 'full.png');
const target = path.join(directory, 'full-transparent.png');
const { data, info } = await sharp(source).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
assert.equal(info.width, 1254);
assert.equal(info.height, 1254);
const pages = await sharp(path.join(import.meta.dirname, 'full-logo-pages.svg'))
	.ensureAlpha().raw().toBuffer();
const result = Buffer.from(data);
const chroma = index => Math.max(data[index], data[index + 1], data[index + 2])
	- Math.min(data[index], data[index + 1], data[index + 2]);

for (let y = 0; y < info.height; y++) {
	for (let x = 0; x < info.width; x++) {
		const index = (y * info.width + x) * 4;
		if (!data[index + 3]) continue;
		const color = chroma(index);
		let alpha = color > 6 ? 1 : 0;
		// Recover coverage at colored edges from nearby opaque foreground, removing the white matte.
		if (color > 6 && color < 130) {
			let reference = 0;
			for (let radius = 1; radius <= 3 && !reference; radius++) {
				for (let dy = -radius; dy <= radius; dy++) {
					for (let dx = -radius; dx <= radius; dx++) {
						const px = x + dx, py = y + dy;
						if (px < 0 || py < 0 || px >= info.width || py >= info.height) continue;
						const nearby = chroma((py * info.width + px) * 4);
						if (nearby >= 130) reference = Math.max(reference, nearby);
					}
				}
			}
			alpha = reference ? Math.min(1, color / reference) : 0;
		}
		alpha = Math.max(alpha, pages[index + 3] / 255);
		result[index + 3] = Math.round(data[index + 3] * alpha);
		if (alpha > 0 && alpha < 1) {
			for (let channel = 0; channel < 3; channel++) {
				result[index + channel] = Math.max(0, Math.min(255,
					Math.round((data[index + channel] - 254 * (1 - alpha)) / alpha)));
			}
		}
	}
}

const pixel = (buffer, x, y) => buffer.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 4);
for (const [x, y] of [[31, 351], [600, 400], [800, 750], [680, 620], [1120, 620],
	[60, 600], [415, 600], [420, 650]]) {
	assert.equal(pixel(result, x, y)[3], 0, `Background should be transparent at ${x},${y}`);
}
// These white areas belong to the pages, not the backdrop (see macos-compact.png).
for (const [x, y] of [[150, 500], [180, 590], [150, 700], [500, 500], [900, 660],
	[330, 575], [390, 575], [350, 655], [300, 675], [255, 580], [255, 675],
	[255, 572], [345, 530]]) {
	assert.deepEqual(pixel(result, x, y), pixel(data, x, y), `Foreground changed at ${x},${y}`);
}
await sharp(result, { raw: info }).png().toFile(target);
assert.equal((await sharp(target).metadata()).hasAlpha, true);
console.log(`Saved ${target}; transparent background and original foreground samples verified`);
