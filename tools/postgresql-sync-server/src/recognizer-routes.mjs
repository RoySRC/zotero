import express from 'express';
import { recognizeExtraction } from './recognizer.mjs';

/**
 * Build the recognition HTTP boundary. Mount AFTER the server's token middleware:
 * req.authUser is the resolved PostgreSQL account, not a client-supplied identity.
 * The extra guard prevents accidental anonymous exposure if this router is moved.
 * Parsing happens here (not the general 25 MB sync parser) to cap document input.
 * @returns {import('express').Router} Authenticated, non-persistent API routes.
 */
export function createRecognizerRouter() {
	let router = express.Router();
	router.use((req, res, next) => {
		res.set('Cache-Control', 'no-store');
		if (!req.authUser) return res.status(403).json({ error: 'forbidden' });
		next();
	});
	router.use(express.json({ limit: '5mb' }));
	router.get('/health', (_req, res) => {
		res.json({ engine: 'epilib', version: 1, protocol: 'zotero-recognizer-json', reports: false });
	});
	router.post('/recognize', (req, res) => {
		res.json(recognizeExtraction(req.body));
	});
	// Feedback can contain the entire extracted text. Until there is an explicit
	// retention/review policy, reject it without storing or forwarding the body.
	router.post('/report', (_req, res) => {
		res.status(501).json({ error: 'recognition_feedback_not_supported' });
	});
	router.use((err, _req, res, _next) => {
		let status = err.status == 413 ? 413 : err.status == 400 ? 400 : 500;
		res.status(status).json({ error: status == 413 ? 'extraction_too_large'
			: status == 400 ? 'invalid_extraction' : 'recognition_failed' });
	});
	return router;
}
