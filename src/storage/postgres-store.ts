import { AsyncLocalStorage } from 'node:async_hooks';
export interface SqlClient {
  query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{rows:T[];rowCount:number|null}>;
  release():void;
}
export interface SqlPool { connect():Promise<SqlClient> }

import type { RunStore } from './store.js';
import type { ArtifactRevision, IdempotencyRecord, InputSnapshot, RunRecord } from '../contract/types.js';

/** Server-only identity established by authentication; never accept this from model output or a request body. */
export interface StoreIdentity { userId: string; workspaceId: string; taskId: string }
export class PostgresStore implements RunStore {
  readonly kind = 'postgres' as const;
  readonly durableProduction = false as const;
  private readonly context = new AsyncLocalStorage<SqlClient>();
  constructor(private readonly pool: SqlPool, private readonly identity: StoreIdentity) {}

  private async transaction<T>(fn: (c: SqlClient) => Promise<T>): Promise<T> {
    const active = this.context.getStore();
    if (active) return fn(active);
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('bos.user_id',$1,true),set_config('bos.workspace_id',$2,true)", [this.identity.userId,this.identity.workspaceId]);
      const access = await c.query<{ allowed: boolean }>('SELECT bos.can_access($1,false) AS allowed',[this.identity.workspaceId]);
      if (!access.rows[0]?.allowed) throw new Error('workspace_access_denied');
      const result = await this.context.run(c,()=>fn(c));
      await c.query('COMMIT'); return result;
    } catch(e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  }
  async withIdempotencyLock<T>(hash: string, fn: ()=>Promise<T>): Promise<T> {
    let result: T;
    try {
      return await this.transaction(async c=>{
        await c.query("SET LOCAL lock_timeout='5s'");
        await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[this.identity.workspaceId+':'+hash]);
        result = await fn();
        // executePrepareDraft reports persistence failures as a value. Roll back partial writes too.
        if (typeof result==='object' && result!==null && 'outcome' in result && result.outcome==='diagnostics_only') throw new RollbackResult();
        return result;
      });
    } catch(e) { if(e instanceof RollbackResult) return result!; throw e; }
  }
  async withRunLock<T>(id:string,fn:()=>Promise<T>):Promise<T> {
    return this.transaction(async c=>{
      await c.query("SET LOCAL lock_timeout='5s'");
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[this.identity.workspaceId+':revision:'+id]);
      return fn();
    });
  }
  private async read<T>(table:string, condition:string, values:unknown[]):Promise<T|null> {
    return this.transaction(async c=>{
      const r=await c.query<{payload:T}>(`SELECT payload FROM bos.${table} WHERE workspace_id=$1 AND ${condition}`,[this.identity.workspaceId,...values]);
      return r.rows[0]?.payload??null;
    });
  }
  async saveRun(run:RunRecord):Promise<void> {
    if(run.workspace_id!==this.identity.workspaceId) throw new Error('workspace_mismatch');
    await this.transaction(async c=>{
      const task=await c.query('SELECT 1 FROM bos.task WHERE workspace_id=$1 AND id=$2 AND project_id=$3',[this.identity.workspaceId,this.identity.taskId,run.project_id]);
      if(!task.rows.length) throw new Error('task_project_mismatch');
      await c.query(`INSERT INTO bos.run VALUES($1,$2,$3,$4,$5) ON CONFLICT(workspace_id,id) DO UPDATE SET payload=jsonb_set(EXCLUDED.payload,'{cancel_requested}',to_jsonb((bos.run.payload->>'cancel_requested')::boolean OR (EXCLUDED.payload->>'cancel_requested')::boolean))`,[run.workspace_id,run.run_id,this.identity.taskId,run.workflow_version,JSON.stringify(run)]);
      for(let i=0;i<run.journal.length;i++) {
        for(const table of ['run_step','audit_event']) await c.query(`INSERT INTO bos.${table} VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,[run.workspace_id,run.run_id,i,JSON.stringify(run.journal[i])]);
      }
    });
  }
  readRun(id:string){return this.read<RunRecord>('run','id=$2',[id]);}
  async listRuns():Promise<RunRecord[]> {return this.transaction(async c=>(await c.query<{payload:RunRecord}>('SELECT payload FROM bos.run WHERE workspace_id=$1',[this.identity.workspaceId])).rows.map(r=>r.payload));}
  async saveSnapshot(s:InputSnapshot){
    if(s.input.workspace_id!==this.identity.workspaceId) throw new Error('workspace_mismatch');
    await this.transaction(async c=>{await c.query('INSERT INTO bos.snapshot VALUES($1,$2,$3)',[this.identity.workspaceId,s.run_id,JSON.stringify(s)]);});
  }
  readSnapshot(id:string){return this.read<InputSnapshot>('snapshot','run_id=$2',[id]);}
  async saveArtifactRevision(a:ArtifactRevision){await this.transaction(async c=>{
    await c.query('SAVEPOINT artifact_write');
    try {
      await c.query('INSERT INTO bos.artifact VALUES($1,$2,$3,$4,$5)',[this.identity.workspaceId,a.artifact_id,a.revision,a.run_id,JSON.stringify(a)]);
      await c.query('INSERT INTO bos.verification VALUES($1,$2,$3,$4)',[this.identity.workspaceId,a.artifact_id,a.revision,JSON.stringify(a.verification)]);
      await c.query('RELEASE SAVEPOINT artifact_write');
    } catch (error) {
      await c.query('ROLLBACK TO SAVEPOINT artifact_write');
      throw error;
    }
  });}
  readArtifactRevision(id:string,rev:number){return this.read<ArtifactRevision>('artifact','id=$2 AND revision=$3',[id,rev]);}
  async listArtifactRevisions(id:string):Promise<ArtifactRevision[]> {return this.transaction(async c=>(await c.query<{payload:ArtifactRevision}>('SELECT payload FROM bos.artifact WHERE workspace_id=$1 AND id=$2 ORDER BY revision',[this.identity.workspaceId,id])).rows.map(r=>r.payload));}
  getIdempotency(hash:string){return this.read<IdempotencyRecord>('idempotency','scope_hash=$2',[hash]);}
  async putIdempotency(r:IdempotencyRecord){
    if(r.workspace_id!==this.identity.workspaceId) throw new Error('workspace_mismatch');
    await this.transaction(async c=>{await c.query('INSERT INTO bos.idempotency VALUES($1,$2,$3,$4)',[this.identity.workspaceId,r.scope_hash,r.run_id,JSON.stringify(r)]);});
  }
  async requestCancel(id:string){await this.transaction(async c=>{await c.query(`UPDATE bos.run SET payload=jsonb_set(payload,'{cancel_requested}','true') WHERE workspace_id=$1 AND id=$2 AND payload->>'status' NOT IN ('succeeded','failed','cancelled')`,[this.identity.workspaceId,id]);});}
}
class RollbackResult extends Error {}
