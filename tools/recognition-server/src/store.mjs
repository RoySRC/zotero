import pg from 'pg';

/**
 * Open an optional, dedicated recognition database. This is NOT the library sync
 * database: only public provider records belong here. Without a connection URL,
 * a bounded in-memory cache is sufficient for online lookup. All SQL values are
 * parameters; PDF contents, filenames, and private search hints are never saved.
 */
export async function createStore(databaseURL) {
	let pool = databaseURL ? new pg.Pool({ connectionString: databaseURL, max: 4,
		statement_timeout: 5000, connectionTimeoutMillis: 5000 }) : null;
	let memory = new Map();
	if (pool) {
		await pool.query(`CREATE TABLE IF NOT EXISTS metadata_cache (
			public_key text PRIMARY KEY, record jsonb NOT NULL, expires_at timestamptz NOT NULL);
			CREATE TABLE IF NOT EXISTS crossref_records (
				doi text PRIMARY KEY, record jsonb NOT NULL, title text NOT NULL,
				search tsvector GENERATED ALWAYS AS (to_tsvector('simple', title)) STORED);
			CREATE INDEX IF NOT EXISTS crossref_records_search ON crossref_records USING gin(search)`);
	}
	return {
		/** Return an unexpired public record, or null. Misses are not errors. */
		async get(key) {
			if (pool) return (await pool.query('SELECT record FROM metadata_cache WHERE public_key=$1 AND expires_at>now()', [key])).rows[0]?.record || null;
			let entry = memory.get(key);
			return entry?.expires > Date.now() ? entry.record : null;
		},
		/** Cache successful identifier resolutions for one day, with bounded memory. */
		async put(key, record) {
			if (pool) {
				await pool.query('DELETE FROM metadata_cache WHERE expires_at<=now()');
				await pool.query(`INSERT INTO metadata_cache VALUES ($1,$2,now()+interval '1 day')
					ON CONFLICT (public_key) DO UPDATE SET record=$2,expires_at=now()+interval '1 day'`, [key, record]);
			}
			else {
				if (memory.size >= 1000) memory.delete(memory.keys().next().value);
				memory.set(key, { record, expires: Date.now() + 86400000 });
			}
		},
		/** Look up one DOI in the operator-imported Crossref sample/index. */
		async localDOI(doi) {
			return pool ? (await pool.query('SELECT record FROM crossref_records WHERE doi=$1', [doi])).rows[0]?.record || null : null;
		},
		/** Retrieve a small candidate set; matching policy lives in the engine. */
		async search(title) {
			if (!pool) return [];
			return (await pool.query(`SELECT record FROM crossref_records,
				plainto_tsquery('simple',$1) query WHERE search @@ query
				ORDER BY ts_rank(search,query) DESC,doi LIMIT 5`, [title])).rows.map(row => row.record);
		},
		/** Import one normalized public record. Re-imports update the same DOI. */
		async importRecord(record) {
			if (!pool) throw new Error('A dedicated DATABASE_URL is required for import');
			await pool.query(`INSERT INTO crossref_records VALUES ($1,$2,$3)
				ON CONFLICT (doi) DO UPDATE SET record=$2,title=$3`, [record.DOI, record, record.title]);
		},
		/** Report real index size instead of extrapolating disk use from JSON bytes. */
		async stats() {
			return pool ? (await pool.query(`SELECT count(*)::integer AS records,
				pg_total_relation_size('crossref_records')::bigint::text AS bytes FROM crossref_records`)).rows[0] : null;
		},
		/** Release database connections on shutdown or after an evaluation run. */
		async close() { if (pool) await pool.end(); }
	};
}
