// Regenerate EpiLib brand assets without changing the resource paths consumers use.
// Requires librsvg (rsvg-convert) and macOS iconutil for the .icns bundle.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const workspace = path.resolve(import.meta.dirname, '../../..');
const desktop = path.join(workspace, 'zotero-desktop');
const icon = fs.readFileSync(path.join(import.meta.dirname, 'epilib-icon.svg'), 'utf8');
const mark = fs.readFileSync(path.join(import.meta.dirname, 'epilib-mark.svg'), 'utf8');
const wordmark = fs.readFileSync(path.join(import.meta.dirname, 'epilib-wordmark.svg'), 'utf8');
const share = fs.readFileSync(path.join(import.meta.dirname, 'epilib-share.svg'), 'utf8');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'epilib-brand-'));
let count = 0;

function render(filename, svg, width, height = width) {
	const png = execFileSync('rsvg-convert', ['-w', String(width), '-h', String(height)], { input: svg });
	fs.writeFileSync(filename, png);
	count++;
}

try {
	for (const repo of ['zotero-desktop', 'zotero-connectors', 'zotero-ios', 'zotero-android', 'safari-web-extension']) {
		const root = path.join(workspace, repo);
		const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0');
		for (const file of files) {
			if (!file.endsWith('.png')) continue;
			const selected = repo === 'zotero-desktop'
				? /^(app\/linux\/icons\/icon\d+|chrome\/skin\/default\/zotero\/zotero-new-z-16px)\.png$/.test(file)
				: repo === 'zotero-connectors'
					? /^(icons\/Icon-|src\/.*\/zotero-(z-|app-))/.test(file)
					: repo === 'zotero-ios'
						? /\/(AppIcon\.appiconset|Login\/logo\.imageset|Onboarding\/share\.imageset)\//.test(file)
						: repo === 'zotero-android'
							? /\/mipmap-[^/]+\/ic_launcher\.png$|\/onboarding_share\.png$/.test(file)
							: /\/AppIcon\.appiconset\/|\/Resources\/Icon\.png$/.test(file);
			if (!selected) continue;
			const filename = path.join(root, file);
			const png = fs.readFileSync(filename);
			if (png.toString('ascii', 1, 4) !== 'PNG') throw new Error(`Missing PNG/LFS data: ${filename}`);
			let svg = icon;
			if (/Onboarding\/share|onboarding_share/.test(file)) svg = share;
			else if (/Login\/logo/.test(file)) svg = wordmark.replace('context-fill', file.includes('inverted') ? '#ffffff' : '#12665c');
			else if (/zotero-z-/.test(file)) svg = mark.replace('context-fill', file.includes('offline') ? '#888888' : '#12665c');
			else if (repo === 'zotero-ios') svg = icon.replace('rx="216"', 'rx="0"');
			render(filename, svg, png.readUInt32BE(16), png.readUInt32BE(20));
		}
	}
	for (const name of ['z.svg', 'zotero-z-32px-australis.svg', 'zotero-z-32px-australis-mac.svg', 'zotero-z-32px-australis-unix.svg', 'zotero-z-32px-australis-win.svg']) {
		fs.writeFileSync(path.join(desktop, 'chrome/skin/default/zotero', name), mark.replace('context-fill', '#12665c'));
	}
	fs.writeFileSync(path.join(desktop, 'chrome/skin/default/zotero/zotero.svg'), wordmark);
	fs.writeFileSync(path.join(desktop, 'app/linux/icons/symbolic.svg'), mark.replace('context-fill', '#000000'));
	fs.writeFileSync(path.join(workspace, 'zotero-ios/Zotero/Assets/Assets.xcassets/launch_z.imageset/launch_z.svg'), mark.replace('context-fill', '#12665c'));
	const iosIcon = path.join(workspace, 'zotero-ios/Zotero/Assets/AppIcon.icon');
	fs.writeFileSync(path.join(iosIcon, 'Assets/epilib.svg'), mark.replace('context-fill', '#ffffff'));
	fs.writeFileSync(path.join(iosIcon, 'icon.json'), JSON.stringify({
		'fill-specializations': [{ value: { solid: 'srgb:0.07059,0.40000,0.36078,1.00000' } }],
		groups: [{ layers: [{ 'image-name': 'epilib.svg', name: 'EpiLib', 'glass-specializations': [{ value: false }] }],
			position: { scale: 0.72, 'translation-in-points': [0, 0] } }],
		'supported-platforms': { circles: ['watchOS'], squares: 'shared' }
	}, null, 2) + '\n');
	const iconset = path.join(temp, 'epilib.iconset');
	fs.mkdirSync(iconset);
	for (const size of [16, 32, 128, 256, 512]) {
		render(path.join(iconset, `icon_${size}x${size}.png`), icon, size);
		render(path.join(iconset, `icon_${size}x${size}@2x.png`), icon, size * 2);
	}
	execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(desktop, 'app/mac/Contents/Resources/epilib.icns')]);
	// ICO supports PNG-compressed entries. Include each common Windows scaling size.
	const images = [16, 24, 32, 48, 64, 128, 256].map(size => ({ size,
		data: execFileSync('rsvg-convert', ['-w', String(size), '-h', String(size)], { input: icon }) }));
	const header = Buffer.alloc(6 + images.length * 16);
	header.writeUInt16LE(1, 2);
	header.writeUInt16LE(images.length, 4);
	let offset = header.length;
	images.forEach(({ size, data }, i) => {
		const entry = 6 + i * 16;
		header[entry] = header[entry + 1] = size === 256 ? 0 : size;
		header.writeUInt16LE(1, entry + 4);
		header.writeUInt16LE(32, entry + 6);
		header.writeUInt32LE(data.length, entry + 8);
		header.writeUInt32LE(offset, entry + 12);
		offset += data.length;
	});
	fs.writeFileSync(path.join(desktop, 'app/win/zotero.ico'), Buffer.concat([header, ...images.map(x => x.data)]));
	fs.copyFileSync(path.join(desktop, 'app/win/zotero.ico'), path.join(desktop, 'app/win/installer/setup.ico'));
	console.log(`Generated ${count} PNGs, desktop ICO/ICNS, SVG marks and iOS layered icon`);
}
finally {
	fs.rmSync(temp, { recursive: true, force: true });
}
