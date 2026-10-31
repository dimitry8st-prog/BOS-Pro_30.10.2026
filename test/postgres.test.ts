import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { Pool } from 'pg';
import { migratePostgres } from '../src/storage/migrate-postgres.js';
import { PostgresStore, type SqlClient, type SqlPool } from '../src/storage/postgres-store.js';
import { executePrepareDraft } from '../src/scenario/execute.js';
import { reviseDraft } from '../src/scenario/revise.js';
import type { PrepareDraftInput } from '../src/contract/types.js';

test('PostgreSQL migrations, restricted RLS, transaction rollback, persistence and idempotency', async () => {
  const native = process.env.BOS_TEST_DATABASE_URL;
  const dir = await mkdtemp(path.join(tmpdir(),'bos-pg-'));
  let embedded = native ? null : new PGlite(dir);
  const network = native ? new Pool({connectionString:native}) : null;
  const query = async <T extends Record<string,unknown>>(sql:string,values:unknown[]=[]):Promise<{rows:T[];rowCount:number|null}>=>{
    if(network) return network.query<T>(sql,values);
    const r=await embedded!.query<T>(sql,values); return {rows:r.rows,rowCount:r.affectedRows??null};
  };
  // PGlite uses one backend; serialize transactions. Native runs use real pool connections.
  let tail=Promise.resolve();
  const pool:SqlPool={async connect(){
    if(network) {
      const c=await network.connect();
      return {async query<T extends Record<string,unknown>>(sql:string,values?:unknown[]){
        const r=await c.query<T>(sql,values);
        if(sql==='BEGIN') await c.query('SET LOCAL ROLE bos_runtime');
        return r;
      },release(){c.release();}};
    }
    const before=tail; let unlock!:()=>void; tail=new Promise<void>(r=>{unlock=r;}); await before;
    return {async query<T extends Record<string,unknown>>(sql:string,values?:unknown[]){
      const r=await query<T>(sql,values);
      if(sql==='BEGIN') await query('SET LOCAL ROLE bos_runtime');
      return r;
    },release(){unlock();}};
  }};
  try {
    const migration=await readFile('migrations/001_core.sql','utf8');
    // Migration application is transactional and recorded; only a fresh disposable DB is supported here.
    if(network) { await migratePostgres(network); await migratePostgres(network); }
    else await embedded!.exec('BEGIN;'+migration+';COMMIT;');
    await query("INSERT INTO bos.workspace VALUES ('ws_educational'),('ws_other')");
    await query("INSERT INTO bos.workspace_membership VALUES ('ws_educational','alice','owner'),('ws_other','bob','owner'),('ws_educational','viewer','viewer')");
    await query("INSERT INTO bos.project VALUES ('ws_educational','prj_educational'),('ws_other','prj_other')");
    await query("INSERT INTO bos.task VALUES ('ws_educational','task1','prj_educational'),('ws_other','task2','prj_other')");
    const alice=new PostgresStore(pool,{userId:'alice',workspaceId:'ws_educational',taskId:'task1'});
    const input=JSON.parse(await readFile('fixtures/educational-input.json','utf8')) as PrepareDraftInput;
    const invoke=()=>executePrepareDraft(input,{store:alice,root:process.cwd()});
    const [a,b]=await Promise.all([invoke(),invoke()]);
    assert.equal(a.outcome,'finished'); assert.equal(b.outcome,'finished');
    if(a.outcome!=='finished'||b.outcome!=='finished') throw new Error(JSON.stringify([a,b]));
    assert.equal(a.run.status,'succeeded'); assert.equal(a.run.run_id,b.run.run_id);
    assert.equal((await alice.listRuns()).length,1);
    const conflict=await executePrepareDraft({...input,topic:'different'},{store:alice,root:process.cwd()});
    assert.equal(conflict.outcome,'conflict');
    const revision=await reviseDraft(alice,a.run.run_id,'Луна изготовлена из сыра.');
    assert.equal(revision.outcome,'revised');
    if(revision.outcome!=='revised') throw new Error('revision');
    assert.equal(revision.run.quality_gate,'blocked');
    assert.equal((await alice.listArtifactRevisions(a.run.artifact_id!)).length,2);
    await assert.rejects(()=>alice.saveArtifactRevision(revision.revision));
    const bob=new PostgresStore(pool,{userId:'bob',workspaceId:'ws_other',taskId:'task2'});
    assert.equal(await bob.readRun(a.run.run_id),null);
    assert.equal(await bob.readArtifactRevision(a.run.artifact_id!,1),null);
    assert.deepEqual(await bob.listRuns(),[]);
    const bobInput={...input,workspace_id:'ws_other',project_id:'prj_other'};
    const bobRun=await executePrepareDraft(bobInput,{store:bob,root:process.cwd()});
    assert.equal(bobRun.outcome,'finished');
    if(bobRun.outcome!=='finished') throw new Error('bob run');
    assert.equal(await alice.readRun(bobRun.run.run_id),null);
    const impostor=new PostgresStore(pool,{userId:'bob',workspaceId:'ws_educational',taskId:'task1'});
    await assert.rejects(()=>impostor.listRuns(),/workspace_access_denied/);
    const viewer=new PostgresStore(pool,{userId:'viewer',workspaceId:'ws_educational',taskId:'task1'});
    assert.equal((await viewer.listRuns()).length,1);
    await viewer.requestCancel(a.run.run_id);
    assert.equal((await alice.readRun(a.run.run_id))?.cancel_requested,false);
    await assert.rejects(()=>viewer.saveArtifactRevision({...revision.revision,revision:3}));
    // Direct SQL assertions exercise RLS under a non-owner, non-superuser role.
    const c=await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('bos.user_id','alice',true),set_config('bos.workspace_id','ws_educational',true)");
      const role=await c.query<{rolsuper:boolean;rolbypassrls:boolean}>('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user');
      assert.deepEqual(role.rows[0],{rolsuper:false,rolbypassrls:false});
      assert.equal((await c.query('SELECT * FROM bos.workspace')).rows.length,1);
      assert.equal((await c.query("UPDATE bos.run SET payload=payload WHERE workspace_id='ws_other'")).rowCount,0);
      await assert.rejects(()=>c.query("INSERT INTO bos.task VALUES('ws_educational','foreign-project','prj_other')"));
      await c.query('ROLLBACK');
    } finally {c.release();}
    // A failure after snapshot creation must roll back the entire initial run.
    const bad=new PostgresStore(pool,{userId:'alice',workspaceId:'ws_educational',taskId:'missing'});
    const failed=await executePrepareDraft({...input,idempotency_key:'rollback-key'},{store:bad,root:process.cwd()});
    assert.equal(failed.outcome,'diagnostics_only');
    assert.equal((await query<{n:number}>('SELECT count(*)::int AS n FROM bos.snapshot')).rows[0]?.n,2);
    assert.ok((await query('SELECT * FROM bos.audit_event')).rows.length>0);
    if(embedded){await embedded.close(); embedded=new PGlite(dir);}
    if(network){await network.end(); /* persistence also checked by a new connection below */}
    if(native){const fresh=new Pool({connectionString:native});try{assert.equal((await fresh.query('SELECT * FROM bos.run')).rowCount,2);}finally{await fresh.end();}}
    else assert.equal((await query('SELECT * FROM bos.run')).rows.length,2);
    console.log(native?'Native PostgreSQL transport tested':'Embedded PostgreSQL/PGlite tested; TCP transport not exercised');
  } finally {
    if(embedded) await embedded.close();
    if(network && !network.ended) await network.end();
    await rm(dir,{recursive:true,force:true});
  }
});
