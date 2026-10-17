import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Explicit Docker smoke test, outside npm test so contributors need not run a
 * daemon. Uses the real Compose configuration with a random disposable secret,
 * no library credentials, and local-only mode (no provider network requests).
 * Cleanup runs even if startup, authentication, or recognition assertions fail.
 */
let directory = await mkdtemp(join(tmpdir(), 'epilib-worker-smoke-'));
let secret = randomBytes(32).toString('hex');
let secretPath = join(directory, 'worker.key');
await writeFile(secretPath, secret, { mode: 0o600 });
let env = { ...process.env, RECOGNITION_SERVICE_KEY_FILE: secretPath,
	RECOGNITION_UID: String(process.getuid()), RECOGNITION_GID: String(process.getgid()),
	LOOKUP_MODE: 'local', RECOGNITION_DATABASE_URL: '' };
let cwd = fileURLToPath(new URL('../', import.meta.url));
let project = 'epilib-recognition-smoke-' + randomBytes(4).toString('hex');
let container;
/** Invoke only this test's Compose project; never stop another operator's service. */
function compose(...args) {
	return execFileSync('docker', ['compose', '-p', project, ...args], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
try {
	// "run" does not publish the Compose service port; Docker assigns a free test port.
	compose('build');
	container = compose('run', '-d', '--no-deps', '-p', '127.0.0.1::8080', 'recognition').trim();
	let port = JSON.parse(execFileSync('docker', ['inspect', container], { encoding: 'utf8' }))[0].NetworkSettings.Ports['8080/tcp'][0].HostPort;
	let base = `http://127.0.0.1:${port}/`;
	let headers = { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' };
	let ready = false;
	for (let i = 0; i < 50; i++) {
		try { ready = (await fetch(base + 'health', { headers })).ok; }
		catch (_error) { /* Startup can briefly precede the listener. */ }
		if (ready) break;
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	assert.ok(ready, 'Worker should start as a non-root user with the mounted secret');
	assert.equal((await fetch(base + 'health')).status, 403);
	assert.equal((await (await fetch(base + 'health', { headers })).json()).protocol, 'epilib-recognition-v2');
	let response = await fetch(base + 'recognize', { method: 'POST', headers,
		body: JSON.stringify({ totalPages: 0, pages: [], metadata: {} }) });
	assert.equal(response.status, 200);
	assert.equal((await response.json()).status, 'no_match');
	console.log('Compose smoke passed: authenticated health, no-match recognition, read-only non-root container');
}
finally {
	try {
		// Compose down can leave one-off "run" containers alive. Remove exactly
		// the ID returned above before removing this test's network and secret.
		if (container) execFileSync('docker', ['rm', '-f', container], { stdio: 'ignore' });
	}
	finally {
		try { compose('down', '--remove-orphans'); }
		finally { await rm(directory, { recursive: true, force: true }); }
	}
}
