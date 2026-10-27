import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';

/** Connect through VPN routing without changing the HTTP Host, TLS SNI or trust checks. */
export function request(url, address) {
	if (address && !isIP(address)) throw new Error('HTTPS test address must be an IP literal');
	const lookup = address ? (_hostname, options, callback) => {
		const family = isIP(address);
		if (options.all) callback(null, [{ address, family }]);
		else callback(null, address, family);
	} : undefined;
	return new Promise((resolve, reject) => {
		const client = url.protocol === 'https:' ? https : http;
		const req = client.get(url, { agent: false, timeout: 10000, lookup }, response => {
			const certificate = response.socket.getPeerX509Certificate?.();
			const authorized = response.socket.authorized;
			let body = '';
			response.setEncoding('utf8');
			response.on('data', chunk => { body += chunk; });
			response.on('error', reject);
			response.on('end', () => resolve({ status: response.statusCode,
				headers: response.headers, body, certificate, authorized }));
		});
		req.on('timeout', () => req.destroy(new Error('HTTPS deployment check timed out')));
		req.on('error', reject);
	});
}
