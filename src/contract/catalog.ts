import { realpath, readFile } from "node:fs/promises";
import path from "node:path";
import { FIXTURE_CATALOG, MESSAGES } from "./constants.js";
import { normalizeNewlines } from "./hash.js";
import type { ErrorBody, PrepareDraftInput } from "./types.js";

export async function assertCatalogFixtures(
  input: PrepareDraftInput,
  root: string,
): Promise<{ ok: true } | { ok: false; error: ErrorBody }> {
  for (const source of input.sources) {
    const relative = FIXTURE_CATALOG[source.provenance.fixture_id];
    if (!relative) {
      return { ok: false, error: { code: "unknown_fixture", message: MESSAGES.unknown_fixture, field: "sources.provenance.fixture_id" } };
    }
    const loaded = await readCatalogFile(root, relative);
    if (!loaded.ok) {
      return { ok: false, error: { code: "unknown_fixture", message: MESSAGES.unknown_fixture, field: "sources.provenance.fixture_id" } };
    }
    if (loaded.text !== source.provided_text) {
      return { ok: false, error: { code: "fixture_mismatch", message: MESSAGES.fixture_mismatch, field: "sources.provided_text" } };
    }
  }
  return { ok: true };
}

async function readCatalogFile(root: string, relative: string): Promise<{ ok: true; text: string } | { ok: false }> {
  const fixturesRoot = path.resolve(root, "fixtures");
  const full = path.resolve(root, relative);
  const inside = path.relative(fixturesRoot, full);
  if (inside.startsWith("..") || path.isAbsolute(inside)) return { ok: false };
  try {
    const [realFile, realRoot] = await Promise.all([realpath(full), realpath(fixturesRoot)]);
    const escaped = path.relative(realRoot, realFile);
    if (escaped.startsWith("..") || path.isAbsolute(escaped)) return { ok: false };
    const text = normalizeNewlines(await readFile(realFile, "utf8"));
    return { ok: true, text };
  } catch {
    return { ok: false };
  }
}
