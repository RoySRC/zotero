import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { once } from 'node:events';
import test from 'node:test';
import { request } from './lib/https-probe.mjs';

test('VPN address override preserves the certificate hostname in HTTP requests', async () => {
	const server = http.createServer((req, res) => res.end(req.headers.host));
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	try {
		const hostname = `sync.example.invalid:${server.address().port}`;
		const result = await request(new URL(`http://${hostname}/health`), '127.0.0.1');
		assert.equal(result.body, hostname);
	}
	finally { await new Promise(resolve => server.close(resolve)); }
});

test('VPN probe does not accept arbitrary resolver names', () => {
	assert.throws(() => request(new URL('https://sync.example.org'), 'other.example.org'), /IP literal/);
});

test('VPN routing retains TLS hostname verification and rejects untrusted certificates', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'epilib-tls-test-'));
	const key = join(directory, 'key.pem'), cert = join(directory, 'cert.pem');
	const execute = promisify(execFile);
	let server;
	try {
		// This disposable fixture is trusted only by one child test process, never by the app or OS.
		await execute('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
			'-subj', '/CN=sync.example.invalid', '-addext', 'subjectAltName=DNS:sync.example.invalid',
			'-keyout', key, '-out', cert]);
		server = https.createServer({ key: await readFile(key), cert: await readFile(cert) }, (_req, res) => res.end('ok'));
		server.listen(0, '127.0.0.1');
		await once(server, 'listening');
		const port = server.address().port;
		await assert.rejects(request(new URL(`https://sync.example.invalid:${port}/`), '127.0.0.1'),
			error => error.code === 'DEPTH_ZERO_SELF_SIGNED_CERT');
		const script = `
			import assert from 'node:assert/strict';
			import { request } from ${JSON.stringify(new URL('./lib/https-probe.mjs', import.meta.url).href)};
			const result = await request(new URL('https://sync.example.invalid:${port}/'), '127.0.0.1');
			assert.equal(result.authorized, true);
			assert.equal(result.body, 'ok');
			await assert.rejects(request(new URL('https://wrong.example.invalid:${port}/'), '127.0.0.1'),
				error => error.code === 'ERR_TLS_CERT_ALTNAME_INVALID');
		`;
		await execute(process.execPath, ['--input-type=module', '-e', script],
			{ env: { ...process.env, NODE_EXTRA_CA_CERTS: cert }, timeout: 15000 });
	}
	finally {
		if (server) await new Promise(resolve => server.close(resolve));
		await rm(directory, { recursive: true, force: true });
	}
});
