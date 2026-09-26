import express from 'express';
import crypto from 'node:crypto';
import pg from 'pg';

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;
const LEGACY_API_KEY = process.env.ZOTERO_SYNC_API_KEY || '';
const USER_ID = parseInt(process.env.ZOTERO_SYNC_USER_ID || '1', 10);
const USERNAME = process.env.ZOTERO_SYNC_USERNAME || 'postgresql';
const DISPLAY_NAME = process.env.ZOTERO_SYNC_DISPLAY_NAME || USERNAME;
const PORT = parseInt(process.env.PORT || '23129', 10);

if (!DATABASE_URL) {
	throw new Error('DATABASE_URL is required');
}

const pool = new Pool({ connectionString: DATABASE_URL });
const app = express();
app.use(express.json({ limit: '25mb' }));
app.use((req, res, next) => {
	let started = Date.now();
	res.on('finish', () => {
		console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - started}ms`);
	});
	next();
});

const objectTypeByPlural = {
	items: 'item',
	collections: 'collection',
	searches: 'search'
};
const pluralByObjectType = {
	item: 'items',
	collection: 'collections',
	search: 'searches'
};
const canonicalItemFieldOrder = [
	'key',
	'version',
	'itemType',
	'parentItem',
	'linkMode',
	'contentType',
	'charset',
	'path',
	'filename',
	'annotationType',
	'annotationAuthorName',
	'annotationText',
	'annotationComment',
	'annotationColor',
	'annotationPageLabel',
	'annotationSortIndex',
	'annotationPosition'
];

app.use(asyncHandler(async (req, res, next) => {
	if (req.path == '/health' || req.path == '/auth/login') {
		return next();
	}
	let key = req.get('Zotero-API-Key');
	let user = key ? await getAuthenticatedUserForToken(key) : null;
	if (!user) {
		return res.status(403).json({ error: 'forbidden' });
	}
	req.authUser = user;
	next();
}));

app.get('/health', (_req, res) => {
	res.json({ ok: true });
});

app.post('/auth/login', asyncHandler(async (req, res) => {
	let username = `${req.body?.username || ''}`.trim();
	let password = `${req.body?.password || ''}`;
	let identity = username ? await getUserByUsername(username) : null;
	if (!username || !password
			|| !identity
			|| !(await verifyPassword(password, identity))) {
		res.status(403).json({ error: 'forbidden' });
		return;
	}

	let apiKey = await issueAuthToken(identity.id);
	res.json({
		apiKey,
		userID: identity.userID,
		username: identity.username,
		displayName: identity.displayName,
		emails: identity.emails,
		syncSettings: await getSyncSettings(identity.id)
	});
}));

app.get('/keys/current', asyncHandler(async (req, res) => {
	let identity = req.authUser;
	res.json({
		userID: identity.userID,
		username: identity.username,
		displayName: identity.displayName,
		emails: identity.emails,
		access: {
			user: {
				library: true,
				notes: true,
				write: true,
				files: true
			},
			groups: {
				all: {
					library: true,
					write: true,
					files: true
				}
			}
		}
	});
}));

app.get('/sync/settings', asyncHandler(async (req, res) => {
	res.json(await getSyncSettings(req.authUser.id));
}));

app.put('/sync/settings', asyncHandler(async (req, res) => {
	let settings = req.body;
	if (!settings || typeof settings != 'object' || Array.isArray(settings)) {
		res.status(400).json({ error: 'invalid_settings' });
		return;
	}
	await query(
		"INSERT INTO user_sync_settings (user_id, data, updated_at) VALUES ($1, $2, now()) "
			+ "ON CONFLICT (user_id) DO UPDATE SET data=EXCLUDED.data, updated_at=now()",
		[req.authUser.id, settings]
	);
	res.status(204).end();
}));

app.get('/users/:userID/groups', asyncHandler(async (req, res) => {
	let identity = req.authUser;
	if (Number(req.params.userID) != identity.userID) {
		res.status(403).json({ error: 'forbidden' });
		return;
	}
	let rows = await query(
		"SELECT type_id, name, group_version, metadata FROM libraries "
			+ "WHERE type='group' ORDER BY name, type_id"
	);
	if (req.query.format == 'versions') {
		res.json(Object.fromEntries(rows.map(row => [row.type_id, Number(row.group_version)])));
		return;
	}
	res.json(rows.map(row => groupResponseFromRow(row, identity)));
}));

app.get('/groups/:groupID', asyncHandler(async (req, res) => {
	let identity = req.authUser;
	let row = await getLibraryRow('group', req.params.groupID, {
		create: false,
		user: identity
	});
	if (!row) {
		res.status(404).type('text/plain').send('Not found');
		return;
	}
	res.json(groupResponseFromRow(row, identity));
}));

app.get('/:libraryTypes(users|groups)/:libraryTypeID/deleted', asyncHandler(async (req, res) => {
	let library = await getLibraryRow(
		singularLibraryType(req.params.libraryTypes),
		req.params.libraryTypeID,
		{ user: req.authUser }
	);
	let since = parseInt(req.query.since || '0', 10);
	let deleted = {
		items: [],
		collections: [],
		searches: [],
		settings: []
	};
	let rows = await query(
		"SELECT object_type, key FROM deleted_objects "
			+ "WHERE library_id=$1 AND version>$2 ORDER BY version, key",
		[library.id, since]
	);
	for (let row of rows) {
		if (row.object_type == 'setting') {
			deleted.settings.push(row.key);
		}
		else {
			deleted[pluralByObjectType[row.object_type]].push(row.key);
		}
	}
	setLibraryVersion(res, library.version);
	res.json(deleted);
}));

app.get('/:libraryTypes(users|groups)/:libraryTypeID/settings', asyncHandler(async (req, res) => {
	let library = await getLibraryRow(
		singularLibraryType(req.params.libraryTypes),
		req.params.libraryTypeID,
		{ user: req.authUser }
	);
	let since = getSince(req);
	if (since !== null && library.version <= since) {
		setLibraryVersion(res, library.version);
		res.status(304).end();
		return;
	}
	let rows = await query(
		"SELECT key, version, value FROM settings WHERE library_id=$1 AND version>$2 ORDER BY key",
		[library.id, since || 0]
	);
	setLibraryVersion(res, library.version);
	res.json(Object.fromEntries(rows.map(row => [
		row.key,
		{ value: row.value, version: Number(row.version) }
	])));
}));

app.post('/:libraryTypes(users|groups)/:libraryTypeID/settings', asyncHandler(async (req, res) => {
	let result = await withLibraryWrite(req, res, async (client, library, newVersion) => {
		for (let [key, setting] of Object.entries(req.body || {})) {
			await client.query(
				"INSERT INTO settings (library_id, key, version, value, updated_at) "
					+ "VALUES ($1, $2, $3, $4, now()) "
					+ "ON CONFLICT (library_id, key) DO UPDATE "
					+ "SET version=EXCLUDED.version, value=EXCLUDED.value, updated_at=now()",
				[library.id, key, newVersion, setting.value]
			);
			await client.query(
				"DELETE FROM deleted_objects WHERE library_id=$1 AND object_type='setting' AND key=$2",
				[library.id, key]
			);
		}
		return null;
	});
	if (result) {
		res.status(result.status).end();
	}
}));

app.delete('/:libraryTypes(users|groups)/:libraryTypeID/settings', asyncHandler(async (req, res) => {
	let keys = csv(req.query.settingKey);
	let result = await withLibraryWrite(req, res, async (client, library, newVersion) => {
		for (let key of keys) {
			await client.query("DELETE FROM settings WHERE library_id=$1 AND key=$2", [library.id, key]);
			await upsertDeleted(client, library.id, 'setting', key, newVersion);
		}
		return null;
	});
	if (result) {
		res.status(result.status).end();
	}
}));

app.get('/:libraryTypes(users|groups)/:libraryTypeID/:target(items|collections|searches)/top', asyncHandler(getObjectList));
app.get('/:libraryTypes(users|groups)/:libraryTypeID/:target(items|collections|searches)', asyncHandler(getObjectList));

app.get('/:libraryTypes(users|groups)/:libraryTypeID/collections/:collectionKey/items/top', asyncHandler(getCollectionItems));
app.get('/:libraryTypes(users|groups)/:libraryTypeID/collections/:collectionKey/items', asyncHandler(getCollectionItems));

async function getCollectionItems(req, res) {
	let library = await getLibraryRow(
		singularLibraryType(req.params.libraryTypes),
		req.params.libraryTypeID,
		{ user: req.authUser }
	);
	let since = getSince(req);
	let keys = csv(req.query.itemKey);
	let scope = req.path.endsWith('/top') ? 'top' : null;
	if (since !== null && library.version <= since) {
		setLibraryVersion(res, library.version);
		res.status(304).end();
		return;
	}
	if (req.query.format == 'keys') {
		let rows = await collectionItemKeyRows(
			library.id,
			req.params.collectionKey,
			since || 0,
			scope,
			keys
		);
		setLibraryVersion(res, library.version);
		res.type('text/plain').send(rows.map(row => row.key).join('\n'));
		return;
	}
	if (req.query.format == 'versions') {
		let rows = await collectionItemVersionRows(
			library.id,
			req.params.collectionKey,
			since || 0,
			scope,
			keys
		);
		setLibraryVersion(res, library.version);
		res.json(Object.fromEntries(rows.map(row => [row.key, Number(row.version)])));
		return;
	}
	let rows = await collectionItemRows(library.id, req.params.collectionKey, since || 0, scope, keys);
	setLibraryVersion(res, library.version);
	res.json(rows.map(row => objectResponse(library, 'item', row)));
}

app.get('/:libraryTypes(users|groups)/:libraryTypeID/:target(items|collections|searches)/:keys', asyncHandler(async (req, res) => {
	let objectType = objectTypeByPlural[req.params.target];
	let library = await getLibraryRow(
		singularLibraryType(req.params.libraryTypes),
		req.params.libraryTypeID,
		{ user: req.authUser }
	);
	let keys = csv(req.params.keys);
	let rows = await objectRows(library.id, objectType, 0, null, keys);
	let byKey = new Map(rows.map(row => [row.key, row]));
	setLibraryVersion(res, library.version);
	res.json(keys.filter(key => byKey.has(key)).map(key => objectResponse(library, objectType, byKey.get(key))));
}));

app.post('/:libraryTypes(users|groups)/:libraryTypeID/:target(items|collections|searches)', uploadObjects);
app.patch('/:libraryTypes(users|groups)/:libraryTypeID/:target(items|collections|searches)', uploadObjects);

app.delete('/:libraryTypes(users|groups)/:libraryTypeID/:target(items|collections|searches)', asyncHandler(async (req, res) => {
	let objectType = objectTypeByPlural[req.params.target];
	let keys = csv(req.query[`${objectType}Key`]);
	let result = await withLibraryWrite(req, res, async (client, library, newVersion) => {
			for (let key of keys) {
				await client.query(
					"DELETE FROM objects WHERE library_id=$1 AND object_type=$2 AND key=$3",
					[library.id, objectType, key]
				);
				await upsertDeleted(client, library.id, objectType, key, newVersion);
			}
			if (objectType == 'item') {
				await pruneStorageFileLibraryReferences(client, library.id);
			}
			return null;
		});
	if (result) {
		res.status(result.status).end();
	}
}));

app.get('/:libraryTypes(users|groups)/:libraryTypeID/fulltext', asyncHandler(async (req, res) => {
	let library = await getLibraryRow(
		singularLibraryType(req.params.libraryTypes),
		req.params.libraryTypeID,
		{ user: req.authUser }
	);
	let since = getSince(req) || 0;
	let rows = await query(
		"SELECT key, version FROM fulltext_items "
			+ "WHERE library_id=$1 AND version>$2 ORDER BY key",
		[library.id, since]
	);
	setLibraryVersion(res, library.version);
	res.json(Object.fromEntries(rows.map(row => [row.key, Number(row.version)])));
}));

app.get('/:libraryTypes(users|groups)/:libraryTypeID/items/:itemKey/fulltext', asyncHandler(async (req, res) => {
	let library = await getLibraryRow(
		singularLibraryType(req.params.libraryTypes),
		req.params.libraryTypeID,
		{ user: req.authUser }
	);
	let rows = await query(
		"SELECT version, content, indexed_pages, total_pages, indexed_chars, total_chars "
			+ "FROM fulltext_items WHERE library_id=$1 AND key=$2",
		[library.id, req.params.itemKey]
	);
	let row = rows[0];
	if (!row) {
		res.status(404).type('text/plain').send('Not found');
		return;
	}
	setLibraryVersion(res, row.version);
	res.json({
		content: row.content,
		indexedPages: row.indexed_pages === null ? undefined : Number(row.indexed_pages),
		totalPages: row.total_pages === null ? undefined : Number(row.total_pages),
		indexedChars: row.indexed_chars === null ? undefined : Number(row.indexed_chars),
		totalChars: row.total_chars === null ? undefined : Number(row.total_chars)
	});
}));

app.post('/:libraryTypes(users|groups)/:libraryTypeID/fulltext', asyncHandler(async (req, res) => {
	let objects = Array.isArray(req.body) ? req.body : [];
	let result = await withLibraryWrite(req, res, async (client, library, newVersion) => {
		let successful = {};
		let success = {};
		let unchanged = {};
		let failed = {};
		for (let i = 0; i < objects.length; i++) {
			let object = objects[i];
			let key = object && object.key;
			if (!key) {
				failed[i] = { key: '', code: 400, message: 'Object key not provided' };
				continue;
			}
			if (typeof object.content != 'string') {
				failed[i] = { key, code: 400, message: "'content' must be a string" };
				continue;
			}
			let item = await client.query(
				"SELECT 1 FROM objects WHERE library_id=$1 AND object_type='item' "
					+ "AND key=$2 AND data->>'itemType'='attachment'",
				[library.id, key]
			);
			if (!item.rows[0]) {
				failed[i] = { key, code: 404, message: 'Not found' };
				continue;
			}
			await client.query(
				"INSERT INTO fulltext_items "
					+ "(library_id, key, version, content, indexed_pages, total_pages, "
					+ "indexed_chars, total_chars, updated_at) "
					+ "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now()) "
					+ "ON CONFLICT (library_id, key) DO UPDATE "
					+ "SET version=EXCLUDED.version, content=EXCLUDED.content, "
					+ "indexed_pages=EXCLUDED.indexed_pages, total_pages=EXCLUDED.total_pages, "
					+ "indexed_chars=EXCLUDED.indexed_chars, total_chars=EXCLUDED.total_chars, "
					+ "updated_at=now()",
				[
					library.id,
					key,
					newVersion,
					object.content,
					nullableInteger(object.indexedPages),
					nullableInteger(object.totalPages),
					nullableInteger(object.indexedChars),
					nullableInteger(object.totalChars)
				]
			);
			successful[i] = { key };
			success[i] = key;
		}
		return { successful, success, unchanged, failed };
	});
	if (result) {
		res.status(result.status).json(result.body);
	}
}));

async function getObjectList(req, res) {
	let objectType = objectTypeByPlural[req.params.target];
	let library = await getLibraryRow(
		singularLibraryType(req.params.libraryTypes),
		req.params.libraryTypeID,
		{ user: req.authUser }
	);
	let since = getSince(req);
	let keys = csv(req.query[`${objectType}Key`]);
	if (since !== null && library.version <= since) {
		setLibraryVersion(res, library.version);
		res.status(304).end();
		return;
	}
	let scope = req.path.endsWith('/top') ? 'top' : null;
	if (req.query.format == 'keys') {
		let rows = await objectKeyRows(library.id, objectType, since || 0, scope, keys);
		setLibraryVersion(res, library.version);
		res.type('text/plain').send(rows.map(row => row.key).join('\n'));
		return;
	}
	if (req.query.format == 'versions') {
		let rows = await objectVersionRows(library.id, objectType, since || 0, scope, keys);
		setLibraryVersion(res, library.version);
		res.json(Object.fromEntries(rows.map(row => [row.key, Number(row.version)])));
		return;
	}
	let rows = await objectRows(library.id, objectType, since || 0, scope, keys);
	setLibraryVersion(res, library.version);
	res.json(rows.map(row => objectResponse(library, objectType, row)));
}

async function uploadObjects(req, res) {
	let objectType = objectTypeByPlural[req.params.target];
	let objects = Array.isArray(req.body) ? req.body : [];
	let result = await withLibraryWrite(req, res, async (client, library, newVersion) => {
		let successful = {};
		let unchanged = {};
		let failed = {};
		for (let i = 0; i < objects.length; i++) {
			let object = objects[i];
			let key = object && object.key;
			if (!key) {
				failed[i] = { code: 400, message: 'Object key not provided' };
				continue;
			}
				let existing = await client.query(
					"SELECT object_id, version, data FROM objects WHERE library_id=$1 AND object_type=$2 AND key=$3",
					[library.id, objectType, key]
				);
			let existingRow = existing.rows[0];
			if (existingRow && object.version && Number(object.version) < Number(existingRow.version)) {
				failed[i] = {
					code: 412,
					message: `${objectType} ${key} has changed on the PostgreSQL metadata backend`,
					data: canonicalizeObjectData(objectType, existingRow.data)
				};
				continue;
			}
			let shouldMerge = existingRow
				&& (req.method == 'PATCH' || isPartialItemUpdate(objectType, object));
			let data = shouldMerge
				? Object.assign({}, existingRow.data, object)
				: Object.assign({}, object);
			if (objectType == 'item' && !data.itemType) {
				failed[i] = { code: 400, message: 'itemType property not provided' };
				continue;
			}
			data.key = key;
			data.version = newVersion;
				let insert = await client.query(
					"INSERT INTO objects (library_id, object_type, key, version, data, updated_at) "
						+ "VALUES ($1, $2, $3, $4, $5, now()) "
						+ "ON CONFLICT (library_id, object_type, key) DO UPDATE "
						+ "SET version=EXCLUDED.version, data=EXCLUDED.data, updated_at=now() "
						+ "RETURNING object_id",
					[library.id, objectType, key, newVersion, data]
				);
				if (objectType == 'item') {
					await syncAttachmentStorageMapping(client, library.id, insert.rows[0].object_id, data);
				}
			await client.query(
				"DELETE FROM deleted_objects WHERE library_id=$1 AND object_type=$2 AND key=$3",
				[library.id, objectType, key]
				);
				successful[i] = objectResponse(library, objectType, { key, version: newVersion, data });
			}
			if (objectType == 'item') {
				await pruneStorageFileLibraryReferences(client, library.id);
			}
			return { successful, unchanged, failed };
		});
	if (result) {
		res.status(result.status).json(result.body);
	}
}

async function withLibraryWrite(req, res, callback) {
	let client = await pool.connect();
	try {
		await client.query('BEGIN');
		let library = await getLibraryRow(
			singularLibraryType(req.params.libraryTypes),
			req.params.libraryTypeID,
			{ client, lock: true, user: req.authUser }
		);
		let expectedVersion = parseInt(req.get('If-Unmodified-Since-Version') || '-1', 10);
		if (expectedVersion >= 0 && Number(library.version) != expectedVersion) {
			await client.query('ROLLBACK');
			setLibraryVersion(res, library.version);
			return { status: 412, body: { code: 412, message: 'Library has changed' } };
		}
		let newVersion = Number(library.version) + 1;
		let body = await callback(client, library, newVersion);
		await client.query(
			"UPDATE libraries SET version=$1, updated_at=now() WHERE id=$2",
			[newVersion, library.id]
		);
		await client.query('COMMIT');
		library.version = newVersion;
		setLibraryVersion(res, newVersion);
		return { status: body ? 200 : 204, body };
	}
	catch (e) {
		await client.query('ROLLBACK');
		throw e;
	}
	finally {
		client.release();
	}
}

async function getLibraryRow(type, typeID, options = {}) {
	let client = options.client || pool;
	typeID = parseInt(typeID, 10);
	let identity = options.user || await getAccountIdentity(client);
	if (type == 'user' && typeID != identity.userID) {
		return null;
	}
	let result = await client.query(
		`SELECT * FROM libraries WHERE type=$1 AND type_id=$2 ${options.lock ? 'FOR UPDATE' : ''}`,
		[type, typeID]
	);
	if (result.rows[0]) {
		return result.rows[0];
	}
	if (options.create === false) {
		return null;
	}
	let name = type == 'user' ? identity.username : `Group ${typeID}`;
	let metadata = type == 'user' ? {} : defaultGroupMetadata(typeID, name, identity);
	result = await client.query(
		"INSERT INTO libraries (type, type_id, name, metadata) VALUES ($1, $2, $3, $4) "
			+ "ON CONFLICT (type, type_id) DO UPDATE SET name=EXCLUDED.name "
			+ "RETURNING *",
		[type, typeID, name, metadata]
	);
	return result.rows[0];
}

async function getAuthenticatedUserForToken(token) {
	let tokenHash = hashAPIToken(token);
	let result = await pool.query(
		"SELECT users.id, users.zotero_user_id, users.username, users.display_name, "
			+ "users.emails, users.password_hash "
			+ "FROM auth_tokens "
			+ "JOIN users ON users.id=auth_tokens.user_id "
			+ "WHERE auth_tokens.token_hash=$1 "
			+ "AND (auth_tokens.expires_at IS NULL OR auth_tokens.expires_at > now())",
		[tokenHash]
	);
	let row = result.rows[0];
	if (!row) {
		return null;
	}
	await pool.query(
		"UPDATE auth_tokens SET last_used_at=now() WHERE token_hash=$1",
		[tokenHash]
	);
	return userFromRow(row);
}

async function getUserByUsername(username, client = pool) {
	let result = await client.query(
		"SELECT id, zotero_user_id, username, display_name, emails, password_hash "
			+ "FROM users WHERE lower(username)=lower($1)",
		[username]
	);
	return result.rows[0] ? userFromRow(result.rows[0]) : null;
}

async function issueAuthToken(userID) {
	let token = `zps_${crypto.randomBytes(32).toString('base64url')}`;
	await pool.query(
		"INSERT INTO auth_tokens (user_id, token_hash, created_at) VALUES ($1, $2, now())",
		[userID, hashAPIToken(token)]
	);
	return token;
}

function hashAPIToken(token) {
	return crypto.createHash('sha256').update(`${token || ''}`).digest('hex');
}

function userFromRow(row) {
	return {
		id: Number(row.id),
		userID: Number(row.zotero_user_id),
		username: row.username,
		displayName: row.display_name || row.username,
		emails: Array.isArray(row.emails) ? row.emails : [],
		passwordHash: row.password_hash || null
	};
}

async function getAccountIdentity(client = pool) {
	try {
		let result = await client.query(
			"SELECT id, zotero_user_id, username, display_name, emails, password_hash "
				+ "FROM users ORDER BY id LIMIT 1"
		);
		let row = result.rows[0];
		if (row) {
			return userFromRow(row);
		}
	}
	catch (e) {
		if (e.code != '42P01') {
			throw e;
		}
	}
	try {
		let result = await client.query(
			"SELECT user_id, username, display_name, emails, password_hash "
				+ "FROM account_identity WHERE id=1"
		);
		let row = result.rows[0];
		if (row) {
			return {
				id: null,
				userID: Number(row.user_id),
				username: row.username,
				displayName: row.display_name || row.username,
				emails: Array.isArray(row.emails) ? row.emails : [],
				passwordHash: row.password_hash || null
			};
		}
	}
	catch (e) {
		if (e.code != '42P01') {
			throw e;
		}
	}
	return {
		id: null,
		userID: USER_ID,
		username: USERNAME,
		displayName: DISPLAY_NAME,
		emails: [],
		passwordHash: null
	};
}

async function getSyncSettings(userID = null) {
	try {
		let result = userID
			? await pool.query(
				"SELECT data, updated_at FROM user_sync_settings WHERE user_id=$1",
				[userID]
			)
			: await pool.query(
				"SELECT data, updated_at FROM sync_settings WHERE id=1"
			);
		let row = result.rows[0];
		if (row) {
			return Object.assign(defaultSyncSettings(), row.data || {}, {
				updatedAt: row.updated_at
			});
		}
	}
	catch (e) {
		if (e.code != '42P01') {
			throw e;
		}
	}
	return defaultSyncSettings();
}

function defaultSyncSettings() {
	return {
		version: 1,
		metadata: {
			backend: 'postgresql'
		}
	};
}

async function verifyPassword(password, identity) {
	if (identity.passwordHash) {
		return verifyPasswordHash(password, identity.passwordHash);
	}
	return false;
}

function verifyPasswordHash(password, passwordHash) {
	let parts = `${passwordHash || ''}`.split('$');
	if (parts.length != 4 || parts[0] != 'pbkdf2_sha256') {
		return false;
	}
	let iterations = parseInt(parts[1], 10);
	let salt = parts[2];
	let expected = parts[3];
	if (!iterations || !salt || !expected) {
		return false;
	}
	let actual = crypto.pbkdf2Sync(password, salt, iterations, 32, 'sha256').toString('hex');
	return timingSafeStringEqual(actual, expected);
}

function hashPassword(password) {
	let iterations = 100000;
	let salt = crypto.randomBytes(16).toString('hex');
	let hash = crypto.pbkdf2Sync(password, salt, iterations, 32, 'sha256').toString('hex');
	return `pbkdf2_sha256$${iterations}$${salt}$${hash}`;
}

function timingSafeStringEqual(a, b) {
	a = `${a || ''}`;
	b = `${b || ''}`;
	let aBuffer = Buffer.from(a);
	let bBuffer = Buffer.from(b);
	if (aBuffer.length != bBuffer.length) {
		return false;
	}
	return crypto.timingSafeEqual(aBuffer, bBuffer);
}

async function objectRows(libraryID, objectType, since, scope, keys = []) {
	let where = "o.library_id=$1 AND o.object_type=$2 AND o.version>$3";
	let params = [libraryID, objectType, since || 0];
	if (scope == 'top' && objectType == 'item') {
		where += " AND NOT (o.data ? 'parentItem')";
	}
	if (keys.length) {
		params.push(keys);
		where += ` AND o.key = ANY($${params.length}::text[])`;
	}
	let select = "o.key, o.version, o.data";
	if (objectType == 'item') {
		select += ", (SELECT COUNT(*) FROM objects child "
			+ "WHERE child.library_id=o.library_id "
			+ "AND child.object_type='item' "
			+ "AND child.data->>'parentItem'=o.key) AS num_children";
	}
	return query(
		`SELECT ${select} FROM objects o WHERE ${where} ORDER BY o.key`,
		params
	);
}

async function objectKeyRows(libraryID, objectType, since, scope, keys = []) {
	let { where, params } = objectListWhere(libraryID, objectType, since, scope, keys);
	return query(`SELECT o.key FROM objects o WHERE ${where} ORDER BY o.key`, params);
}

async function objectVersionRows(libraryID, objectType, since, scope, keys = []) {
	let { where, params } = objectListWhere(libraryID, objectType, since, scope, keys);
	return query(`SELECT o.key, o.version FROM objects o WHERE ${where} ORDER BY o.key`, params);
}

function objectListWhere(libraryID, objectType, since, scope, keys = []) {
	let where = "o.library_id=$1 AND o.object_type=$2 AND o.version>$3";
	let params = [libraryID, objectType, since || 0];
	if (scope == 'top' && objectType == 'item') {
		where += " AND NOT (o.data ? 'parentItem')";
	}
	if (keys.length) {
		params.push(keys);
		where += ` AND o.key = ANY($${params.length}::text[])`;
	}
	return { where, params };
}

async function collectionItemRows(libraryID, collectionKey, since, scope, keys = []) {
	let { where, params } = collectionItemWhere(libraryID, collectionKey, since, scope, keys);
	let select = "o.key, o.version, o.data, "
		+ "(SELECT COUNT(*) FROM objects child "
		+ "WHERE child.library_id=o.library_id "
		+ "AND child.object_type='item' "
		+ "AND child.data->>'parentItem'=o.key) AS num_children";
	return query(`SELECT ${select} FROM objects o WHERE ${where} ORDER BY o.key`, params);
}

async function collectionItemKeyRows(libraryID, collectionKey, since, scope, keys = []) {
	let { where, params } = collectionItemWhere(libraryID, collectionKey, since, scope, keys);
	return query(`SELECT o.key FROM objects o WHERE ${where} ORDER BY o.key`, params);
}

async function collectionItemVersionRows(libraryID, collectionKey, since, scope, keys = []) {
	let { where, params } = collectionItemWhere(libraryID, collectionKey, since, scope, keys);
	return query(`SELECT o.key, o.version FROM objects o WHERE ${where} ORDER BY o.key`, params);
}

function collectionItemWhere(libraryID, collectionKey, since, scope, keys = []) {
	let where = "o.library_id=$1 AND o.object_type=$2 AND o.version>$3 "
		+ "AND COALESCE(o.data->'collections', '[]'::jsonb) @> $4::jsonb";
	let params = [libraryID, 'item', since || 0, JSON.stringify([collectionKey])];
	if (scope == 'top') {
		where += " AND NOT (o.data ? 'parentItem')";
	}
	if (keys.length) {
		params.push(keys);
		where += ` AND o.key = ANY($${params.length}::text[])`;
	}
	return { where, params };
}

async function upsertDeleted(client, libraryID, objectType, key, version) {
	await client.query(
		"INSERT INTO deleted_objects (library_id, object_type, key, version, deleted_at) "
			+ "VALUES ($1, $2, $3, $4, now()) "
			+ "ON CONFLICT (library_id, object_type, key) DO UPDATE "
			+ "SET version=EXCLUDED.version, deleted_at=now()",
		[libraryID, objectType, key, version]
	);
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

function isPartialItemUpdate(objectType, data) {
	if (objectType != 'item' || !data) {
		return false;
	}
	if (data.itemType) {
		return false;
	}
	let keys = Object.keys(data).filter(key => key != 'key' && key != 'version');
	return keys.length > 0;
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

function nullableInteger(value) {
	if (value === undefined || value === null || value === '') {
		return null;
	}
	let parsed = Number(value);
	return Number.isFinite(parsed) ? Math.round(parsed) : null;
}

function objectResponse(library, objectType, row) {
	let data = canonicalizeObjectData(
		objectType,
		Object.assign({}, row.data, {
			key: row.key,
			version: Number(row.version)
		})
	);
	return {
		key: row.key,
		version: Number(row.version),
		library: libraryResponse(library),
		links: {},
		meta: objectType == 'item' ? { numChildren: Number(row.num_children || 0) } : {},
		data
	};
}

function canonicalizeObjectData(objectType, data) {
	if (objectType != 'item' || !data || typeof data != 'object' || Array.isArray(data)) {
		return data;
	}

	let ordered = {};
	for (let field of canonicalItemFieldOrder) {
		if (Object.prototype.hasOwnProperty.call(data, field)) {
			ordered[field] = data[field];
		}
	}
	for (let [field, value] of Object.entries(data)) {
		if (!Object.prototype.hasOwnProperty.call(ordered, field)) {
			ordered[field] = value;
		}
	}
	return ordered;
}

function groupResponseFromRow(row, identity) {
	return {
		id: Number(row.type_id),
		version: Number(row.group_version),
		data: Object.assign(defaultGroupMetadata(row.type_id, row.name, identity), row.metadata || {})
	};
}

function defaultGroupMetadata(groupID, name, identity = null) {
	identity ||= {
		userID: USER_ID,
		username: USERNAME,
		displayName: DISPLAY_NAME
	};
	return {
		id: Number(groupID),
		name,
		owner: identity.userID,
		type: 'Private',
		editable: true,
		filesEditable: true,
		members: [
			{
				id: identity.userID,
				username: identity.username,
				name: identity.displayName,
				role: 'owner'
			}
		]
	};
}

function libraryResponse(library) {
	let response = {
		type: library.type,
		id: Number(library.type_id),
		name: library.name
	};
	if (library.type == 'group') {
		response.groupID = Number(library.type_id);
	}
	return response;
}

function setLibraryVersion(res, version) {
	res.set('Last-Modified-Version', String(version));
}

function getSince(req) {
	let since = req.query.since || req.get('If-Modified-Since-Version');
	return since === undefined ? null : parseInt(since || '0', 10);
}

function singularLibraryType(plural) {
	return plural == 'users' ? 'user' : 'group';
}

function csv(value) {
	if (!value) {
		return [];
	}
	return `${value}`.split(',').map(x => x.trim()).filter(Boolean);
}

async function query(sql, params = []) {
	let result = await pool.query(sql, params);
	return result.rows;
}

async function ensureRuntimeSchema() {
	await pool.query(
		"CREATE TABLE IF NOT EXISTS users ("
			+ "id BIGSERIAL PRIMARY KEY, "
			+ "zotero_user_id BIGINT NOT NULL UNIQUE, "
			+ "username TEXT NOT NULL UNIQUE, "
			+ "display_name TEXT NOT NULL DEFAULT '', "
			+ "emails JSONB NOT NULL DEFAULT '[]'::jsonb, "
			+ "password_hash TEXT NULL, "
			+ "created_at TIMESTAMPTZ NOT NULL DEFAULT now(), "
			+ "updated_at TIMESTAMPTZ NOT NULL DEFAULT now()"
			+ ")"
	);
	await pool.query(
		"CREATE TABLE IF NOT EXISTS auth_tokens ("
			+ "token_id BIGSERIAL PRIMARY KEY, "
			+ "user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE, "
			+ "token_hash TEXT NOT NULL UNIQUE, "
			+ "created_at TIMESTAMPTZ NOT NULL DEFAULT now(), "
			+ "last_used_at TIMESTAMPTZ NULL, "
			+ "expires_at TIMESTAMPTZ NULL"
			+ ")"
	);
	await pool.query(
		"CREATE INDEX IF NOT EXISTS auth_tokens_user ON auth_tokens (user_id)"
	);
	try {
		await pool.query(
			"ALTER TABLE account_identity ADD COLUMN IF NOT EXISTS password_hash TEXT NULL"
		);
		await pool.query(
			"INSERT INTO users "
				+ "(zotero_user_id, username, display_name, emails, password_hash, updated_at) "
				+ "SELECT user_id, username, display_name, emails, password_hash, updated_at "
				+ "FROM account_identity WHERE id=1 "
				+ "ON CONFLICT (zotero_user_id) DO UPDATE "
				+ "SET username=EXCLUDED.username, display_name=EXCLUDED.display_name, "
				+ "emails=EXCLUDED.emails, "
				+ "password_hash=COALESCE(users.password_hash, EXCLUDED.password_hash), "
				+ "updated_at=now()"
		);
	}
	catch (e) {
		if (e.code != '42P01') {
			throw e;
		}
	}
	if (LEGACY_API_KEY) {
		let identity = await getAccountIdentity();
		if (identity.id) {
			await pool.query(
				"INSERT INTO auth_tokens (user_id, token_hash, created_at) "
					+ "VALUES ($1, $2, now()) ON CONFLICT (token_hash) DO NOTHING",
				[identity.id, hashAPIToken(LEGACY_API_KEY)]
			);
		}
	}
	await pool.query(
		"CREATE TABLE IF NOT EXISTS sync_settings ("
			+ "id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1), "
			+ "data JSONB NOT NULL DEFAULT '{}'::jsonb, "
			+ "updated_at TIMESTAMPTZ NOT NULL DEFAULT now()"
			+ ")"
	);
	await pool.query(
		"CREATE TABLE IF NOT EXISTS user_sync_settings ("
			+ "user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, "
			+ "data JSONB NOT NULL DEFAULT '{}'::jsonb, "
			+ "updated_at TIMESTAMPTZ NOT NULL DEFAULT now()"
			+ ")"
	);
	try {
		await pool.query(
			"INSERT INTO user_sync_settings (user_id, data, updated_at) "
				+ "SELECT users.id, sync_settings.data, sync_settings.updated_at "
				+ "FROM sync_settings "
				+ "JOIN account_identity ON account_identity.id=1 "
				+ "JOIN users ON users.zotero_user_id=account_identity.user_id "
				+ "WHERE sync_settings.id=1 "
				+ "ON CONFLICT (user_id) DO NOTHING"
		);
	}
	catch (e) {
		if (e.code != '42P01') {
			throw e;
		}
	}
	await pool.query(
		"CREATE TABLE IF NOT EXISTS fulltext_items ("
			+ "library_id BIGINT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE, "
			+ "key TEXT NOT NULL, "
			+ "version BIGINT NOT NULL, "
			+ "content TEXT NOT NULL DEFAULT '', "
			+ "indexed_pages BIGINT NULL, "
			+ "total_pages BIGINT NULL, "
			+ "indexed_chars BIGINT NULL, "
			+ "total_chars BIGINT NULL, "
			+ "updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), "
			+ "PRIMARY KEY (library_id, key)"
			+ ")"
	);
	await pool.query(
		"CREATE INDEX IF NOT EXISTS fulltext_items_library_version "
			+ "ON fulltext_items (library_id, version)"
	);
}

function asyncHandler(fn) {
	return function (req, res, next) {
		Promise.resolve(fn(req, res, next)).catch(next);
	};
}

app.use((err, _req, res, _next) => {
	console.error(err);
	res.status(500).json({ error: 'internal_error', message: err.message });
});

app.use((_req, res) => {
	res.status(404).json({ error: 'not_found' });
});

await ensureRuntimeSchema();

app.listen(PORT, () => {
	console.log(`Zotero PostgreSQL sync server listening on port ${PORT}`);
});
