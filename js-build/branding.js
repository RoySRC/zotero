'use strict';

const fs = require('fs-extra');
const path = require('path');

// Downloaded/cached reader and editor bundles still carry upstream document titles.
module.exports = async function brandHTMLTitles(directory) {
	for (const entry of await fs.readdir(directory)) {
		if (!entry.endsWith('.html')) continue;
		const filename = path.join(directory, entry);
		const source = await fs.readFile(filename, 'utf8');
		const branded = source.replace(/<title>Zotero (Reader(?: View)?|Note Editor)<\/title>/g,
			'<title>EpiLib $1</title>');
		if (branded !== source) await fs.writeFile(filename, branded);
	}
};
