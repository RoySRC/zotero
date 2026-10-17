import { readFileSync } from 'node:fs';
import { createApp } from './app.mjs';
import { createStore } from './store.mjs';
import { createProviders } from './providers.mjs';
import { createEngine } from './engine.mjs';

// Read the shared secret from a mounted file, not a committed Compose value.
let key = readFileSync(process.env.RECOGNITION_SERVICE_KEY_FILE, 'utf8').trim();
let store = await createStore(process.env.DATABASE_URL);
let providers = createProviders({ contact: process.env.PROVIDER_CONTACT });
let recognize = createEngine({ providers, store, mode: process.env.LOOKUP_MODE || 'online' });
let server = createApp({ key, recognize }).listen(8080, '0.0.0.0', () => {
	console.log('EpiLib recognition worker listening on port 8080');
});
server.requestTimeout = 30000;

/** Drain HTTP requests and database connections, with a bounded shutdown time. */
function shutdown() {
	setTimeout(() => process.exit(1), 10000).unref();
	server.close(async () => { await store.close(); process.exit(0); });
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
