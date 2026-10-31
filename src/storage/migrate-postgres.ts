import { Pool } from 'pg';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

export async function migratePostgres(pool:Pool):Promise<void> {
  const c=await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended('bos:migrations',0))");
    await c.query('CREATE TABLE IF NOT EXISTS public.bos_schema_migration(version text PRIMARY KEY, sha256 text NOT NULL)');
    await c.query('REVOKE ALL ON public.bos_schema_migration FROM PUBLIC');
    const sql=await readFile('migrations/001_core.sql','utf8');
    const hash=createHash('sha256').update(sql).digest('hex');
    const previous=await c.query<{sha256:string}>("SELECT sha256 FROM public.bos_schema_migration WHERE version='001'");
    if(previous.rows.length){if(previous.rows[0]?.sha256!==hash) throw new Error('migration_checksum_mismatch');}
    else {
      await c.query(sql);
      await c.query("INSERT INTO public.bos_schema_migration VALUES ('001',$1)",[hash]);
    }
    await c.query('COMMIT');
  } catch(e){await c.query('ROLLBACK');throw e;} finally{c.release();}
}
if(process.argv[1]?.endsWith('migrate-postgres.js')) {
  const url=process.env.BOS_MIGRATION_DATABASE_URL;
  if(!url) throw new Error('BOS_MIGRATION_DATABASE_URL required; administrator connection only');
  const pool=new Pool({connectionString:url});
  try{await migratePostgres(pool);console.log('Migration 001 applied or already current');}finally{await pool.end();}
}
