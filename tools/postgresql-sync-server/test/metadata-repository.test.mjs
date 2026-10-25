import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import net from 'node:net';
import pg from 'pg';

test('vendored repository build has matching integrity hashes', async () => {
	const root = new URL('../vendor/recognition-repository/', import.meta.url);
	const manifest = JSON.parse(await readFile(new URL('manifest.json', root)));
	assert.equal(manifest.schema, 1);
	assert.match(manifest.sourceDigest, /^[a-f0-9]{64}$/);
	for (const [name, expected] of Object.entries(manifest.files)) {
		assert.equal(createHash('sha256').update(await readFile(new URL(name, root))).digest('hex'), expected);
	}
});

/** Real account tokens, HTTP routes and PostgreSQL, isolated from all user data. */
test('two accounts exchange metadata through the real sync server', {
	skip: !process.env.TEST_DATABASE_URL, timeout: 60000
}, async t => {
	const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
	const name = 'repository_api_' + randomBytes(8).toString('hex');
	let pool, child, created = false;
	t.after(async () => {
		if (child && child.exitCode === null && child.signalCode === null) {
			const done = once(child, 'exit'); child.kill();
			const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
			await done; clearTimeout(timer);
		}
		await pool?.end();
		if (created) await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
		await admin.end();
	});
	await admin.query(`CREATE DATABASE ${name}`); created = true;
	const url = new URL(process.env.TEST_DATABASE_URL); url.pathname = '/' + name;
	pool = new pg.Pool({ connectionString: url.href });
	await pool.query(await readFile(new URL('../schema.sql', import.meta.url), 'utf8'));
	const tokens = [randomBytes(32).toString('hex'), randomBytes(32).toString('hex')];
	for (let i = 0; i < 2; i++) {
		await pool.query('INSERT INTO users(id,zotero_user_id,username) VALUES($1,$2,$3)', [i + 1, i + 100, 'repository-user-' + i]);
		await pool.query('INSERT INTO auth_tokens(user_id,token_hash) VALUES($1,$2)', [i + 1, createHash('sha256').update(tokens[i]).digest('hex')]);
	}
	const listener = net.createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
	const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
	child = spawn(process.execPath, [new URL('../src/server.mjs', import.meta.url).pathname], {
		env: { ...process.env, DATABASE_URL: url.href, PORT: String(port), ZOTERO_SYNC_API_KEY: '',
			RECOGNITION_SERVICE_URL: '', RECOGNITION_SERVICE_KEY_FILE: '',
			WEBDAV_GROUP_PASSWD_PATH: '', WEBDAV_GROUP_PASSWD_SSH_HOST: '' }, stdio: ['ignore', 'pipe', 'pipe']
	});
	let logs = '';
	await new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('Test server failed to start: ' + logs)), 10000);
		child.once('error', reject);
		child.once('exit', code => { clearTimeout(timer); reject(new Error('Test server exited: ' + code + ' ' + logs)); });
		child.stderr.on('data', data => { logs += data; });
		child.stdout.on('data', data => { logs += data; if (logs.includes('listening on port')) { clearTimeout(timer); resolve(); } });
	});
	const base = `http://127.0.0.1:${port}/metadata-repository/v1/`;
	const request = (user, path, body) => fetch(base + path, { method: body ? 'POST' : 'GET',
		headers: { 'Zotero-API-Key': tokens[user] || 'invalid', 'Content-Type': 'application/json' },
		body: body ? JSON.stringify(body) : undefined });
	const item = { itemType: 'journalArticle', title: 'Two clients sharing bibliographic metadata',
		creators: [{ creatorType: 'author', firstName: 'Ada', lastName: 'Example' }], DOI: '10.1234/shared-api',
		filename: 'private-file.pdf', tags: ['private-tag'], extra: 'private-note', apiKey: 'private-key' };
	const query = { schema: 1, identifiers: [{ kind: 'doi', value: item.DOI }] };
	await t.test('authentication precedes body parsing and rejects unknown tokens', async () => {
		assert.equal((await request(99, 'health')).status, 403);
		assert.equal((await request(99, 'records', { schema: 1, record: { item, source: 'Crossref' } })).status, 403);
		assert.equal((await request(1, 'health')).status, 200);
	});
	await t.test('one account contributes; another account can query without catalog or library access', async () => {
		assert.deepEqual((await (await request(1, 'query', query)).json()).records, []);
		const submitted = await request(0, 'records', { schema: 1, record: { item, source: 'Crossref' } });
		assert.equal(submitted.status, 201);
		const id = (await submitted.json()).id;
		const result = await (await request(1, 'query', query)).json();
		assert.equal(result.records[0].id, id);
		assert.equal(result.records[0].item.title, item.title);
		assert.doesNotMatch(JSON.stringify(result), /private-|user_id|username|token/);
		assert.equal((await pool.query('SELECT user_id FROM recognition_repository_contributions')).rows[0].user_id, '1');
		assert.equal((await pool.query('SELECT * FROM objects')).rowCount, 0);
		await request(1, 'records', { schema: 1, record: { item, source: 'Crossref' } });
		assert.equal((await pool.query('SELECT * FROM recognition_repository_records')).rowCount, 1);
		assert.equal((await pool.query('SELECT * FROM recognition_repository_contributions')).rowCount, 2);
	});
	await t.test('raw extraction is rejected, revoked tokens fail, logs contain no bibliographic bodies', async () => {
		assert.equal((await request(0, 'query', { ...query, pages: ['private PDF text'] })).status, 400);
		await pool.query('DELETE FROM auth_tokens WHERE user_id=2');
		assert.equal((await request(1, 'query', query)).status, 403);
		assert.doesNotMatch(logs, /private-|Two clients sharing|10\.1234\/shared-api/);
		for (const token of tokens) assert.ok(!logs.includes(token));
	});
});
