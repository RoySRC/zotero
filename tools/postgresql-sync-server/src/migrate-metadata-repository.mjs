import pg from 'pg';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { assertSeparateRepositoryDatabase, createRepositoryPool } from './metadata-repository-database.mjs';
import { ensureMetadataRepositorySchema } from '../vendor/recognition-repository/repository.mjs';

/**
 * Copy a consistent legacy snapshot to a different database without deleting any
 * source data. The source transaction is READ ONLY. The destination transaction
 * is all-or-nothing and shares the repository's write lock, so concurrent submits
 * cannot race with verification. Operators must stop legacy writers before
 * taking the snapshot; writes after it starts are intentionally not captured.
 */
export async function migrateMetadataRepository(sourcePool, targetPool, { copy = false } = {}) {
	await assertSeparateRepositoryDatabase(sourcePool, targetPool);
	const source = await sourcePool.connect();
	let target;
	try {
		await source.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
		const counts = (await source.query(`SELECT
			(SELECT count(*)::int FROM recognition_repository_records) AS records,
			(SELECT count(*)::int FROM recognition_repository_contributions) AS contributions`)).rows[0];
		if (!copy) return { dryRun: true, ...counts };
		target = await targetPool.connect();
		await target.query('BEGIN');
		await target.query('SELECT pg_advisory_xact_lock(1735289201, 1)');
		await ensureMetadataRepositorySchema(target);

		// Server-side cursors bound client memory. Text timestamps preserve native
		// PostgreSQL microsecond precision rather than rounding through JS Dates.
		await source.query(`DECLARE records NO SCROLL CURSOR FOR SELECT digest,item,source,identifiers,title_key,
			created_at::text,expires_at::text FROM recognition_repository_records ORDER BY digest`);
		let records = 0, contributions = 0;
		while (true) {
			const batch = await source.query('FETCH 500 FROM records');
			if (!batch.rowCount) break;
			for (const row of batch.rows) {
				const data = [row.digest, row.item, row.source, row.identifiers, row.title_key];
				await target.query(`INSERT INTO recognition_repository_records
					(digest,item,source,identifiers,title_key,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)
					ON CONFLICT(digest) DO NOTHING`, [...data, row.created_at, row.expires_at]);
				// Existing variants may have different retention dates. Preserve those
				// dates, but never silently accept different metadata under one digest.
				const verified = await target.query(`SELECT 1 FROM recognition_repository_records
					WHERE digest=$1 AND item=$2::jsonb AND source=$3 AND identifiers=$4::text[] AND title_key=$5`, data);
				if (verified.rowCount !== 1) {
					throw Object.assign(new Error('Repository migration conflict; destination transaction rolled back'), { code: 'repository_migration_conflict' });
				}
				records++;
			}
		}
		await source.query(`DECLARE contributors NO SCROLL CURSOR FOR
			SELECT user_id,digest,created_at::text FROM recognition_repository_contributions ORDER BY user_id,digest`);
		while (true) {
			const batch = await source.query('FETCH 500 FROM contributors');
			if (!batch.rowCount) break;
			for (const row of batch.rows) {
				await target.query(`INSERT INTO recognition_repository_contributions(user_id,digest,created_at)
					VALUES($1,$2,$3) ON CONFLICT(user_id,digest) DO NOTHING`, [row.user_id, row.digest, row.created_at]);
				const verified = await target.query('SELECT 1 FROM recognition_repository_contributions WHERE user_id=$1 AND digest=$2',
					[row.user_id, row.digest]);
				if (verified.rowCount !== 1) throw new Error('Repository contribution verification failed');
				contributions++;
			}
		}
		if (records !== counts.records || contributions !== counts.contributions) throw new Error('Repository migration count mismatch');
		await target.query('COMMIT');
		return { dryRun: false, records, contributions };
	}
	catch (error) {
		if (target) await target.query('ROLLBACK');
		throw error;
	}
	finally {
		// Read-only snapshots need no commit. Source tables remain a rollback copy.
		try { await source.query('ROLLBACK'); }
		finally { source.release(); target?.release(); }
	}
}

/** Dry-run by default; require explicit copy consent and never print connection secrets. */
async function main() {
	let source, target;
	try {
		const args = process.argv.slice(2);
		if (args.length > 1 || args.some(arg => !['--copy', '--dry-run'].includes(arg))) {
			throw new Error('Use --dry-run (default) or --copy');
		}
		if (!process.env.DATABASE_URL || !process.env.METADATA_REPOSITORY_DATABASE_URL) {
			throw new Error('Both database URLs are required');
		}
		source = new pg.Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 1500 });
		target = createRepositoryPool(process.env.METADATA_REPOSITORY_DATABASE_URL);
		const result = await migrateMetadataRepository(source, target, { copy: args.includes('--copy') });
		console.log(`${result.dryRun ? 'Dry run' : 'Verified copy'}: ${result.records} records, ${result.contributions} contributions. Source unchanged.`);
	}
	catch (error) {
		console.error(error.code === 'repository_migration_conflict'
			? 'Repository migration conflict. No destination changes committed; source unchanged.'
			: 'Repository migration failed. Check arguments, distinct database names, credentials and legacy tables. Source unchanged.');
		process.exitCode = 1;
	}
	finally { await target?.end(); await source?.end(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
