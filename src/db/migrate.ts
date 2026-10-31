import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { LOCAL_DATABASE, LOCAL_HOST, LOCAL_PORT, localPassword } from "./local-test.js";

const MIGRATION_LOCK = "864201";

function migrationsDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../db/migrations");
}

export async function migrate(): Promise<string[]> {
  const client = new pg.Client({
    host: LOCAL_HOST,
    port: LOCAL_PORT,
    database: LOCAL_DATABASE,
    user: "bos_owner",
    password: localPassword("bos_owner"),
  });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query("SELECT pg_advisory_lock($1::bigint)", [MIGRATION_LOCK]);
    const names = (await readdir(migrationsDir())).filter((name) => name.endsWith(".sql")).sort();
    for (const name of names) {
      const version = name.slice(0, -4);
      if (await alreadyApplied(client, version)) continue;
      const sql = await readFile(path.join(migrationsDir(), name), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migration (version) VALUES ($1)", [version]);
        await client.query("COMMIT");
        applied.push(version);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
    return applied;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1::bigint)", [MIGRATION_LOCK]).catch(() => undefined);
    await client.end();
  }
}

async function alreadyApplied(client: pg.Client, version: string): Promise<boolean> {
  const exists = await client.query<{ name: string | null }>("SELECT to_regclass('public.schema_migration') AS name");
  if (!exists.rows[0]?.name) return false;
  const found = await client.query("SELECT 1 FROM schema_migration WHERE version = $1", [version]);
  return (found.rowCount ?? 0) > 0;
}
