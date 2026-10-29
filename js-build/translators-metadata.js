'use strict';

const fs = require('fs-extra');
const path = require('path');

const { onError, onSuccess } = require('./utils');

const ROOT = path.resolve(__dirname, '..');

function parseFirstJSONObject(source, fileName) {
	const start = source.indexOf('{');
	if (start == -1) {
		throw new Error(`No translator metadata object in ${fileName}`);
	}
	
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < source.length; i++) {
		let ch = source[i];
		if (inString) {
			if (escaped) {
				escaped = false;
			}
			else if (ch == '\\') {
				escaped = true;
			}
			else if (ch == '"') {
				inString = false;
			}
			continue;
		}
		
		if (ch == '"') {
			inString = true;
		}
		else if (ch == '{') {
			depth++;
		}
		else if (ch == '}') {
			depth--;
			if (depth == 0) {
				return JSON.parse(source.slice(start, i + 1));
			}
		}
	}
	
	throw new Error(`Unterminated translator metadata object in ${fileName}`);
}

async function getTranslatorsMetadata() {
	const t1 = Date.now();
	const translatorsDir = path.join(ROOT, 'translators');
	const metadataIndex = {};
	
	let fileNames = (await fs.readdir(translatorsDir))
		.filter(fileName => /^[^.].*\.js$/.test(fileName))
		.sort();
	
	for (let fileName of fileNames) {
		let source = await fs.readFile(path.join(translatorsDir, fileName), 'utf8');
		let metadata = parseFirstJSONObject(source, fileName);
		if (!metadata.translatorID) {
			throw new Error(`translatorID missing in ${fileName}`);
		}
		metadata.fileName = fileName;
		metadataIndex[metadata.translatorID] = metadata;
	}
	
	await fs.outputJson(path.join(ROOT, 'build', 'translators.json'), metadataIndex, {
		spaces: 2
	});
	
	const t2 = Date.now();
	return {
		action: 'translator metadata',
		count: fileNames.length,
		totalCount: fileNames.length,
		processingTime: t2 - t1
	};
}

module.exports = getTranslatorsMetadata;

if (require.main === module) {
	(async () => {
		try {
			onSuccess(await getTranslatorsMetadata());
		}
		catch (err) {
			process.exitCode = 1;
			global.isError = true;
			onError(err);
		}
	})();
}
