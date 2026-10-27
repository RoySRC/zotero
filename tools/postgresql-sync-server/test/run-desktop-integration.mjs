/**
 * Run the native desktop sync tests against a real, disposable PostgreSQL API.
 * TEST_DATABASE_URL is used only to create/drop a randomly named test database;
 * the desktop receives a loopback URL and a synthetic token, never production
 * credentials. The normal native test runner also creates a fresh local profile.
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

if (!process.env.TEST_DATABASE_URL) {
	throw new Error('TEST_DATABASE_URL is required; refusing to skip desktop integration coverage');
}

const root = fileURLToPath(new URL('../../../', import.meta.url));
const name = `epilib_publication_${randomBytes(8).toString('hex')}`;
const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
const token = randomBytes(32).toString('hex');
let created = false, fixture, server, desktop;
let serverLog = '';

/** Stop a fixture process, escalating if it fails to exit, without touching any user app. */
async function stop(child) {
	if (!child || child.exitCode !== null || child.signalCode !== null) return;
	const exited = once(child, 'exit');
	child.kill('SIGTERM');
	const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
	try { await exited; }
	finally { clearTimeout(timer); }
}

/** Probe readiness instead of relying on build/machine-dependent startup delays. */
async function waitForServer(base) {
	for (let attempt = 0; attempt < 50; attempt++) {
		if (server.exitCode !== null) throw new Error(`Fixture server exited: ${serverLog}`);
		try {
			if ((await fetch(base + 'health', { signal: AbortSignal.timeout(1000) })).ok) return;
		}
		catch { /* Connection refusal is expected until the fixture starts listening. */ }
		await new Promise(resolve => setTimeout(resolve, 200));
	}
	throw new Error(`Fixture server did not become ready: ${serverLog}`);
}

try {
	// Only the generated name is interpolated as an SQL identifier. All fixture
	// values are parameters, and no rows are written to the supplied database.
	await admin.query(`CREATE DATABASE ${name}`);
	created = true;
	const databaseURL = new URL(process.env.TEST_DATABASE_URL);
	databaseURL.pathname = `/${name}`;
	fixture = new pg.Client({ connectionString: databaseURL.href });
	await fixture.connect();
	await fixture.query(await readFile(new URL('../schema.sql', import.meta.url), 'utf8'));
	await fixture.query("INSERT INTO users(id, zotero_user_id, username) VALUES (1, 1, 'publication-test')");
	await fixture.query('INSERT INTO auth_tokens(user_id, token_hash) VALUES (1, $1)',
		[createHash('sha256').update(token).digest('hex')]);
	await fixture.query("INSERT INTO libraries(type, type_id, name, metadata) VALUES ('group', 991234, 'Publication Test', $1)",
		[{ owner: 1, members: [1] }]);
	// Close the bootstrap connection before running the app. Keeping an idle pool
	// here can race DROP DATABASE against socket shutdown during final cleanup.
	await fixture.end();
	fixture = null;

	// Reserve a free loopback port, then launch the same server entry point used
	// in production. TEST_SERVER_PATH supports checking a known-broken revision.
	const listener = net.createServer();
	listener.listen(0, '127.0.0.1');
	await once(listener, 'listening');
	const port = listener.address().port;
	await new Promise(resolve => listener.close(resolve));
	const base = `http://127.0.0.1:${port}/`;
	server = spawn(process.execPath, [process.env.TEST_SERVER_PATH
		|| fileURLToPath(new URL('../src/server.mjs', import.meta.url))], {
		env: { ...process.env, DATABASE_URL: databaseURL.href, PORT: String(port),
			ZOTERO_SYNC_API_KEY: '', RECOGNITION_SERVICE_URL: '', RECOGNITION_SERVICE_KEY_FILE: '',
			WEBDAV_GROUP_PASSWD_PATH: '', WEBDAV_GROUP_PASSWD_SSH_HOST: '' },
		stdio: ['ignore', 'pipe', 'pipe']
	});
	server.stdout.on('data', chunk => { serverLog += chunk; });
	server.stderr.on('data', chunk => { serverLog += chunk; });
	await waitForServer(base);

	// The shell runner supplies an isolated SQLite database and success marker.
	// Do not supply -profile/-datadir: neither the test nor server sees live data.
	desktop = spawn('bash', ['test/runtests.sh', '-f', '-b', 'publicationSync'], {
		cwd: root,
		env: { ...process.env, EPILIB_SYNC_TEST_URL: base, EPILIB_SYNC_TEST_TOKEN: token },
		stdio: 'inherit'
	});
	const [code, signal] = await once(desktop, 'exit');
	if (code !== 0) throw new Error(`Desktop publication sync test failed (${signal || code})`);
	console.log('Desktop/PostgreSQL publication round trip passed.');
}
finally {
	// Cleanup also runs after a regression failure. No test accounts or records
	// survive the run; the supplied database and running application are untouched.
	await stop(desktop);
	await stop(server);
	await fixture?.end();
	try {
		if (created) await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
	}
	finally { await admin.end(); }
}
