import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { Pool } from 'pg';
import type { PrepareDraftInput } from '../src/contract/types.js';
import { executePrepareDraft } from '../src/scenario/execute.js';
import { recoverInterruptedRuns } from '../src/scenario/recover.js';
import { reviseDraft } from '../src/scenario/revise.js';
import { applyMigrations, migrationChecksums, type MigrationDb } from '../src/storage/migrate-postgres.js';
import { migratePostgres } from '../src/storage/migrate-postgres.js';
import { PostgresStore, type SqlPool } from '../src/storage/postgres-store.js';

/** Disposable password for test login roles. Already used by CI. Not a service secret. */
const TEST_PASSWORD = 'bos_disposable_test_only';
const USERS = ['alice', 'bob', 'viewer'] as const;

test('PostgreSQL session identity, RLS, rollback, revisions and idempotency', async () => {
  const native = process.env.BOS_TEST_DATABASE_URL;
  const dir = await mkdtemp(path.join(tmpdir(), 'bos-pg-'));
  let embedded: PGlite | null = native ? null : new PGlite(dir);
  const admin = native ? new Pool({ connectionString: native, max: 4 }) : null;
  const nativePools: Pool[] = [];
  let embeddedAuth: 'postgres' | (typeof USERS)[number] = 'postgres';
  let tail = Promise.resolve();
  const lock = (): Promise<() => void> => {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => { release = resolve; });
    return previous.then(() => release);
  };
  // PGlite does not reliably RESET SESSION AUTHORIZATION back to the superuser.
  // Reopening the same data directory restores a postgres session without dropping rows.
  const reopenEmbeddedAsPostgres = async (): Promise<void> => {
    await embedded!.close();
    embedded = new PGlite(dir);
    embeddedAuth = 'postgres';
    const session = await embedded.query<{ user_id: string }>('SELECT session_user AS user_id');
    if (session.rows[0]?.user_id !== 'postgres') {
      throw new Error(`embedded reopen session_user=${session.rows[0]?.user_id ?? ''}`);
    }
  };
  const ensureEmbeddedAuth = async (user: 'postgres' | (typeof USERS)[number]): Promise<void> => {
    if (embeddedAuth === user) return;
    if (embeddedAuth !== 'postgres') await reopenEmbeddedAsPostgres();
    if (user !== 'postgres') {
      await embedded!.query(`SET SESSION AUTHORIZATION ${user}`);
      embeddedAuth = user;
    }
  };
  const adminQuery = async <T extends Record<string, unknown>>(sql: string, values: unknown[] = []): Promise<{ rows: T[]; rowCount: number | null }> => {
    if (admin) {
      const result = await admin.query<T>(sql, values);
      return { rows: result.rows, rowCount: result.rowCount };
    }
    const unlock = await lock();
    try {
      await ensureEmbeddedAuth('postgres');
      const result = await embedded!.query<T>(sql, values);
      return { rows: result.rows, rowCount: result.affectedRows ?? null };
    } finally {
      unlock();
    }
  };
  const userPool = (user: (typeof USERS)[number] | 'postgres'): SqlPool => {
    if (native && user !== 'postgres') {
      const url = new URL(native);
      url.username = user;
      url.password = TEST_PASSWORD;
      const net = new Pool({ connectionString: url.toString(), max: 4 });
      nativePools.push(net);
      return {
        async connect() {
          const client = await net.connect();
          return {
            async query<T extends Record<string, unknown>>(sql: string, values?: unknown[]) {
              const result = await client.query<T>(sql, values);
              return { rows: result.rows, rowCount: result.rowCount };
            },
            release() { client.release(); },
          };
        },
      };
    }
    return {
      async connect() {
        if (admin && user === 'postgres') {
          const client = await admin.connect();
          return {
            async query<T extends Record<string, unknown>>(sql: string, values?: unknown[]) {
              const result = await client.query<T>(sql, values);
              return { rows: result.rows, rowCount: result.rowCount };
            },
            release() { client.release(); },
          };
        }
        const unlock = await lock();
        try {
          await ensureEmbeddedAuth(user);
          return {
            async query<T extends Record<string, unknown>>(sql: string, values?: unknown[]) {
              const result = await embedded!.query<T>(sql, values);
              return { rows: result.rows, rowCount: result.affectedRows ?? null };
            },
            release() { unlock(); },
          };
        } catch (error) {
          unlock();
          throw error;
        }
      },
    };
  };
  try {
    if (admin) {
      await migratePostgres(admin);
      await migratePostgres(admin);
    } else {
      await applyMigrations({
        async query<T extends Record<string, unknown>>(sql: string, values?: unknown[]) {
          const result = await embedded!.query<T>(sql, values);
          return { rows: result.rows, rowCount: result.affectedRows ?? null };
        },
        exec: async (sql) => { await embedded!.exec(sql); },
      });
      await applyMigrations({
        async query<T extends Record<string, unknown>>(sql: string, values?: unknown[]) {
          const result = await embedded!.query<T>(sql, values);
          return { rows: result.rows, rowCount: result.affectedRows ?? null };
        },
        exec: async (sql) => { await embedded!.exec(sql); },
      });
    }
    const versions = await adminQuery<{ version: string }>('SELECT version FROM public.bos_schema_migration ORDER BY version');
    assert.deepEqual(versions.rows.map((row) => row.version), ['001', '002']);
    for (const name of USERS) {
      const found = await adminQuery('SELECT 1 FROM pg_roles WHERE rolname = $1', [name]);
      if (found.rows.length === 0) {
        await adminQuery(`CREATE ROLE ${name} LOGIN PASSWORD '${TEST_PASSWORD}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);
      } else {
        await adminQuery(`ALTER ROLE ${name} WITH LOGIN PASSWORD '${TEST_PASSWORD}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);
      }
      await adminQuery(`GRANT bos_runtime TO ${name}`);
    }
    await adminQuery("INSERT INTO bos.workspace VALUES ('ws_educational'),('ws_other')");
    await adminQuery("INSERT INTO bos.workspace_membership VALUES ('ws_educational','alice','owner'),('ws_other','bob','owner'),('ws_educational','viewer','viewer')");
    await adminQuery("INSERT INTO bos.project VALUES ('ws_educational','prj_educational'),('ws_other','prj_other')");
    await adminQuery("INSERT INTO bos.task VALUES ('ws_educational','task1','prj_educational'),('ws_other','task2','prj_other')");
    const alice = new PostgresStore(userPool('alice'), { userId: 'alice', workspaceId: 'ws_educational', taskId: 'task1' });
    const input = JSON.parse(await readFile('fixtures/educational-input.json', 'utf8')) as PrepareDraftInput;
    const invoke = () => executePrepareDraft(input, { store: alice, root: process.cwd() });
    const [first, second] = await Promise.all([invoke(), invoke()]);
    if (first.outcome !== 'finished' || second.outcome !== 'finished') {
      throw new Error(`concurrent runs: ${JSON.stringify([first, second])}`);
    }
    assert.equal(first.run.status, 'succeeded');
    assert.equal(first.run.run_id, second.run.run_id);
    assert.equal((await alice.listRuns()).length, 1);
    const conflict = await executePrepareDraft({ ...input, topic: 'different' }, { store: alice, root: process.cwd() });
    assert.equal(conflict.outcome, 'conflict');
    const revision = await reviseDraft(alice, first.run.run_id, 'Луна изготовлена из сыра.');
    assert.equal(revision.outcome, 'revised');
    if (revision.outcome !== 'revised') throw new Error('revision');
    assert.equal(revision.run.quality_gate, 'blocked');
    assert.equal((await alice.listArtifactRevisions(first.run.artifact_id!)).length, 2);
    await assert.rejects(() => alice.saveArtifactRevision(revision.revision));
    const parallel = await Promise.all([
      reviseDraft(alice, first.run.run_id, 'Первая параллельная правка без прежних связей.'),
      reviseDraft(alice, first.run.run_id, 'Вторая параллельная правка без прежних связей.'),
    ]);
    assert.deepEqual(parallel.map((item) => item.outcome).sort(), ['revised', 'revised']);
    const revisions = await alice.listArtifactRevisions(first.run.artifact_id!);
    assert.deepEqual(revisions.map((item) => item.revision), [1, 2, 3, 4]);
    const bob = new PostgresStore(userPool('bob'), { userId: 'bob', workspaceId: 'ws_other', taskId: 'task2' });
    assert.equal(await bob.readRun(first.run.run_id), null);
    assert.equal(await bob.readArtifactRevision(first.run.artifact_id!, 1), null);
    assert.deepEqual(await bob.listRuns(), []);
    const bobRun = await executePrepareDraft({ ...input, workspace_id: 'ws_other', project_id: 'prj_other' }, { store: bob, root: process.cwd() });
    assert.equal(bobRun.outcome, 'finished');
    if (bobRun.outcome !== 'finished') throw new Error('bob run');
    assert.equal(await alice.readRun(bobRun.run.run_id), null);
    const impostor = new PostgresStore(userPool('alice'), { userId: 'bob', workspaceId: 'ws_educational', taskId: 'task1' });
    await assert.rejects(() => impostor.listRuns(), /runtime_role_rejected/);
    const elevated = new PostgresStore(userPool('postgres'), { userId: 'postgres', workspaceId: 'ws_educational', taskId: 'task1' });
    await assert.rejects(() => elevated.listRuns(), /runtime_role_rejected/);
    const viewer = new PostgresStore(userPool('viewer'), { userId: 'viewer', workspaceId: 'ws_educational', taskId: 'task1' });
    assert.equal((await viewer.listRuns()).length, 1);
    await viewer.requestCancel(first.run.run_id);
    assert.equal((await alice.readRun(first.run.run_id))?.cancel_requested, false);
    await assert.rejects(() => viewer.saveArtifactRevision({ ...revision.revision, revision: 9 }));
    const connection = await userPool('alice').connect();
    try {
      await connection.query('BEGIN');
      await connection.query("SELECT set_config('bos.workspace_id','ws_educational',true)");
      const role = await connection.query<{ user_id: string; rolsuper: boolean; rolbypassrls: boolean }>('SELECT session_user AS user_id, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = session_user');
      assert.equal(role.rows[0]?.user_id, 'alice');
      assert.equal(role.rows[0]?.rolsuper, false);
      assert.equal(role.rows[0]?.rolbypassrls, false);
      const owner = await connection.query<{ owner: string }>("SELECT pg_get_userbyid(c.relowner) AS owner FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'bos' AND c.relname = 'run' AND c.relkind = 'r'");
      assert.notEqual(owner.rows[0]?.owner, 'alice');
      assert.equal((await connection.query('SELECT * FROM bos.workspace')).rows.length, 1);
      await connection.query("SELECT set_config('bos.user_id','bob',true), set_config('bos.workspace_id','ws_other',true)");
      assert.equal((await connection.query('SELECT * FROM bos.run')).rows.length, 0);
      await assert.rejects(() => connection.query("INSERT INTO bos.task VALUES ('ws_educational','foreign-project','prj_other')"));
      await connection.query('ROLLBACK');
    } finally {
      connection.release();
    }
    const refused = await executePrepareDraft({ ...input, idempotency_key: 'refuse-key-01' }, { store: alice, root: process.cwd(), providerVariant: 'refuse' });
    assert.equal(refused.outcome, 'finished');
    if (refused.outcome !== 'finished') throw new Error('refuse');
    assert.equal(refused.run.status, 'failed');
    assert.equal(refused.run.stop?.code, 'provider_refused');
    assert.equal(refused.run.journal.some((entry) => entry.step === 'provider' && entry.error_code === 'provider_refused'), true);
    const cancelled = await executePrepareDraft({ ...input, idempotency_key: 'cancel-key-01' }, { store: alice, root: process.cwd(), onStep: async (step, runId) => { if (step === 'before_provider') await alice.requestCancel(runId); } });
    assert.equal(cancelled.outcome, 'finished');
    if (cancelled.outcome !== 'finished') throw new Error('cancel');
    assert.equal(cancelled.run.status, 'cancelled');
    assert.equal(cancelled.run.stop?.code, 'cancelled_by_user');
    const interrupted = await executePrepareDraft({ ...input, idempotency_key: 'interrupt-key01' }, { store: alice, root: process.cwd(), interruptAfter: 'running' });
    assert.equal(interrupted.outcome, 'interrupted');
    const recovered = (await recoverInterruptedRuns(alice)).find((run) => run.idempotency_key === 'interrupt-key01');
    assert.equal(recovered?.status, 'failed');
    assert.equal(recovered?.stop?.code, 'interrupted');
    assert.equal(recovered?.recovery?.previous_status, 'running');
    assert.equal(recovered?.journal.some((entry) => entry.step === 'recover'), true);
    const racing = await executePrepareDraft({ ...input, idempotency_key: 'cancel-race-01' }, { store: alice, root: process.cwd(), interruptAfter: 'running' });
    assert.equal(racing.outcome, 'interrupted');
    if (racing.outcome !== 'interrupted') throw new Error('cancel race');
    await Promise.all([
      alice.requestCancel(racing.run.run_id),
      alice.saveRun({ ...racing.run, cancel_requested: false }),
    ]);
    assert.equal((await alice.readRun(racing.run.run_id))?.cancel_requested, true);
    try {
      const cleared = await adminQuery("UPDATE bos.run SET payload = jsonb_set(payload, '{cancel_requested}', 'false') WHERE id = $1", [racing.run.run_id]);
      const who = await adminQuery<{ user_id: string }>("SELECT session_user AS user_id");
      const visible = await adminQuery<{ n: number }>('SELECT count(*)::int AS n FROM bos.run WHERE id = $1', [racing.run.run_id]);
      throw new Error(`cancel update rows=${String(cleared.rowCount)} user=${who.rows[0]?.user_id ?? ''} visible=${String(visible.rows[0]?.n)}`);
    } catch (error) {
      assert.match(error instanceof Error ? error.message : '', /cancel_requested is permanent/);
    }
    await assert.rejects(
      () => adminQuery('UPDATE bos.artifact SET payload = payload WHERE id = $1 AND revision = 1', [first.run.artifact_id]),
      /artifact_revision_immutable/,
    );
    const faulty = new PostgresStore(userPool('alice'), { userId: 'alice', workspaceId: 'ws_educational', taskId: 'task1' });
    faulty.saveArtifactRevision = async () => { throw new Error('simulated write failure'); };
    const broken = await executePrepareDraft({ ...input, idempotency_key: 'storage-key-01' }, { store: faulty, root: process.cwd() });
    assert.equal(broken.outcome, 'finished');
    if (broken.outcome !== 'finished') throw new Error('storage');
    assert.equal(broken.run.status, 'failed');
    assert.equal(broken.run.stop?.code, 'storage_error');
    assert.equal(broken.run.artifact_id, null);
    assert.equal((await adminQuery<{ n: number }>('SELECT count(*)::int AS n FROM bos.artifact WHERE run_id = $1', [broken.run.run_id])).rows[0]?.n, 0);
    const injected = await executePrepareDraft({ ...input, idempotency_key: 'body-user-01', user_id: 'bob' }, { store: alice, root: process.cwd() });
    assert.equal(injected.outcome, 'rejected');
    if (injected.outcome !== 'rejected') throw new Error('user');
    assert.equal(injected.error.code, 'unknown_field');
    assert.equal(injected.error.field, 'user_id');
    const bad = new PostgresStore(userPool('alice'), { userId: 'alice', workspaceId: 'ws_educational', taskId: 'missing' });
    const failed = await executePrepareDraft({ ...input, idempotency_key: 'rollback-key' }, { store: bad, root: process.cwd() });
    assert.equal(failed.outcome, 'diagnostics_only');
    assert.equal((await adminQuery<{ n: number }>('SELECT count(*)::int AS n FROM bos.snapshot')).rows[0]?.n, 7);
    // Payload must stay consistent with key columns; NULL/missing status and mismatched ids are rejected.
    await assert.rejects(
      () => adminQuery(
        `INSERT INTO bos.run VALUES ('ws_educational','run_bad_status','task1','prepare_draft_educational/0.1.0','{"run_id":"run_bad_status","workspace_id":"ws_educational"}'::jsonb)`,
      ),
      /check|violates|status/i,
    );
    await assert.rejects(
      () => adminQuery(
        `INSERT INTO bos.run VALUES ('ws_educational','run_bad_id','task1','prepare_draft_educational/0.1.0','{"run_id":"other","workspace_id":"ws_educational","status":"queued"}'::jsonb)`,
      ),
      /check|violates/i,
    );
    // Failure between artifact insert and verification must not leave a partial revision.
    // PostgresStore uses the same SAVEPOINT pattern around artifact + verification writes.
    const aliceSql = await userPool('alice').connect();
    try {
      await aliceSql.query('BEGIN');
      await aliceSql.query("SELECT set_config('bos.workspace_id','ws_educational',true)");
      await aliceSql.query('SAVEPOINT artifact_write');
      try {
        await aliceSql.query(
          'INSERT INTO bos.artifact VALUES ($1,$2,$3,$4,$5)',
          ['ws_educational', first.run.artifact_id, 90, first.run.run_id, JSON.stringify({ artifact_id: first.run.artifact_id, revision: 90 })],
        );
        await aliceSql.query('SELECT 1/0');
      } catch {
        await aliceSql.query('ROLLBACK TO SAVEPOINT artifact_write');
      }
      await aliceSql.query('COMMIT');
    } finally {
      aliceSql.release();
    }
    assert.equal((await adminQuery<{ n: number }>('SELECT count(*)::int AS n FROM bos.artifact WHERE revision = 90')).rows[0]?.n, 0);
    // GUC identity spoofing must not grant another user's rows on a real login.
    const spoof = await userPool('alice').connect();
    try {
      await spoof.query('BEGIN');
      await spoof.query("SELECT set_config('bos.user_id','bob',true), set_config('bos.workspace_id','ws_other',true)");
      assert.equal((await spoof.query('SELECT * FROM bos.run')).rows.length, 0);
      const access = await spoof.query<{ allowed: boolean }>('SELECT bos.can_access($1,false) AS allowed', ['ws_other']);
      assert.equal(access.rows[0]?.allowed, false);
      await spoof.query('ROLLBACK');
    } finally {
      spoof.release();
    }
    const audit = await adminQuery<{ actor: string; body: string }>('SELECT payload->>\'actor_user_id\' AS actor, payload::text AS body FROM bos.audit_event WHERE run_id = $1', [first.run.run_id]);
    assert.ok(audit.rows.length > 0);
    for (const row of audit.rows) {
      assert.equal(row.actor, 'alice');
      assert.equal(row.body.includes('postgres://'), false);
      assert.equal(row.body.includes(TEST_PASSWORD), false);
      assert.equal(row.body.includes('provided_text'), false);
    }
    if (embedded) {
      await embedded.close();
      embedded = new PGlite(dir);
      embeddedAuth = 'postgres';
    }
    if (native) {
      const fresh = new Pool({ connectionString: native, max: 1 });
      try {
        assert.equal((await fresh.query('SELECT * FROM bos.run')).rowCount, 7);
      } finally {
        await fresh.end();
      }
      const url = new URL(native);
      url.username = 'alice';
      url.password = TEST_PASSWORD;
      const reread = new Pool({ connectionString: url.toString(), max: 1 });
      try {
        const reader = new PostgresStore({
          async connect() {
            const client = await reread.connect();
            return {
              async query<T extends Record<string, unknown>>(sql: string, values?: unknown[]) {
                const result = await client.query<T>(sql, values);
                return { rows: result.rows, rowCount: result.rowCount };
              },
              release() { client.release(); },
            };
          },
        }, { userId: 'alice', workspaceId: 'ws_educational', taskId: 'task1' });
        assert.equal((await reader.listRuns()).length, 6);
        assert.equal((await reader.readRun(first.run.run_id))?.status, 'succeeded');
      } finally {
        await reread.end();
      }
    } else {
      assert.equal((await adminQuery('SELECT * FROM bos.run')).rows.length, 7);
      const reader = new PostgresStore(userPool('alice'), { userId: 'alice', workspaceId: 'ws_educational', taskId: 'task1' });
      assert.equal((await reader.listRuns()).length, 6);
    }
    console.log(native ? 'Native PostgreSQL transport tested' : 'Embedded PostgreSQL/PGlite tested; TCP transport not exercised');
  } finally {
    if (embedded) await embedded.close().catch(() => undefined);
    await Promise.all(nativePools.map((pool) => pool.end().catch(() => undefined)));
    if (admin) await admin.end().catch(() => undefined);
    // Windows can leave transient files under PGlite's data dir after close.
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

test('historical migration 001 upgrades without deleting rows or disabling checksums', async () => {
  const sums = await migrationChecksums();
  const historical = sums.historical001[0];
  assert.ok(historical);
  assert.equal(sums.accepted001.has(historical), true);
  const dir = await mkdtemp(path.join(tmpdir(), 'bos-upgrade-'));
  const embedded = new PGlite(dir);
  try {
    const history = await readFile('migrations/history/001_core_516fc5a.sql', 'utf8');
    await embedded.exec(history);
    await embedded.exec(`CREATE TABLE public.bos_schema_migration(version text PRIMARY KEY, sha256 text NOT NULL);
      INSERT INTO public.bos_schema_migration VALUES ('001', '${historical}');
      INSERT INTO bos.workspace VALUES ('upgrade-marker');`);
    await applyMigrations(pgliteDb(embedded));
    const marker = await embedded.query<{ id: string }>("SELECT id FROM bos.workspace WHERE id = 'upgrade-marker'");
    assert.equal(marker.rows[0]?.id, 'upgrade-marker');
    const definition = await embedded.query<{ def: string }>("SELECT pg_get_functiondef('bos.can_access(text,boolean)'::regprocedure) AS def");
    assert.equal(definition.rows[0]?.def.includes('session_user'), true);
    assert.equal(definition.rows[0]?.def.includes("current_setting('bos.user_id'"), false);
    const stored = await embedded.query<{ version: string; sha256: string }>('SELECT version, sha256 FROM public.bos_schema_migration ORDER BY version');
    assert.equal(stored.rows[0]?.version, '001');
    assert.equal(stored.rows[0]?.sha256, historical);
    assert.equal(stored.rows[1]?.version, '002');
  } finally {
    await embedded.close().catch(() => undefined);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }

  const wrongDir = await mkdtemp(path.join(tmpdir(), 'bos-checksum-'));
  const wrong = new PGlite(wrongDir);
  try {
    const badHash = 'f'.repeat(64);
    await wrong.exec(await readFile('migrations/001_core.sql', 'utf8'));
    await wrong.exec(`CREATE TABLE public.bos_schema_migration(version text PRIMARY KEY, sha256 text NOT NULL);
      INSERT INTO public.bos_schema_migration VALUES ('001', '${badHash}');
      INSERT INTO bos.workspace VALUES ('keep-me');`);
    await assert.rejects(() => applyMigrations(pgliteDb(wrong)), /migration_checksum_mismatch/);
    const marker = await wrong.query<{ id: string }>("SELECT id FROM bos.workspace WHERE id = 'keep-me'");
    assert.equal(marker.rows[0]?.id, 'keep-me');
    const unchanged = await wrong.query<{ sha256: string }>("SELECT sha256 FROM public.bos_schema_migration WHERE version = '001'");
    assert.equal(unchanged.rows[0]?.sha256, badHash);
    const definition = await wrong.query<{ def: string }>("SELECT pg_get_functiondef('bos.can_access(text,boolean)'::regprocedure) AS def");
    assert.equal(definition.rows[0]?.def.includes("current_setting('bos.user_id'"), true);
  } finally {
    await wrong.close().catch(() => undefined);
    await rm(wrongDir, { recursive: true, force: true }).catch(() => undefined);
  }

  const native = process.env.BOS_TEST_DATABASE_URL;
  if (!native) {
    console.log('Native upgrade skipped: BOS_TEST_DATABASE_URL is not set');
    return;
  }
  const source = new URL(native);
  if ((source.hostname !== '127.0.0.1' && source.hostname !== 'localhost') || source.pathname === '/bos_upgrade_test') {
    console.log('Native upgrade skipped: database is not a local disposable target');
    return;
  }
  const maintenance = new URL(native);
  maintenance.pathname = '/postgres';
  const maintainer = new Pool({ connectionString: maintenance.toString(), max: 1 });
  try {
    await maintainer.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'bos_upgrade_test' AND pid <> pg_backend_pid()");
    await maintainer.query('DROP DATABASE IF EXISTS bos_upgrade_test');
    await maintainer.query('CREATE DATABASE bos_upgrade_test');
  } finally {
    await maintainer.end();
  }
  const upgradeUrl = new URL(native);
  upgradeUrl.pathname = '/bos_upgrade_test';
  const upgrade = new Pool({ connectionString: upgradeUrl.toString(), max: 1 });
  try {
    const current = await readFile('migrations/001_core.sql', 'utf8');
    await upgrade.query(current);
    await upgrade.query('CREATE TABLE public.bos_schema_migration(version text PRIMARY KEY, sha256 text NOT NULL)');
    await upgrade.query('INSERT INTO public.bos_schema_migration VALUES ($1, $2)', ['001', historical]);
    await upgrade.query("INSERT INTO bos.workspace VALUES ('native-upgrade-marker')");
    await applyMigrations({
      async query<T extends Record<string, unknown>>(sql: string, values?: unknown[]) {
        const result = await upgrade.query<T>(sql, values ?? []);
        return { rows: result.rows, rowCount: result.rowCount };
      },
    });
    const marker = await upgrade.query<{ id: string }>("SELECT id FROM bos.workspace WHERE id = 'native-upgrade-marker'");
    assert.equal(marker.rows[0]?.id, 'native-upgrade-marker');
    const stored = await upgrade.query<{ version: string; sha256: string }>('SELECT version, sha256 FROM public.bos_schema_migration ORDER BY version');
    assert.equal(stored.rows[0]?.sha256, historical);
    assert.equal(stored.rows[1]?.version, '002');
    const definition = await upgrade.query<{ def: string }>("SELECT pg_get_functiondef('bos.can_access(text,boolean)'::regprocedure) AS def");
    assert.equal(definition.rows[0]?.def.includes('session_user'), true);
    console.log('Native PostgreSQL upgrade from migration 001 tested');
  } finally {
    await upgrade.end();
  }
});

function pgliteDb(db: PGlite): MigrationDb {
  return {
    async query<T extends Record<string, unknown>>(sql: string, values?: unknown[]) {
      const result = await db.query<T>(sql, values);
      return { rows: result.rows, rowCount: result.affectedRows ?? null };
    },
    async exec(sql: string) {
      await db.exec(sql);
    },
  };
}
