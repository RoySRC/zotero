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
});
