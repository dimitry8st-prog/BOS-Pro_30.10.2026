import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import type { PrepareDraftInput } from '../contract/types.js';
import { applyMigrations } from '../storage/migrate-postgres.js';
import { PostgresStore, type SqlPool } from '../storage/postgres-store.js';
import { executePrepareDraft } from './execute.js';

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);
const RUNTIME_USERS = new Set(['alice', 'bob', 'viewer']);

function requiredUrl(name: string): URL {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  try {
    return new URL(value);
  } catch {
    throw new Error(`${name} must be a postgres URL`);
  }
}

function assertLocalEducational(url: URL, name: string): void {
  if (!LOCAL_HOSTS.has(url.hostname) || url.pathname !== '/bos_educational') {
    throw new Error(`${name} must target localhost database bos_educational`);
  }
}

function runtimePassword(url: URL): string {
  const password = decodeURIComponent(url.password);
  if (!/^[A-Za-z0-9_-]{12,128}$/.test(password)) {
    throw new Error('runtime password must be 12-128 characters from letters, digits, underscore and hyphen');
  }
  return password;
}

async function ensureLogin(admin: Pool, name: 'alice' | 'bob', password: string): Promise<void> {
  const found = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [name]);
  if ((found.rowCount ?? 0) === 0) {
    await admin.query(`CREATE ROLE ${name} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);
  } else {
    await admin.query(`ALTER ROLE ${name} WITH LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);
  }
  await admin.query(`GRANT bos_runtime TO ${name}`);
}

function safeMessage(error: unknown, secrets: string[]): string {
  let message = error instanceof Error ? error.message : 'educational postgres scenario failed';
  message = message.replace(/postgres(?:ql)?:\/\/\S+/gi, 'postgres://redacted');
  for (const secret of secrets) {
    if (secret.length > 0) message = message.split(secret).join('redacted');
  }
  return message;
}

async function main(): Promise<void> {
  if (process.env.BOS_EDUCATIONAL_DATABASE !== '1') {
    throw new Error('BOS_EDUCATIONAL_DATABASE=1 is required; educational rows are not added to a normal database');
  }
  const adminUrl = requiredUrl('BOS_MIGRATION_DATABASE_URL');
  const aliceUrl = requiredUrl('BOS_ALICE_DATABASE_URL');
  const bobUrl = requiredUrl('BOS_BOB_DATABASE_URL');
  for (const [name, url] of [
    ['BOS_MIGRATION_DATABASE_URL', adminUrl],
    ['BOS_ALICE_DATABASE_URL', aliceUrl],
    ['BOS_BOB_DATABASE_URL', bobUrl],
  ] as const) {
    assertLocalEducational(url, name);
  }
  if (RUNTIME_USERS.has(adminUrl.username)) throw new Error('migration connection must be the administrator, not a runtime user');
  if (aliceUrl.username !== 'alice' || bobUrl.username !== 'bob') throw new Error('runtime URLs must use the alice and bob logins');
  const alicePassword = runtimePassword(aliceUrl);
  const bobPassword = runtimePassword(bobUrl);
  const secrets = [alicePassword, bobPassword, decodeURIComponent(adminUrl.password)].filter((item) => item.length > 0);

  const admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
  const alice = new Pool({ connectionString: aliceUrl.toString(), max: 2 });
  const bob = new Pool({ connectionString: bobUrl.toString(), max: 1 });
  const aliceAgain = new Pool({ connectionString: aliceUrl.toString(), max: 1 });
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
    await ensureLogin(admin, 'alice', alicePassword);
    await ensureLogin(admin, 'bob', bobPassword);
    await admin.query("INSERT INTO bos.workspace VALUES ('ws_educational') ON CONFLICT DO NOTHING");
    await admin.query("INSERT INTO bos.workspace VALUES ('ws_other') ON CONFLICT DO NOTHING");
    await admin.query("INSERT INTO bos.workspace_membership VALUES ('ws_educational','alice','owner') ON CONFLICT DO NOTHING");
    await admin.query("INSERT INTO bos.workspace_membership VALUES ('ws_other','bob','owner') ON CONFLICT DO NOTHING");
    await admin.query("INSERT INTO bos.project VALUES ('ws_educational','prj_educational') ON CONFLICT DO NOTHING");
    await admin.query("INSERT INTO bos.project VALUES ('ws_other','prj_other') ON CONFLICT DO NOTHING");
    await admin.query("INSERT INTO bos.task VALUES ('ws_educational','task_educational','prj_educational') ON CONFLICT DO NOTHING");

    const input = JSON.parse(await readFile('fixtures/educational-input.json', 'utf8')) as PrepareDraftInput;
    const identity = { userId: 'alice', workspaceId: 'ws_educational', taskId: 'task_educational' };
    const store = new PostgresStore(asSqlPool(alice), identity);
    const result = await executePrepareDraft(input, { store, root: process.cwd() });
    if (result.outcome !== 'finished') throw new Error(`scenario outcome ${result.outcome}`);

    const reader = new PostgresStore(asSqlPool(aliceAgain), identity);
    const loaded = await reader.readRun(result.run.run_id);
    const artifact = result.run.artifact_id && result.run.current_revision
      ? await reader.readArtifactRevision(result.run.artifact_id, result.run.current_revision)
      : null;
    if (!loaded || !artifact) throw new Error('a new connection could not read the saved draft');

    const outsider = new PostgresStore(asSqlPool(bob), { userId: 'bob', workspaceId: 'ws_educational', taskId: 'task_educational' });
    let otherUserCanRead = false;
    let denial = 'workspace_access_denied';
    try {
      const seen = await outsider.readRun(result.run.run_id);
      otherUserCanRead = seen !== null;
      denial = seen === null ? 'hidden' : 'read_succeeded';
    } catch (error) {
      otherUserCanRead = false;
      denial = error instanceof Error && error.message.includes('workspace_access_denied') ? 'workspace_access_denied' : 'runtime_rejected';
    }
    if (otherUserCanRead) throw new Error('second user read a foreign result');
    console.log(JSON.stringify({
      run_id: loaded.run_id,
      status: loaded.status,
      verification: artifact.verification.status,
      content_hash: artifact.content_hash,
      replay: result.replay,
      other_user_can_read: false,
      denial,
    }));
  } catch (error) {
    console.error(safeMessage(error, secrets));
    process.exitCode = 1;
  } finally {
    await Promise.all([admin.end(), alice.end(), bob.end(), aliceAgain.end()]);
  }
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

if (process.argv[1]?.endsWith('educational-postgres.js') === true) {
  await main();
}
