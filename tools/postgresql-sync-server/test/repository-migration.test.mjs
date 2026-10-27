import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pg from 'pg';

const execute = promisify(execFile);

/** Model the old, combined schema in disposable databases, never in the configured DB. */
test('repository database migration preserves records, attribution and account data', {
	skip: !process.env.TEST_DATABASE_URL, timeout: 60000
}, async t => {
	const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
	const pools = [], databases = [], urls = [];
	t.after(async () => {
		for (const pool of pools) await pool.end();
		for (const name of databases) await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
		await admin.end();
	});
	for (let i = 0; i < 2; i++) {
		const name = 'repository_migration_' + randomBytes(8).toString('hex');
		await admin.query(`CREATE DATABASE ${name}`); databases.push(name);
		const url = new URL(process.env.TEST_DATABASE_URL); url.pathname = '/' + name;
		urls.push(url.href); pools.push(new pg.Pool({ connectionString: url.href }));
	}
	const [source, target] = pools;
	await source.query(`CREATE TABLE users(id BIGINT PRIMARY KEY, password_hash TEXT);
		INSERT INTO users VALUES(1, 'synthetic-password-hash'), (2, 'another-synthetic-hash');
		CREATE TABLE libraries(id BIGINT PRIMARY KEY, version BIGINT);
		INSERT INTO libraries VALUES(1, 97);
		CREATE TABLE recognition_repository_records(digest TEXT PRIMARY KEY, item JSONB NOT NULL,
			source TEXT NOT NULL, identifiers TEXT[] NOT NULL, title_key TEXT NOT NULL,
			created_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ NOT NULL);
		CREATE TABLE recognition_repository_contributions(user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
			digest TEXT REFERENCES recognition_repository_records(digest) ON DELETE CASCADE,
			created_at TIMESTAMPTZ NOT NULL, PRIMARY KEY(user_id,digest));
		INSERT INTO recognition_repository_records VALUES
			('record-a', '{"title":"Preserved metadata","itemType":"book","creators":[]}', 'Crossref', '{doi:10.1234/test}',
			 'preserved metadata', '2025-01-01 00:00:00.123456+00', '2030-01-01 00:00:00.654321+00'),
			('expired-b', '{"title":"Expired metadata","itemType":"book","creators":[]}', 'Crossref', '{}',
			 'expired metadata', '2020-01-01+00', '2020-02-01+00');
		INSERT INTO recognition_repository_contributions VALUES
			(1,'record-a','2025-01-01 00:00:00.123456+00'), (2,'record-a','2025-01-02+00');`);
	/** Run the operator-facing CLI, including argument parsing and pool cleanup. */
	const migrate = (args = [], destination = urls[1]) => execute(process.execPath,
		[new URL('../src/migrate-metadata-repository.mjs', import.meta.url).pathname, ...args], {
			env: { ...process.env, DATABASE_URL: urls[0], METADATA_REPOSITORY_DATABASE_URL: destination }, timeout: 15000
		});
	const recordsSQL = 'SELECT *, created_at::text AS created_at, expires_at::text AS expires_at FROM recognition_repository_records ORDER BY digest';
	const contributionsSQL = 'SELECT *, created_at::text AS created_at FROM recognition_repository_contributions ORDER BY user_id,digest';
	const originals = (await source.query(recordsSQL)).rows;
	const contributors = (await source.query(contributionsSQL)).rows;
	await t.test('default is a read-only dry run and does not initialize destination tables', async () => {
		const result = await migrate();
		assert.match(result.stdout, /dry.run/i);
		assert.equal((await target.query("SELECT to_regclass('recognition_repository_records') AS name")).rows[0].name, null);
	});
	await t.test('missing or identical destination is refused without changing either database', async () => {
		for (const url of ['', urls[0], urls[0] + '?application_name=alternate']) {
			await assert.rejects(migrate(['--copy'], url), error => {
				assert.doesNotMatch(error.stderr, /postgres:\/\/|synthetic-password/);
				return error.code === 1;
			});
		}
		assert.deepEqual((await source.query(recordsSQL)).rows, originals);
	});
	await t.test('copy preserves IDs, variants, microsecond timestamps and expiry, never copies accounts', async () => {
		await migrate(['--copy']);
		assert.deepEqual((await target.query(recordsSQL)).rows, originals);
		assert.deepEqual((await target.query(contributionsSQL)).rows, contributors);
		for (const table of ['users', 'auth_tokens', 'libraries', 'objects']) {
			assert.equal((await target.query('SELECT to_regclass($1) AS name', [table])).rows[0].name, null);
		}
		assert.equal((await source.query('SELECT version FROM libraries')).rows[0].version, '97');
		assert.equal((await source.query('SELECT password_hash FROM users WHERE id=1')).rows[0].password_hash, 'synthetic-password-hash');
		assert.deepEqual((await source.query(recordsSQL)).rows, originals);
	});
	await t.test('rerunning migration is idempotent and never renews expired entries', async () => {
		await migrate(['--copy']);
		assert.deepEqual((await target.query(recordsSQL)).rows, originals);
		assert.deepEqual((await target.query(contributionsSQL)).rows, contributors);
	});
	await t.test('conflicting target content rolls back the entire copy and leaves source untouched', async () => {
		await target.query("DELETE FROM recognition_repository_records WHERE digest='expired-b'");
		await target.query("UPDATE recognition_repository_records SET item='{\"title\":\"Conflicting metadata\"}' WHERE digest='record-a'");
		const before = (await target.query(recordsSQL)).rows;
		await assert.rejects(migrate(['--copy']), error => {
			assert.match(error.stderr, /conflict/i);
			assert.doesNotMatch(error.stderr, /Conflicting metadata|postgres:\/\//);
			return error.code === 1;
		});
		assert.deepEqual((await target.query(recordsSQL)).rows, before);
		assert.deepEqual((await source.query(recordsSQL)).rows, originals);
		assert.deepEqual((await source.query(contributionsSQL)).rows, contributors);
	});
});
