import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import type { PrepareDraftInput } from '../contract/types.js';
import { ensureRuntimeLogin } from '../storage/ensure-runtime-login.js';
import { applyMigrations } from '../storage/migrate-postgres.js';
import type { SqlPool } from '../storage/postgres-store.js';
import { LocalHttpServer } from './local-http.js';
import { LocalSessions } from './local-sessions.js';
import { LocalTaskApi } from './local-task-api.js';

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);
const DB_NAME = '/bos_http_demo';

function requiredUrl(name: string): URL {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  try {
    return new URL(value);
  } catch {
    throw new Error(`${name} must be a postgres URL`);
  }
}

function assertLocalDemo(url: URL, name: string): void {
  if (!LOCAL_HOSTS.has(url.hostname) || url.pathname !== DB_NAME) {
    throw new Error(`${name} must target localhost database bos_http_demo`);
  }
}

function runtimePassword(url: URL): string {
  const password = decodeURIComponent(url.password);
  if (!/^[A-Za-z0-9_-]{12,128}$/.test(password)) {
    throw new Error('runtime password must be 12-128 characters from letters, digits, underscore and hyphen');
  }
  return password;
}

function asSqlPool(pool: Pool): SqlPool {
  return {
    async connect() {
      const client = await pool.connect();
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

function safeMessage(error: unknown, secrets: string[]): string {
  let message = error instanceof Error ? error.message : 'http demo failed';
  message = message.replace(/postgres(?:ql)?:\/\/\S+/gi, 'postgres://redacted');
  for (const secret of secrets) {
    if (secret.length > 0) message = message.split(secret).join('redacted');
  }
  return message;
}

async function postJson(
  base: string,
  token: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}/api/v1/dispatch`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`invalid_http_json:${response.status}`);
  }
  return { status: response.status, body: parsed };
}

async function main(): Promise<void> {
  if (process.env.BOS_HTTP_DEMO_DATABASE !== '1') {
    throw new Error('BOS_HTTP_DEMO_DATABASE=1 is required; demo rows are not added to a normal database');
  }
  const adminUrl = requiredUrl('BOS_MIGRATION_DATABASE_URL');
  const aliceUrl = requiredUrl('BOS_ALICE_DATABASE_URL');
  assertLocalDemo(adminUrl, 'BOS_MIGRATION_DATABASE_URL');
  assertLocalDemo(aliceUrl, 'BOS_ALICE_DATABASE_URL');
  if (aliceUrl.username !== 'alice') throw new Error('BOS_ALICE_DATABASE_URL must use the alice login');
  const alicePassword = runtimePassword(aliceUrl);
  const secrets = [alicePassword, decodeURIComponent(adminUrl.password)].filter((item) => item.length > 0);

  const admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
  const alicePool = new Pool({ connectionString: aliceUrl.toString(), max: 4 });
  const sessions = new LocalSessions();
  let server: LocalHttpServer | null = null;
  let token: string | null = null;
  try {
    const client = await admin.connect();
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
    await ensureRuntimeLogin(admin, 'alice', alicePassword, aliceUrl.toString());
    await admin.query("INSERT INTO bos.workspace VALUES ('ws_educational') ON CONFLICT DO NOTHING");
    await admin.query("INSERT INTO bos.workspace_membership VALUES ('ws_educational','alice','owner') ON CONFLICT DO NOTHING");
    await admin.query("INSERT INTO bos.project VALUES ('ws_educational','prj_educational') ON CONFLICT DO NOTHING");

    const api = new LocalTaskApi(sessions, (userId) => {
      if (userId !== 'alice') throw new Error('unmapped_identity');
      return asSqlPool(alicePool);
    }, process.cwd());
    server = new LocalHttpServer({ api });
    const listen = await server.listen();
    const base = `http://127.0.0.1:${listen.port}`;
    token = sessions.issue({ userId: 'alice', workspaceId: 'ws_educational' });

    const health = await fetch(`${base}/health`);
    if (health.status !== 200) throw new Error(`health_failed:${health.status}`);

    const fixture = JSON.parse(await readFile('fixtures/educational-input.json', 'utf8')) as PrepareDraftInput;
    const { workspace_id: _workspace, ...input } = fixture;
    const taskId = 'http_demo_task';
    const created = await postJson(base, token, {
      operation: 'create_task',
      task_id: taskId,
      project_id: 'prj_educational',
    });
    if (created.status !== 201 && created.status !== 200) throw new Error(`create_task:${created.status}`);

    const prepareBody = {
      operation: 'prepare_draft',
      task_id: taskId,
      input: { ...input, idempotency_key: 'http-demo-key-01' },
    };
    const prepared = await postJson(base, token, prepareBody);
    if (prepared.status !== 201 && prepared.status !== 200) throw new Error(`prepare_draft:${prepared.status}`);
    const runId = String(prepared.body.run_id ?? '');
    if (!runId) throw new Error('missing_run_id');

    const replay = await postJson(base, token, prepareBody);
    if (replay.status !== 200 || replay.body.replay !== true || replay.body.run_id !== runId) {
      throw new Error('idempotency_replay_failed');
    }

    const read = await postJson(base, token, { operation: 'read_result', run_id: runId });
    if (read.status !== 200) throw new Error(`read_result:${read.status}`);

    const revised = await postJson(base, token, {
      operation: 'revise_draft',
      run_id: runId,
      text: 'Демонстрационная правка требует новой проверки фактов.',
    });
    if (revised.status !== 200 || revised.body.quality_gate !== 'blocked') {
      throw new Error(`revise_draft:${revised.status}:${String(revised.body.quality_gate)}`);
    }
    const artifact = revised.body.artifact as { revision?: number } | null;
    const revision = artifact?.revision;
    if (typeof revision !== 'number' || revision < 2) throw new Error('revision_not_advanced');

    sessions.revoke(token);
    token = null;
    const denied = await postJson(base, 'a'.repeat(43), { operation: 'read_result', run_id: runId });
    // fabricated token is rejected; revoked original also returns 401
    if (denied.status !== 401) throw new Error(`revoked_or_fabricated:${denied.status}`);

    console.log(JSON.stringify({
      ok: true,
      create_status: created.status,
      prepare_status: prepared.status,
      run_id: runId,
      replay: true,
      read_status: read.status,
      revision,
      quality_gate: revised.body.quality_gate,
      listen: { host: listen.host, port: listen.port },
    }));
  } catch (error) {
    console.error(safeMessage(error, secrets));
    process.exitCode = 1;
  } finally {
    if (token) sessions.revoke(token);
    if (server) await server.close().catch(() => undefined);
    await Promise.all([admin.end(), alicePool.end()]);
  }
}

if (process.argv[1]?.endsWith('demo-http.js') === true) {
  await main();
}
