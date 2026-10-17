import fs from 'node:fs';
import path from 'node:path';

export const sourceDirectory = path.resolve(import.meta.dirname, '../../epilib-icons');

// Bounds exclude only transparent outer padding in the supplied artwork.
const bounds = {
	compact: { x: 312, y: 240, width: 629, height: 662 },
	full: { x: 30, y: 350, width: 1194, height: 442 },
	'macos-compact': { x: 0, y: 0, width: 1254, height: 1254 }
};

export function loadAsset(name) {
	if (!Object.hasOwn(bounds, name)) throw new Error(`Unknown brand asset: ${name}`);
	const filename = name === 'full' ? 'full-transparent.png' : `${name}.png`;
	const data = fs.readFileSync(path.join(sourceDirectory, filename));
	if (!data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
		throw new Error(`Invalid brand PNG: ${name}`);
	}
	const width = data.readUInt32BE(16), height = data.readUInt32BE(20);
	if (width !== 1254 || height !== 1254) {
		throw new Error(`Review transparent-padding bounds for updated ${name}.png (${width}x${height})`);
	}
	return { filename, data, width, height, bounds: bounds[name], uri: `data:image/png;base64,${data.toString('base64')}` };
}

export function assetSVG(asset, width, height = width, { padding = 0, background } = {}) {
	const box = asset.bounds;
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
${background ? `<rect width="100%" height="100%" fill="${background}"/>` : ''}
<svg x="${padding}" y="${padding}" width="${width - 2 * padding}" height="${height - 2 * padding}" viewBox="${box.x} ${box.y} ${box.width} ${box.height}" preserveAspectRatio="xMidYMid meet" overflow="hidden">
<image width="${asset.width}" height="${asset.height}" href="${asset.uri}"/>
</svg>
</svg>\n`;
}
