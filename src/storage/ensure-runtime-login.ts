import { Pool } from 'pg';

const EDUCATIONAL_USERS = new Set(['alice', 'bob', 'viewer']);

/**
 * Create a disposable LOGIN or reuse it when the supplied password already works.
 * Never ALTER an existing cluster role or reset its password.
 */
export async function ensureRuntimeLogin(
  admin: Pool,
  name: 'alice' | 'bob' | 'viewer',
  password: string,
  databaseUrl: string,
): Promise<'created' | 'reused'> {
  if (!EDUCATIONAL_USERS.has(name)) {
    throw new Error(`refusing educational login for unexpected role ${name}`);
  }
  if (!/^[A-Za-z0-9_-]{12,128}$/.test(password)) {
    throw new Error('runtime password must be 12-128 characters from letters, digits, underscore and hyphen');
  }
  const found = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [name]);
  if ((found.rowCount ?? 0) === 0) {
    await admin.query(
      `CREATE ROLE ${name} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
    await admin.query(`GRANT bos_runtime TO ${name}`);
    return 'created';
  }

  const probeUrl = new URL(databaseUrl);
  probeUrl.username = name;
  probeUrl.password = password;
  const probe = new Pool({ connectionString: probeUrl.toString(), max: 1 });
  try {
    const client = await probe.connect();
    try {
      const who = await client.query<{ user_id: string; rolsuper: boolean; rolbypassrls: boolean }>(
        'SELECT session_user AS user_id, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = session_user',
      );
      if (who.rows[0]?.user_id !== name || who.rows[0]?.rolsuper || who.rows[0]?.rolbypassrls) {
        throw new Error(`role ${name} exists but is not a disposable educational login`);
      }
    } finally {
      client.release();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`role ${name} already exists; refusing to ALTER it (${message})`);
  } finally {
    await probe.end();
  }
  await admin.query(`GRANT bos_runtime TO ${name}`);
  return 'reused';
}
