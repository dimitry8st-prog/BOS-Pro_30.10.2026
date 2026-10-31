import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { EDUCATIONAL_WORKFLOW_VERSION_ID, RULES_VERSION, SCENARIO_VERSION } from "../contract/constants.js";
import { ensureCluster } from "./cluster.js";
import { LOCAL_DATABASE, LOCAL_HOST, LOCAL_PORT, localPassword } from "./local-test.js";
import { migrate } from "./migrate.js";

const ROLE_PASSWORD = /^[a-z0-9_]+$/;

export async function bootstrapLocalDatabase(): Promise<void> {
  await ensureCluster();
  await ensureRoles();
  await ensureDatabase();
  await migrate();
  await seed();
}

export async function resetEducationalDatabase(): Promise<void> {
  await ensureCluster();
  await ensureRoles();
  const admin = await postgresClient("postgres");
  try {
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [LOCAL_DATABASE],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${LOCAL_DATABASE}`);
    await admin.query(`CREATE DATABASE ${LOCAL_DATABASE} OWNER bos_owner`);
  } finally {
    await admin.end();
  }
  await migrate();
  await seed();
}

async function ensureRoles(): Promise<void> {
  const admin = await postgresClient("postgres");
  try {
    await ensureRole(admin, "bos_owner", localPassword("bos_owner"), "LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE");
    await ensureRole(admin, "bos_member", null, "NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE");
    await ensureRole(admin, "usr_educational", localPassword("usr_educational"), "LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE");
    await ensureRole(admin, "usr_other", localPassword("usr_other"), "LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE");
    await admin.query("GRANT bos_member TO usr_educational");
    await admin.query("GRANT bos_member TO usr_other");
  } finally {
    await admin.end();
  }
}

async function ensureRole(admin: pg.Client, name: string, password: string | null, attributes: string): Promise<void> {
  if (!/^[a-z_]+$/.test(name)) throw new Error("Недопустимое имя учебной роли.");
  const passwordSql = password === null ? "" : ` PASSWORD '${checkedPassword(password)}'`;
  const found = await admin.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [name]);
  if ((found.rowCount ?? 0) === 0) {
    await admin.query(`CREATE ROLE ${name}${passwordSql} ${attributes}`);
    return;
  }
  await admin.query(`ALTER ROLE ${name} WITH ${attributes}${passwordSql}`);
}

function checkedPassword(password: string): string {
  if (!ROLE_PASSWORD.test(password)) throw new Error("Учебный пароль содержит недопустимый символ.");
  return password;
}

async function ensureDatabase(): Promise<void> {
  const admin = await postgresClient("postgres");
  try {
    const found = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [LOCAL_DATABASE]);
    if ((found.rowCount ?? 0) === 0) {
      await admin.query(`CREATE DATABASE ${LOCAL_DATABASE} OWNER bos_owner`);
    }
  } finally {
    await admin.end();
  }
}

async function seed(): Promise<void> {
  const admin = await postgresClient(LOCAL_DATABASE);
  try {
    await admin.query(
      `INSERT INTO workspace (id, name, created_at) VALUES
         ('ws_educational', 'Учебный workspace', now()),
         ('ws_other', 'Чужой workspace', now())
       ON CONFLICT (id) DO NOTHING`,
    );
    await admin.query(
      `INSERT INTO workspace_membership (workspace_id, user_id, role, created_at) VALUES
         ('ws_educational', 'usr_educational', 'owner', now()),
         ('ws_other', 'usr_other', 'owner', now())
       ON CONFLICT (workspace_id, user_id) DO NOTHING`,
    );
    await admin.query(
      `INSERT INTO project (id, workspace_id, name, created_at) VALUES
         ('prj_educational', 'ws_educational', 'Учебный проект', now()),
         ('prj_other', 'ws_other', 'Чужой проект', now())
       ON CONFLICT (id) DO NOTHING`,
    );
    await admin.query(
      `INSERT INTO workflow_version (id, workspace_id, scenario_version, rules_version, definition, created_at) VALUES
         ($1, 'ws_educational', $2, $3, $4::jsonb, now()),
         ($1, 'ws_other', $2, $3, $4::jsonb, now())
       ON CONFLICT (id, workspace_id) DO NOTHING`,
      [
        EDUCATIONAL_WORKFLOW_VERSION_ID,
        SCENARIO_VERSION,
        RULES_VERSION,
        JSON.stringify({ scenario_version: SCENARIO_VERSION, rules_version: RULES_VERSION, immutable: true }),
      ],
    );
  } finally {
    await admin.end();
  }
}

async function postgresClient(database: string): Promise<pg.Client> {
  const client = new pg.Client({
    host: LOCAL_HOST,
    port: LOCAL_PORT,
    database,
    user: "postgres",
  });
  await client.connect();
  return client;
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url));
}

if (isDirectRun()) {
  bootstrapLocalDatabase().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "bootstrap_error";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
