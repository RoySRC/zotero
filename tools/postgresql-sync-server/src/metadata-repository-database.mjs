import pg from 'pg';
import { createMetadataRepositoryRouter, ensureMetadataRepositorySchema } from '../vendor/recognition-repository/repository.mjs';

/**
 * Require different database names, even when hosts or connection URLs differ.
 * Query PostgreSQL instead of comparing URL strings, which can differ by user,
 * host alias, SSL parameters or application_name yet address the same database.
 * The deliberately conservative name rule also applies across separate hosts.
 */
export async function assertSeparateRepositoryDatabase(accountPool, repositoryPool) {
	const account = await accountPool.query('SELECT current_database() AS name');
	const repository = await repositoryPool.query('SELECT current_database() AS name');
	if (account.rows[0].name === repository.rows[0].name) {
		throw Object.assign(new Error('Repository database must have a different name from the account database'),
			{ code: 'repository_database_conflict' });
	}
}

/**
 * Create a bounded pool used only for public recognition records. No default to
 * DATABASE_URL is allowed. Keep driver error text (which can include credentials)
 * out of logs, including errors from idle sockets after a database restart.
 */
export function createRepositoryPool(connectionString) {
	if (!connectionString || !['postgres:', 'postgresql:'].includes(new URL(connectionString).protocol)) {
		throw new Error('METADATA_REPOSITORY_DATABASE_URL must be an explicit PostgreSQL URL');
	}
	const pool = new pg.Pool({ connectionString, max: 4, connectionTimeoutMillis: 1500,
		statement_timeout: 5000, idleTimeoutMillis: 10000 });
	pool.on('error', () => console.warn('Shared metadata repository connection lost; subsequent requests will reconnect'));
	return pool;
}

/**
 * Mount after account authentication. A missing, unsafe or unavailable repository
 * disables only this optional API with 503 responses; account/library sync keeps
 * using its existing pool. Never fall back to writing public cache data there.
 * Startup failures require an operator restart after correcting configuration.
 */
export async function openMetadataRepository({ accountPool, connectionString = process.env.METADATA_REPOSITORY_DATABASE_URL }) {
	let pool;
	let reason = 'repository_not_configured';
	if (connectionString) {
		try {
			pool = createRepositoryPool(connectionString);
			await assertSeparateRepositoryDatabase(accountPool, pool);
			await ensureMetadataRepositorySchema(pool);
			return { router: createMetadataRepositoryRouter({ pool }), close: () => pool.end() };
		}
		catch (error) {
			reason = error.code === 'repository_database_conflict' ? error.code : 'repository_unavailable';
			console.warn(`Shared metadata repository disabled: ${reason}. Check METADATA_REPOSITORY_DATABASE_URL and restart.`);
			await pool?.end();
		}
	}
	return {
		router: (_req, res) => res.set('Cache-Control', 'no-store').status(503).json({ error: reason }),
		close: async () => {}
	};
}
