import fs from 'node:fs/promises';
import pg from 'pg';

const { Pool } = pg;

const OBJECT_TYPES = ['collection', 'search', 'item'];
const pluralByObjectType = {
	collection: 'collections',
	search: 'searches',
	item: 'items'
};
const API_VERSION = '3';
const DEFAULT_API_URL = 'https://api.zotero.org/';
const PAGE_LIMIT = 100;

let options = parseArgs(process.argv.slice(2));
const DATABASE_URL = options.databaseURL || process.env.DATABASE_URL;
const API_KEY = options.apiKey || process.env.ZOTERO_IMPORT_API_KEY;
const API_URL = normalizeBaseURL(options.apiURL || process.env.ZOTERO_IMPORT_API_URL || DEFAULT_API_URL);

if (!DATABASE_URL) {
	throw new Error('DATABASE_URL is required');
}
if (!API_KEY) {
	throw new Error('ZOTERO_IMPORT_API_KEY is required');
}

const pool = new Pool({ connectionString: DATABASE_URL });

async function main() {
	try {
		await ensureSchema();
		await refuseDirtyDatabaseUnlessReplacing();
		if (options.replace) {
			await replaceDatabase();
		}

		let api = new ZoteroAPI(API_URL, API_KEY);
		let keyInfo = await api.getKeyInfo();
		await upsertAccountIdentity(keyInfo);

		let libraries = [
			{
				type: 'user',
				typeID: keyInfo.userID,
				name: keyInfo.username,
				metadata: {},
				groupVersion: 0
			}
		];

		let groups = await api.getGroups(keyInfo.userID);
		for (let group of groups) {
			libraries.push({
				type: 'group',
				typeID: group.id,
				name: group.data?.name || `Group ${group.id}`,
				metadata: group.data || {},
				groupVersion: Number(group.version || 0)
			});
		}

		console.log(`Importing ${libraries.length} librar${libraries.length == 1 ? 'y' : 'ies'} from zotero.org`);
		for (let library of libraries) {
			await importLibrary(api, library);
		}

		await printSummary();
	}
	finally {
		await pool.end();
	}
}

async function ensureSchema() {
	let schema = await fs.readFile(new URL('../schema.sql', import.meta.url), 'utf8');
	await pool.query(schema);
}

async function refuseDirtyDatabaseUnlessReplacing() {
	if (options.replace) {
		return;
	}
	let result = await pool.query(
		"SELECT "
			+ "(SELECT COUNT(*) FROM account_identity) AS account_count, "
			+ "(SELECT COUNT(*) FROM users) AS user_count, "
			+ "(SELECT COUNT(*) FROM user_sync_settings) AS user_sync_settings_count, "
			+ "(SELECT COUNT(*) FROM libraries) AS library_count, "
			+ "(SELECT COUNT(*) FROM objects) AS object_count, "
			+ "(SELECT COUNT(*) FROM settings) AS setting_count, "
			+ "(SELECT COUNT(*) FROM storage_files) AS storage_file_count, "
			+ "(SELECT COUNT(*) FROM storage_file_items) AS storage_file_item_count"
	);
	let row = result.rows[0];
	let total = Number(row.account_count)
		+ Number(row.user_count)
		+ Number(row.user_sync_settings_count)
		+ Number(row.library_count)
		+ Number(row.object_count)
		+ Number(row.setting_count)
		+ Number(row.storage_file_count)
		+ Number(row.storage_file_item_count);
	if (total) {
		throw new Error(
			'PostgreSQL sync database already contains metadata. '
			+ 'Re-run with --replace to import a clean zotero.org snapshot.'
		);
	}
}

async function replaceDatabase() {
	await pool.query(
		'TRUNCATE storage_upload_queue, storage_last_sync, storage_files_existing, '
			+ 'storage_file_items, storage_file_libraries, storage_files, '
			+ 'auth_tokens, user_sync_settings, users, account_identity, '
			+ 'deleted_objects, settings, objects, libraries '
			+ 'RESTART IDENTITY CASCADE'
	);
}

async function upsertAccountIdentity(keyInfo) {
	await pool.query(
		"INSERT INTO users (zotero_user_id, username, display_name, emails, updated_at) "
			+ "VALUES ($1, $2, $3, $4, now()) "
			+ "ON CONFLICT (zotero_user_id) DO UPDATE "
			+ "SET username=EXCLUDED.username, display_name=EXCLUDED.display_name, "
			+ "emails=EXCLUDED.emails, updated_at=now()",
		[
			keyInfo.userID,
			keyInfo.username,
			keyInfo.displayName || keyInfo.username,
			JSON.stringify(keyInfo.emails || [])
		]
	);
	await pool.query(
		"INSERT INTO account_identity (id, user_id, username, display_name, emails, updated_at) "
			+ "VALUES (1, $1, $2, $3, $4, now()) "
			+ "ON CONFLICT (id) DO UPDATE "
			+ "SET user_id=EXCLUDED.user_id, username=EXCLUDED.username, "
			+ "display_name=EXCLUDED.display_name, emails=EXCLUDED.emails, updated_at=now()",
		[
			keyInfo.userID,
			keyInfo.username,
			keyInfo.displayName || keyInfo.username,
			JSON.stringify(keyInfo.emails || [])
		]
	);
}

async function importLibrary(api, library) {
	let label = library.type == 'user' ? 'My Library' : library.name;
	console.log(`Importing ${label} (${library.type}:${library.typeID})`);

	let libraryID = await upsertLibrary(library, 0);
	await pool.query('DELETE FROM deleted_objects WHERE library_id=$1', [libraryID]);
	await clearLibraryStorage(libraryID);

	let maxLibraryVersion = 0;
	let settingsResult = await api.getSettings(library.type, library.typeID);
	if (settingsResult) {
		maxLibraryVersion = Math.max(maxLibraryVersion, settingsResult.libraryVersion);
		await replaceSettings(libraryID, settingsResult.settings);
	}

	for (let objectType of OBJECT_TYPES) {
		let versionsResult = await api.getVersions(library.type, library.typeID, objectType);
		if (!versionsResult) {
			continue;
		}
		maxLibraryVersion = Math.max(maxLibraryVersion, versionsResult.libraryVersion);
		let keys = Object.keys(versionsResult.versions);
		console.log(`  ${objectType}s: ${keys.length}`);
		await replaceObjects(libraryID, objectType, keys, async (batch) => {
			return api.downloadObjects(library.type, library.typeID, objectType, batch);
		});
	}

	await setLibraryVersion(libraryID, maxLibraryVersion);
}

async function upsertLibrary(library, version) {
	let result = await pool.query(
		"INSERT INTO libraries (type, type_id, name, version, group_version, metadata, updated_at) "
			+ "VALUES ($1, $2, $3, $4, $5, $6, now()) "
			+ "ON CONFLICT (type, type_id) DO UPDATE "
			+ "SET name=EXCLUDED.name, version=EXCLUDED.version, "
			+ "group_version=EXCLUDED.group_version, metadata=EXCLUDED.metadata, updated_at=now() "
			+ "RETURNING id",
		[
			library.type,
			library.typeID,
			library.name,
			version,
			library.groupVersion || 0,
			JSON.stringify(library.metadata || {})
		]
	);
	return result.rows[0].id;
}

async function setLibraryVersion(libraryID, version) {
	await pool.query(
		"UPDATE libraries SET version=$1, updated_at=now() WHERE id=$2",
		[version, libraryID]
	);
}

async function replaceSettings(libraryID, settings) {
	await pool.query('DELETE FROM settings WHERE library_id=$1', [libraryID]);
	let entries = Object.entries(settings || {});
	for (let [key, setting] of entries) {
		let value = setting && Object.prototype.hasOwnProperty.call(setting, 'value')
			? setting.value
			: null;
		await pool.query(
			"INSERT INTO settings (library_id, key, version, value, updated_at) "
				+ "VALUES ($1, $2, $3, $4, now())",
			[
				libraryID,
				key,
				Number(setting.version || 0),
				JSON.stringify(value)
			]
		);
	}
	console.log(`  settings: ${entries.length}`);
}

async function replaceObjects(libraryID, objectType, keys, downloadBatch) {
	await pool.query(
		'DELETE FROM objects WHERE library_id=$1 AND object_type=$2',
		[libraryID, objectType]
	);
	for (let i = 0; i < keys.length; i += PAGE_LIMIT) {
		let batch = keys.slice(i, i + PAGE_LIMIT);
		let objects = await downloadBatch(batch);
		for (let object of objects) {
			let data = Object.assign({}, object.data || {});
			let key = object.key || data.key;
			if (!key) {
				throw new Error(`Downloaded ${objectType} without key`);
			}
			let version = Number(object.version || data.version || 0);
			data.key = key;
			data.version = version;
				let insert = await pool.query(
					"INSERT INTO objects (library_id, object_type, key, version, data, updated_at) "
						+ "VALUES ($1, $2, $3, $4, $5, now()) RETURNING object_id",
					[libraryID, objectType, key, version, JSON.stringify(data)]
				);
				if (objectType == 'item') {
					await syncAttachmentStorageMapping(pool, libraryID, insert.rows[0].object_id, data);
				}
		}
	}
	if (objectType == 'item') {
		await pruneStorageFileLibraryReferences(pool, libraryID);
	}
}

async function clearLibraryStorage(libraryID) {
	await pool.query(
		"DELETE FROM storage_file_items "
			+ "USING objects "
			+ "WHERE storage_file_items.object_id=objects.object_id "
			+ "AND objects.library_id=$1",
		[libraryID]
	);
	await pool.query('DELETE FROM storage_file_libraries WHERE library_id=$1', [libraryID]);
	await pool.query('UPDATE libraries SET storage_usage=0 WHERE id=$1', [libraryID]);
}

async function syncAttachmentStorageMapping(client, libraryID, objectID, data) {
	if (!isStoredAttachment(data)) {
		await client.query('DELETE FROM storage_file_items WHERE object_id=$1', [objectID]);
		return;
	}

	let itemHash = normalizeHash(data.md5);
	let itemFilename = data.filename || data.title || data.key;
	let storageHash = normalizeHash(data.zipMD5 || data.md5);
	let storageFilename = data.zipFilename || data.filename || `${data.key}.zip`;
	let isZip = !!data.zipMD5 || !!data.zipFilename || data.zip === true;
	let size = nonNegativeInteger(data.filesize ?? data.size ?? 0);
	let mtime = nonNegativeInteger(data.mtime);
	if (!itemHash || !storageHash || !storageFilename || mtime === null) {
		await client.query('DELETE FROM storage_file_items WHERE object_id=$1', [objectID]);
		return;
	}

	let file = await client.query(
		"INSERT INTO storage_files (hash, filename, size, zip, last_added) "
			+ "VALUES ($1, $2, $3, $4, now()) "
			+ "ON CONFLICT (hash, filename, zip) DO UPDATE "
			+ "SET size=GREATEST(storage_files.size, EXCLUDED.size), last_added=now() "
			+ "RETURNING storage_file_id",
		[storageHash, storageFilename, size || 0, isZip]
	);
	let storageFileID = file.rows[0].storage_file_id;
	await client.query(
		"INSERT INTO storage_file_libraries (storage_file_id, library_id) "
			+ "VALUES ($1, $2) ON CONFLICT DO NOTHING",
		[storageFileID, libraryID]
	);
	await client.query(
		"INSERT INTO storage_file_items "
			+ "(storage_file_id, object_id, mtime, size, item_hash, item_filename, content_type, charset, updated_at) "
			+ "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now()) "
			+ "ON CONFLICT (object_id) DO UPDATE "
			+ "SET storage_file_id=EXCLUDED.storage_file_id, mtime=EXCLUDED.mtime, "
			+ "size=EXCLUDED.size, item_hash=EXCLUDED.item_hash, "
			+ "item_filename=EXCLUDED.item_filename, content_type=EXCLUDED.content_type, "
			+ "charset=EXCLUDED.charset, updated_at=now()",
		[
			storageFileID,
			objectID,
			mtime,
			size || 0,
			itemHash,
			itemFilename,
			data.contentType || null,
			data.charset || null
		]
	);
}

async function pruneStorageFileLibraryReferences(client, libraryID) {
	await client.query(
		"DELETE FROM storage_file_libraries sfl "
			+ "WHERE sfl.library_id=$1 "
			+ "AND NOT EXISTS ("
			+ "SELECT 1 FROM storage_file_items sfi "
			+ "JOIN objects o ON o.object_id=sfi.object_id "
			+ "WHERE sfi.storage_file_id=sfl.storage_file_id "
			+ "AND o.library_id=sfl.library_id"
			+ ")",
		[libraryID]
	);
}

function isStoredAttachment(data) {
	if (!data || data.itemType != 'attachment') {
		return false;
	}
	let linkMode = `${data.linkMode || ''}`.toLowerCase();
	return linkMode == 'imported_file' || linkMode == 'imported_url';
}

function normalizeHash(value) {
	if (!value) {
		return null;
	}
	return `${value}`.trim().toLowerCase();
}

function nonNegativeInteger(value) {
	if (value === undefined || value === null || value === '') {
		return null;
	}
	let parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed < 0) {
		return null;
	}
	return Math.round(parsed);
}

async function printSummary() {
	let libraries = await pool.query(
		"SELECT type, type_id, name, version, group_version FROM libraries ORDER BY type, name"
	);
	let objects = await pool.query(
		"SELECT l.type, l.type_id, o.object_type, COUNT(*) AS count "
			+ "FROM libraries l JOIN objects o ON o.library_id=l.id "
			+ "GROUP BY l.type, l.type_id, o.object_type "
			+ "ORDER BY l.type, l.type_id, o.object_type"
	);
	console.log('\nImported libraries:');
	for (let row of libraries.rows) {
		console.log(
			`  ${row.type}:${row.type_id} ${row.name} `
				+ `(libraryVersion=${row.version}, groupVersion=${row.group_version})`
		);
		for (let objectRow of objects.rows.filter(x => x.type == row.type && x.type_id == row.type_id)) {
			console.log(`    ${objectRow.object_type}s: ${objectRow.count}`);
		}
	}
}

class ZoteroAPI {
	constructor(baseURL, apiKey) {
		this.baseURL = baseURL;
		this.apiKey = apiKey;
	}

	async getKeyInfo() {
		let { json } = await this.requestJSON('keys/current', {
			query: { includeEmails: '1' }
		});
		if (!json.userID) {
			throw new Error('zotero.org key response did not include userID');
		}
		if (!json.username) {
			throw new Error('zotero.org key response did not include username');
		}
		return json;
	}

	async getGroups(userID) {
		return this.requestPagedArray(`users/${userID}/groups`);
	}

	async getSettings(libraryType, libraryTypeID) {
		let { json, libraryVersion } = await this.requestJSON(
			`${libraryType}s/${libraryTypeID}/settings`
		);
		return { settings: json || {}, libraryVersion };
	}

	async getVersions(libraryType, libraryTypeID, objectType) {
		let plural = pluralByObjectType[objectType];
		let query = { format: 'versions' };
		if (objectType == 'item') {
			query.includeTrashed = '1';
		}
		let { json, libraryVersion } = await this.requestPagedObject(
			`${libraryType}s/${libraryTypeID}/${plural}`,
			query
		);
		return { versions: json || {}, libraryVersion };
	}

	async downloadObjects(libraryType, libraryTypeID, objectType, keys) {
		if (!keys.length) {
			return [];
		}
		let plural = pluralByObjectType[objectType];
		let query = {
			[`${objectType}Key`]: keys.join(',')
		};
		if (objectType == 'item') {
			query.includeTrashed = '1';
		}
		let { json } = await this.requestJSON(
			`${libraryType}s/${libraryTypeID}/${plural}`,
			{ query }
		);
		return json || [];
	}

	async requestPagedArray(path, query = {}) {
		let results = [];
		await this.requestPages(path, query, (json) => {
			results.push(...(json || []));
		});
		return results;
	}

	async requestPagedObject(path, query = {}) {
		let result = {};
		let maxLibraryVersion = 0;
		await this.requestPages(path, query, (json, response) => {
			Object.assign(result, json || {});
			maxLibraryVersion = Math.max(maxLibraryVersion, getLibraryVersion(response));
		});
		return { json: result, libraryVersion: maxLibraryVersion };
	}

	async requestPages(path, query, onPage) {
		let start = 0;
		while (true) {
			let response = await this.requestJSON(path, {
				query: Object.assign({}, query, { start, limit: PAGE_LIMIT })
			});
			onPage(response.json, response);
			let total = Number(response.headers.get('total-results') || 0);
			let returned = Array.isArray(response.json)
				? response.json.length
				: Object.keys(response.json || {}).length;
			if (!total || start + returned >= total || returned == 0) {
				break;
			}
			start += returned;
		}
	}

	async requestJSON(path, { query = {}, successCodes = [200] } = {}) {
		let url = new URL(path, this.baseURL);
		for (let [key, value] of Object.entries(query)) {
			if (value !== undefined && value !== null && value !== '') {
				url.searchParams.set(key, value);
			}
		}

		let response = await this.fetchWithRetry(url);
		let text = await response.text();
		if (!successCodes.includes(response.status)) {
			throw new Error(
				`zotero.org request failed with status ${response.status}: `
					+ `${url} ${text.slice(0, 240)}`
			);
		}
		let json = text ? JSON.parse(text) : null;
		return {
			json,
			headers: response.headers,
			status: response.status,
			libraryVersion: getLibraryVersion({ headers: response.headers })
		};
	}

	async fetchWithRetry(url) {
		for (let attempt = 0; ; attempt++) {
			let response = await fetch(url, {
				headers: {
					'Zotero-API-Key': this.apiKey,
					'Zotero-API-Version': API_VERSION
				}
			});
			if (response.status != 429 || attempt >= 5) {
				return response;
			}
			let retryAfter = Number(response.headers.get('retry-after') || 1);
			await delay(Math.max(retryAfter, 1) * 1000);
		}
	}
}

function getLibraryVersion(response) {
	return Number(response.headers.get('last-modified-version') || 0);
}

function normalizeBaseURL(url) {
	return url.endsWith('/') ? url : url + '/';
}

function delay(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function parseArgs(args) {
	let parsed = { replace: false };
	for (let i = 0; i < args.length; i++) {
		let arg = args[i];
		if (arg == '--replace') {
			parsed.replace = true;
		}
		else if (arg == '--api-key') {
			parsed.apiKey = args[++i];
		}
		else if (arg == '--api-url') {
			parsed.apiURL = args[++i];
		}
		else if (arg == '--database-url') {
			parsed.databaseURL = args[++i];
		}
		else {
			throw new Error(`Unknown argument: ${arg}`);
		}
	}
	return parsed;
}

await main();
