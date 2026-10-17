import express from 'express';
import { timingSafeEqual } from 'node:crypto';

/**
 * Create the worker's private HTTP boundary. Only the sync gateway knows this
 * service key; desktop user tokens are never accepted here. Requests are bounded
 * by JSON size and active-job count; saturation is explicit, not an unbounded
 * queue. Disconnected callers still occupy a slot until their job actually ends.
 */
export function createApp({ key, recognize, concurrency = 4 }) {
	if (typeof key != 'string' || key.length < 32) throw new Error('A service key of at least 32 characters is required');
	let expected = Buffer.from(`Bearer ${key}`);
	let active = 0;
	let app = express();
	app.disable('x-powered-by');
	app.use((req, res, next) => {
		res.set('Cache-Control', 'no-store');
		let provided = Buffer.from(req.get('Authorization') || '');
		if (provided.length != expected.length || !timingSafeEqual(provided, expected)) {
			return res.status(403).json({ error: 'forbidden' });
		}
		next();
	});
	app.get('/health', (_req, res) => res.json({ engine: 'epilib', version: 2,
		protocol: 'epilib-recognition-v2', reports: false }));
	app.post('/recognize', express.json({ limit: '5mb' }), async (req, res, next) => {
		if (active >= concurrency) return res.status(503).json({ error: 'recognition_busy' });
		active++;
		try { res.json(await recognize(req.body)); }
		catch (error) { next(error); }
		finally { active--; }
	});
	app.use((error, _req, res, _next) => {
		let status = [400, 413, 503].includes(error.status) ? error.status : 502;
		res.status(status).json({ error: status == 413 ? 'extraction_too_large'
			: status == 400 ? 'invalid_extraction' : 'recognition_unavailable' });
	});
	return app;
}
