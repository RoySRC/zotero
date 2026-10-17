import express from 'express';
import { readFileSync } from 'node:fs';

/**
 * Build the recognition HTTP boundary. Mount AFTER the server's token middleware:
 * req.authUser is the resolved PostgreSQL account, not a client-supplied identity.
 * The extra guard prevents accidental anonymous exposure if this router is moved.
 * Parsing happens here (not the general 25 MB sync parser) to cap document input.
 * @returns {import('express').Router} Authenticated, non-persistent API routes.
 */
export function createRecognizerRouter({ url = process.env.RECOGNITION_SERVICE_URL,
	key, fetchImpl = fetch } = {}) {
	if (key === undefined && process.env.RECOGNITION_SERVICE_KEY_FILE) {
		key = readFileSync(process.env.RECOGNITION_SERVICE_KEY_FILE, 'utf8').trim();
	}
	let base;
	if (url) {
		base = new URL(url);
		if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password
				|| base.search || base.hash) throw new Error('Invalid recognition service URL');
		if (!base.pathname.endsWith('/')) base.pathname += '/';
	}
	let router = express.Router();
	router.use((req, res, next) => {
		res.set('Cache-Control', 'no-store');
		if (!req.authUser) return res.status(403).json({ error: 'forbidden' });
		next();
	});
	router.use(express.json({ limit: '5mb' }));
	/**
	 * Forward only the two recognition operations to the private worker. A new
	 * service credential replaces the user's token; no account cookies, identity,
	 * or arbitrary client URL crosses this boundary. Never silently use Zotero.
	 */
	async function forward(req, res, next) {
		if (!base || !key || key.length < 32) {
			return res.status(503).json({ error: 'recognition_service_not_configured' });
		}
		try {
			let response = await fetchImpl(new URL(req.method == 'GET' ? 'health' : 'recognize', base), {
				method: req.method, redirect: 'error', signal: AbortSignal.timeout(25000),
				headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
				body: req.method == 'POST' ? JSON.stringify(req.body) : undefined
			});
			if (!response.ok) {
				let status = [400, 413, 503].includes(response.status) ? response.status : 502;
				return res.status(status).json({ error: 'recognition_unavailable' });
			}
			let chunks = [], size = 0;
			for await (let chunk of response.body) {
				size += chunk.length;
				if (size > 1024 * 1024) throw new Error('Oversized worker response');
				chunks.push(chunk);
			}
			res.json(JSON.parse(Buffer.concat(chunks).toString('utf8')));
		}
		catch (error) { next(error); }
	}
	router.get('/health', forward);
	router.post('/recognize', forward);
	// Feedback can contain the entire extracted text. Until there is an explicit
	// retention/review policy, reject it without storing or forwarding the body.
	router.post('/report', (_req, res) => {
		res.status(501).json({ error: 'recognition_feedback_not_supported' });
	});
	router.use((err, _req, res, _next) => {
		let status = err.status == 413 ? 413 : err.status == 400 ? 400 : 502;
		res.status(status).json({ error: status == 413 ? 'extraction_too_large'
			: status == 400 ? 'invalid_extraction' : 'recognition_failed' });
	});
	return router;
}
