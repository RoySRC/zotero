import { createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { parser } from 'stream-json';
import { pick } from 'stream-json/filters/pick.js';
import { streamArray } from 'stream-json/streamers/stream-array.js';
import chain from 'stream-chain';
import { fromCrossref } from './metadata.mjs';
import { createStore } from './store.mjs';

/**
 * Evaluate an explicitly supplied, trusted Crossref JSON or JSON.gz sample.
 * Snapshot files have an `items` array; saved REST responses have `message.items`.
 * Streaming and a mandatory bounded record limit avoid loading a corpus into RAM.
 * The function does no downloading, and imports only with an explicit store.
 */
export async function evaluate({ file, limit = 1000, path = 'items', store = null }) {
	if (!file || !Number.isInteger(limit) || limit < 1 || limit > 100000
			|| !['items', 'message.items'].includes(path)) throw new Error('Use --file, --limit 1..100000, and --path items or message.items');
	let input = createReadStream(file);
	let pipeline = chain([input, ...(file.endsWith('.gz') ? [createGunzip()] : []),
		parser(), pick({ filter: path, maxDepth: 64 }), streamArray()]);
	let start = performance.now();
	let seen = 0, supported = 0, normalizedBytes = 0;
	let samples = [];
	try {
		for await (let { value } of pipeline) {
			seen++;
			let record = fromCrossref(value);
			if (record) {
				supported++;
				normalizedBytes += Buffer.byteLength(JSON.stringify(record));
				if (samples.length < 100) samples.push(record);
				if (store) await store.importRecord(record);
			}
			if (seen >= limit) break;
		}
	}
	finally { pipeline.destroy(); input.destroy(); }
	if (!seen) throw new Error('No records found at the selected array path');
	let importMilliseconds = performance.now() - start;
	let lookup = [];
	if (store) {
		for (let sample of samples) {
			let started = performance.now();
			await store.localDOI(sample.DOI);
			await store.search(sample.title);
			lookup.push(performance.now() - started);
		}
		lookup.sort((a, b) => a - b);
	}
	return { seen, supported, skipped: seen - supported, normalizedBytes,
		inputBytesRead: input.bytesRead, importMilliseconds,
		peakRSSKiB: process.resourceUsage().maxRSS,
		index: store ? await store.stats() : null,
		lookupPairMilliseconds: lookup.length ? { count: lookup.length,
			p50: lookup[Math.floor(lookup.length * 0.5)], p95: lookup[Math.floor(lookup.length * 0.95)] } : null };
}

/** CLI wrapper: importing requires an explicit flag and a dedicated database URL. */
async function main() {
	let { values } = parseArgs({ options: { file: { type: 'string' }, limit: { type: 'string', default: '1000' },
		path: { type: 'string', default: 'items' }, import: { type: 'boolean', default: false } } });
	if (values.import && !process.env.DATABASE_URL) throw new Error('--import requires a dedicated recognition DATABASE_URL');
	let store = values.import ? await createStore(process.env.DATABASE_URL) : null;
	try { console.log(JSON.stringify(await evaluate({ file: values.file, limit: Number(values.limit), path: values.path, store }), null, 2)); }
	finally { await store?.close(); }
}

if (process.argv[1] && import.meta.url == pathToFileURL(process.argv[1]).href) {
	main().catch(() => { console.error('Evaluation failed. Check input format, arguments, and dedicated database configuration.'); process.exitCode = 1; });
}
