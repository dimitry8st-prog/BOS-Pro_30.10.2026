import { spawn } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { LOCAL_HOST, LOCAL_PORT } from "./local-test.js";

const PG_BIN = process.env.PG_BIN ?? "C:\\Program Files\\PostgreSQL\\16\\bin";

function dataDir(): string {
  return path.join(process.cwd(), "var", "pg-test");
}

function exe(name: string): string {
  return path.join(PG_BIN, process.platform === "win32" ? `${name}.exe` : name);
}

function run(command: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

export async function ensureCluster(): Promise<void> {
  await mkdir(path.join(process.cwd(), "var"), { recursive: true });
  try {
    await access(path.join(dataDir(), "PG_VERSION"));
  } catch {
    const created = await run(exe("initdb"), ["-D", dataDir(), "-U", "postgres", "-A", "trust", "--encoding=UTF8", "--locale=C"]);
    if (created.code !== 0) {
      throw new Error(`Не удалось создать учебный кластер PostgreSQL. ${created.stderr || created.stdout}`);
    }
  }
  const ready = await run(exe("pg_isready"), ["-h", LOCAL_HOST, "-p", String(LOCAL_PORT), "-U", "postgres"]);
  if (ready.code !== 0) {
    const started = await run(exe("pg_ctl"), [
      "-D",
      dataDir(),
      "-l",
      path.join(process.cwd(), "var", "pg-test.log"),
      "-o",
      `-p ${LOCAL_PORT} -h ${LOCAL_HOST}`,
      "start",
    ]);
    if (started.code !== 0) {
      throw new Error(`Не удалось запустить учебный кластер PostgreSQL. ${started.stderr || started.stdout}`);
    }
  }
  await hardenAuthentication();
}

async function hardenAuthentication(): Promise<void> {
  const file = path.join(dataDir(), "pg_hba.conf");
  const current = await readFile(file, "utf8");
  if (current.includes("# bos-pro-local-test-auth")) return;
  const marker = current.indexOf("# TYPE  DATABASE");
  const head = marker === -1 ? current : current.slice(0, marker);
  const rules = `# bos-pro-local-test-auth
# TYPE  DATABASE        USER            ADDRESS                 METHOD
local   all             postgres                                trust
local   all             all                                     scram-sha-256
host    all             postgres        ${LOCAL_HOST}/32        trust
host    all             all             ${LOCAL_HOST}/32        scram-sha-256
host    all             all             ::1/128                 reject
local   replication     postgres                                trust
host    replication     postgres        ${LOCAL_HOST}/32        trust
`;
  await writeFile(file, `${head}${rules}`, "utf8");
  const reloaded = await run(exe("pg_ctl"), ["-D", dataDir(), "reload"]);
  if (reloaded.code !== 0) {
    throw new Error(`Не удалось перечитать pg_hba.conf. ${reloaded.stderr || reloaded.stdout}`);
  }
}
