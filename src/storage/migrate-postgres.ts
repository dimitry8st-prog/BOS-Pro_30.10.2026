import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';

const ROLE_BLOCK = `DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bos_runtime') THEN
    CREATE ROLE bos_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END
$role$;`;
const HISTORICAL_ROLE = 'CREATE ROLE bos_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS;';

export interface MigrationDb {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
  exec?(sql: string): Promise<void>;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function newlineForms(text: string): string[] {
  const lf = text.replace(/\r\n/g, '\n');
  const crlf = lf.replace(/\n/g, '\r\n');
  return [...new Set([text, lf, crlf])];
}

export function historicalCoreText(current: string): string {
  const normalized = current.replace(/\r\n/g, '\n').replace(ROLE_BLOCK, HISTORICAL_ROLE);
  if (normalized === current.replace(/\r\n/g, '\n')) throw new Error('historical migration text was not derived');
  return normalized;
}

export async function migrationChecksums(): Promise<{ current001: string; historical001: string[]; current002: string; accepted001: Set<string>; accepted002: Set<string> }> {
  const current = await readFile('migrations/001_core.sql', 'utf8');
  const historicalFile = await readFile('migrations/history/001_core_516fc5a.sql', 'utf8');
  const next = await readFile('migrations/002_session_identity.sql', 'utf8');
  const historical = historicalCoreText(current);
  const accepted001 = new Set([...newlineForms(current), ...newlineForms(historicalFile), ...newlineForms(historical)].map(sha256));
  const accepted002 = new Set(newlineForms(next).map(sha256));
  return {
    current001: sha256(current),
    historical001: [...new Set([sha256(historical), ...newlineForms(historicalFile).map(sha256)])],
    current002: sha256(next),
    accepted001,
    accepted002,
  };
}

async function runScript(db: MigrationDb, sql: string): Promise<void> {
  if (db.exec) await db.exec(sql);
  else await db.query(sql);
}

async function applyOne(
  db: MigrationDb,
  version: string,
  sql: string,
  recordedHash: string,
  accepted: Set<string>,
): Promise<void> {
  const previous = await db.query<{ sha256: string }>('SELECT sha256 FROM public.bos_schema_migration WHERE version = $1', [version]);
  const stored = previous.rows[0]?.sha256;
  if (stored) {
    if (!accepted.has(stored)) throw new Error('migration_checksum_mismatch');
    return;
  }
  await runScript(db, sql);
  await db.query('INSERT INTO public.bos_schema_migration VALUES ($1, $2)', [version, recordedHash]);
}

/** Apply 001 and 002. A known historical checksum of 001 is kept and is not rewritten. */
export async function applyMigrations(db: MigrationDb): Promise<void> {
  const current = await readFile('migrations/001_core.sql', 'utf8');
  const next = await readFile('migrations/002_session_identity.sql', 'utf8');
  const sums = await migrationChecksums();
  await db.query('BEGIN');
  try {
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended('bos:migrations', 0))");
    await db.query('CREATE TABLE IF NOT EXISTS public.bos_schema_migration(version text PRIMARY KEY, sha256 text NOT NULL)');
    await db.query('REVOKE ALL ON public.bos_schema_migration FROM PUBLIC');
    await applyOne(db, '001', current, sums.current001, sums.accepted001);
    await applyOne(db, '002', next, sums.current002, sums.accepted002);
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}

export async function migratePostgres(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await applyMigrations({
      async query<T extends Record<string, unknown>>(sql: string, values?: unknown[]) {
        const result = await client.query<T>(sql, values);
        return { rows: result.rows, rowCount: result.rowCount };
      },
    });
  } finally {
    client.release();
  }
}

const isCli = process.argv[1]?.endsWith('migrate-postgres.js') === true;
if (isCli) {
  const url = process.env.BOS_MIGRATION_DATABASE_URL;
  if (!url) throw new Error('BOS_MIGRATION_DATABASE_URL required; administrator connection only');
  const pool = new Pool({ connectionString: url });
  try {
    await migratePostgres(pool);
    console.log('Migrations applied or already current');
  } finally {
    await pool.end();
  }
}
