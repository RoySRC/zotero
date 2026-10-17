import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import net from 'node:net';
import test from 'node:test';
import pg from 'pg';

test('bulk sync object updates', {
	skip: !process.env.TEST_DATABASE_URL,
	timeout: 60000
}, async (t) => {
	// Create a separate database so these tests never alter the supplied database.
	const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
	const databaseName = `zotero_test_${randomBytes(8).toString('hex')}`;
	let databaseCreated = false;
	let pool;
	let child;
	t.after(async () => {
		if (child && child.exitCode === null && child.signalCode === null) {
			const exited = once(child, 'exit');
			child.kill('SIGTERM');
			const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
			await exited;
			clearTimeout(timer);
		}
		await pool?.end();
		try {
			if (databaseCreated) {
				await admin.query(`DROP DATABASE ${databaseName} WITH (FORCE)`);
			}
		}
		finally {
			await admin.end();
		}
	});
	await admin.query(`CREATE DATABASE ${databaseName}`);
	databaseCreated = true;
	const databaseURL = new URL(process.env.TEST_DATABASE_URL);
	databaseURL.pathname = `/${databaseName}`;
	pool = new pg.Pool({ connectionString: databaseURL.href });
	await pool.query(await readFile(new URL('../schema.sql', import.meta.url), 'utf8'));
	const token = randomBytes(32).toString('hex');
	await pool.query("INSERT INTO users (id, zotero_user_id, username) VALUES (1, 1234, 'sync-test')");
	await pool.query("SELECT setval(pg_get_serial_sequence('users', 'id'), 1)");
	await pool.query('INSERT INTO auth_tokens (user_id, token_hash) VALUES (1, $1)', [
		createHash('sha256').update(token).digest('hex')
	]);
	await pool.query(
		"INSERT INTO libraries (type, type_id, name, metadata) VALUES ('group', 1234, 'Test Group', $1)",
		[{ owner: 1234, members: [1234] }]
	);
	const listener = net.createServer();
	listener.listen(0, '127.0.0.1');
	await once(listener, 'listening');
	const port = listener.address().port;
	await new Promise(resolve => listener.close(resolve));
	const serverPath = process.env.TEST_SERVER_PATH || new URL('../src/server.mjs', import.meta.url).pathname;
	child = spawn(process.execPath, [serverPath], {
		env: {
			...process.env,
			DATABASE_URL: databaseURL.href,
			PORT: `${port}`,
			ZOTERO_SYNC_API_KEY: '',
			RECOGNITION_SERVICE_URL: '',
			RECOGNITION_SERVICE_KEY_FILE: '',
			WEBDAV_GROUP_PASSWD_PATH: '',
			WEBDAV_GROUP_PASSWD_SSH_HOST: ''
		},
		stdio: ['ignore', 'pipe', 'pipe']
	});
	await new Promise((resolve, reject) => {
		let output = '';
		const timer = setTimeout(() => reject(new Error(`Server did not start: ${output}`)), 10000);
		child.once('error', reject);
		child.once('exit', code => {
			clearTimeout(timer);
			reject(new Error(`Server exited with ${code}: ${output}`));
		});
		child.stderr.on('data', chunk => { output += chunk; });
		child.stdout.on('data', chunk => {
			output += chunk;
			if (output.includes('listening on port')) {
				clearTimeout(timer);
				resolve();
			}
		});
	});
	const baseURL = `http://127.0.0.1:${port}/groups/1234`;
	await t.test('recognition uses the real database-backed token middleware', async () => {
		let url = `http://127.0.0.1:${port}/recognizer/`;
		assert.equal((await fetch(url + 'health')).status, 403);
		assert.equal((await fetch(url + 'health', { headers: { 'Zotero-API-Key': 'invalid' } })).status, 403);
		let health = await fetch(url + 'health', { headers: { 'Zotero-API-Key': token } });
		assert.equal(health.status, 503);
		assert.equal((await health.json()).error, 'recognition_service_not_configured');
		let result = await fetch(url + 'recognize', {
			method: 'POST',
			headers: { 'Zotero-API-Key': token, 'Content-Type': 'application/json' },
			body: JSON.stringify({ metadata: { DOI: '10.1234/test' }, totalPages: 1, pages: [] })
		});
		assert.equal(result.status, 503);
	});
	async function write(target, data, method = 'POST') {
		const response = await fetch(`${baseURL}/${target}`, {
			method,
			headers: { 'Content-Type': 'application/json', 'Zotero-API-Key': token },
			body: JSON.stringify([data])
		});
		assert.equal(response.status, 200);
		return response.json();
	}
	async function read(target, key) {
		const objectType = { items: 'item', collections: 'collection', searches: 'search' }[target];
		const response = await fetch(`${baseURL}/${target}?${objectType}Key=${key}`, {
			headers: { 'Zotero-API-Key': token }
		});
		assert.equal(response.status, 200);
		const objects = await response.json();
		assert.equal(objects.length, 1);
		return objects[0].data;
	}
	async function save(target, data, method) {
		const result = await write(target, data, method);
		assert.deepEqual(result.failed, {});
		const saved = result.successful[0].data;
		assert.deepEqual(await read(target, data.key), saved);
		return saved;
	}
	let collection;
	const relations = { 'owl:sameAs': 'https://example.org/collection' };
	await t.test('per-user authentication, settings and password rotation survive upgrades', async () => {
		const serverURL = `http://127.0.0.1:${port}`;
		const password = randomBytes(24).toString('hex');
		const newPassword = randomBytes(24).toString('hex');
		const username = `branding-${randomBytes(6).toString('hex')}`;
		async function auth(endpoint, body, expected) {
			const response = await fetch(`${serverURL}/auth/${endpoint}`, {
				method: 'POST', headers: {
					'Content-Type': 'application/json',
					...(endpoint === 'register' ? { 'Zotero-API-Key': token } : {})
				}, body: JSON.stringify(body)
			});
			assert.equal(response.status, expected);
			return response.json();
		}
		const account = await auth('register', { username, password }, 201);
		await auth('login', { username, password: `${password}-wrong` }, 403);
		const loggedIn = await auth('login', { username, password }, 200);
		assert.equal(loggedIn.userID, account.userID);
		const headers = { 'Zotero-API-Key': loggedIn.apiKey, 'Content-Type': 'application/json' };
		const settings = { webdavProfiles: { test: { url: 'https://example.invalid/webdav', username: 'test' } } };
		assert.equal((await fetch(`${serverURL}/sync/settings`, {
			method: 'PUT', headers, body: JSON.stringify(settings)
		})).status, 204);
		const reloaded = await auth('login', { username, password }, 200);
		assert.deepEqual(reloaded.syncSettings.webdavProfiles, settings.webdavProfiles);
		assert.equal(reloaded.syncSettings.metadata.backend, 'postgresql');
		const identity = await fetch(`${serverURL}/keys/current`, { headers });
		assert.equal((await identity.json()).userID, account.userID);
		const otherSettings = await fetch(`${serverURL}/sync/settings`, { headers: { 'Zotero-API-Key': token } });
		assert.equal((await otherSettings.json()).webdavProfiles, undefined, 'Settings must remain per-user');
		await auth('password', { username, oldPassword: 'incorrect', newPassword }, 403);
		await auth('password', { username, oldPassword: password, newPassword }, 200);
		await auth('login', { username, password }, 403);
		await auth('login', { username, password: newPassword }, 200);
		assert.equal((await fetch(`${serverURL}/keys/current`, { headers })).status, 403,
			'Changing the password must revoke old tokens');
	});
	await t.test('trash and restore POST patches preserve collection metadata', async () => {
		await save('collections', { key: 'PARENT01', name: 'Parent', parentCollection: false, relations: {} });
		collection = await save('collections', {
			key: 'COLLECT1', name: 'Original', parentCollection: 'PARENT01', relations
		});
		collection = await save('collections', { key: collection.key, version: collection.version, deleted: true });
		assert.equal(collection.name, 'Original');
		assert.equal(collection.parentCollection, 'PARENT01');
		assert.deepEqual(collection.relations, relations);
		assert.equal(collection.deleted, true);
		collection = await save('collections', { key: collection.key, version: collection.version, deleted: false });
		assert.equal(collection.deleted, false);
		assert.equal(collection.name, 'Original');
	});
	await t.test('rename POST preserves parent and relations; PATCH can clear them explicitly', async () => {
		collection = await save('collections', { key: collection.key, version: collection.version, name: 'Renamed' });
		assert.equal(collection.name, 'Renamed');
		assert.equal(collection.parentCollection, 'PARENT01');
		assert.deepEqual(collection.relations, relations);
		collection = await save('collections', {
			key: collection.key, version: collection.version, parentCollection: false, relations: {}
		}, 'PATCH');
		assert.equal(collection.name, 'Renamed');
		assert.equal(collection.parentCollection, false);
		assert.deepEqual(collection.relations, {});
	});
	await t.test('stale retries cannot overwrite or duplicate the collection', async () => {
		const staleVersion = collection.version;
		collection = await save('collections', { key: collection.key, version: staleVersion, deleted: true });
		const result = await write('collections', { key: collection.key, version: staleVersion, deleted: true });
		assert.equal(result.failed[0].code, 412);
		assert.deepEqual(await read('collections', collection.key), collection);
	});
	await t.test('invalid collection names cannot create or overwrite records', async () => {
		for (const name of [undefined, '', null, 123]) {
			const result = await write('collections', { key: 'INVALID1', name, deleted: true });
			assert.equal(result.failed[0].code, 400);
		}
		const result = await write('collections', { key: collection.key, version: collection.version, name: '' });
		assert.equal(result.failed[0].code, 400);
		assert.deepEqual(await read('collections', collection.key), collection);
		const count = await pool.query("SELECT count(*) FROM objects WHERE key='INVALID1'");
		assert.equal(Number(count.rows[0].count), 0);
	});
	await t.test('saved search patches preserve names and conditions', async () => {
		const conditions = [{ condition: 'title', operator: 'contains', value: 'test' }];
		let search = await save('searches', { key: 'SEARCH01', name: 'Search', conditions });
		search = await save('searches', { key: search.key, version: search.version, name: 'Renamed search' });
		assert.deepEqual(search.conditions, conditions);
		search = await save('searches', { key: search.key, version: search.version, deleted: true });
		assert.equal(search.name, 'Renamed search');
		assert.deepEqual(search.conditions, conditions);
		const invalid = await write('searches', { key: 'INVALID2', name: 'Invalid search' });
		assert.equal(invalid.failed[0].code, 400);
	});
	await t.test('item patches continue to preserve required fields', async () => {
		let item = await save('items', { key: 'ITEM0001', itemType: 'book', title: 'Book' });
		item = await save('items', { key: item.key, version: item.version, title: 'Renamed book' });
		assert.equal(item.itemType, 'book');
		assert.equal(item.title, 'Renamed book');
	});
	await t.test('recognition parenting removes inherited child collections but preserves parent membership', async () => {
		let parent = await save('items', { key: 'PAPER001', itemType: 'preprint', title: 'Paper', collections: ['COLLECT1'] });
		let child = await save('items', { key: 'PDF00001', itemType: 'attachment', title: 'PDF',
			linkMode: 'imported_file', filename: 'paper.pdf', collections: ['COLLECT1'] });
		child = await save('items', { key: child.key, version: child.version, parentItem: parent.key });
		assert.equal(child.parentItem, parent.key);
		assert.equal(child.filename, 'paper.pdf');
		assert.equal(child.collections, undefined);
		assert.deepEqual((await read('items', parent.key)).collections, ['COLLECT1']);
		let stored = await pool.query("SELECT data FROM objects WHERE object_type='item' AND key='PDF00001'");
		assert.equal(stored.rows[0].data.collections, undefined);
		// Undo recognition must also work: detach and explicitly restore membership.
		child = await save('items', { key: child.key, version: child.version, parentItem: false,
			collections: ['COLLECT1'] }, 'PATCH');
		assert.equal(child.parentItem, undefined);
		assert.deepEqual(child.collections, ['COLLECT1']);
		let top = await fetch(baseURL + '/items/top?format=keys', { headers: { 'Zotero-API-Key': token } });
		assert.ok((await top.text()).split('\n').includes(child.key));
	});
	await t.test('legacy invalid child collections are removed from reads and conflict echoes', async () => {
		let child = await save('items', { key: 'NOTE0001', itemType: 'note', note: 'Note', parentItem: 'PAPER001' });
		await pool.query("UPDATE objects SET data=data || $1::jsonb WHERE object_type='item' AND key=$2",
			[{ collections: ['COLLECT1'] }, child.key]);
		assert.equal((await read('items', child.key)).collections, undefined);
		let conflict = await write('items', { key: child.key, version: child.version - 1, note: 'Stale' });
		assert.equal(conflict.failed[0].code, 412);
		assert.equal(conflict.failed[0].data.collections, undefined);
		child = await save('items', { key: child.key, version: child.version, note: 'Updated' });
		assert.equal(child.collections, undefined);
		assert.equal(child.parentItem, 'PAPER001');
	});
});
