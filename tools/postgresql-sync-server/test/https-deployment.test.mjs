import assert from 'node:assert/strict';
import test from 'node:test';
import { request as probe } from './lib/https-probe.mjs';

const endpoint = process.env.EPILIB_HTTPS_TEST_URL;
const options = { skip: !endpoint, timeout: 20000 };
const request = url => probe(url, process.env.EPILIB_HTTPS_TEST_ADDRESS);

/** Reject configuration that could accidentally turn a certificate check into a bypass. */
function serverURL() {
	assert.notEqual(process.env.NODE_TLS_REJECT_UNAUTHORIZED, '0');
	const url = new URL(endpoint);
	assert.equal(url.protocol, 'https:');
	assert.equal(url.username + url.password + url.search + url.hash, '');
	return url;
}

test('deployed HTTPS presents a trusted, hostname-matched, non-self-signed certificate', options, async () => {
	const base = serverURL();
	const result = await request(new URL('health', base));
	assert.equal(result.authorized, true);
	assert.ok(result.certificate.checkHost(base.hostname));
	assert.notEqual(result.certificate.subject, result.certificate.issuer);
	assert.ok(Date.parse(result.certificate.validFrom) <= Date.now());
	assert.ok(Date.parse(result.certificate.validTo) > Date.now() + 7 * 86400000,
		'Certificate expires in under seven days; check automatic renewal');
	assert.equal(result.status, 200);
	assert.deepEqual(JSON.parse(result.body), { ok: true });
});

test('HTTP redirects to the same HTTPS host without proxying account requests in plaintext', options, async () => {
	const secure = new URL('health', serverURL());
	const plain = new URL(secure); plain.protocol = 'http:'; plain.port = '';
	const result = await request(plain);
	assert.ok([301, 308].includes(result.status));
	assert.equal(result.headers.location, secure.href);
});

test('HTTPS preserves authentication on identity, sync and shared metadata routes', options, async () => {
	for (const path of ['keys/current', 'users/1/items?format=versions', 'metadata-repository/v1/health']) {
		const result = await request(new URL(path, serverURL()));
		assert.equal(result.status, 403, path);
		assert.deepEqual(JSON.parse(result.body), { error: 'forbidden' });
	}
});
