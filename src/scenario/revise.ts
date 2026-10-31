import { verifyDraft } from "../checks/draft-checks.js";
import { MESSAGES } from "../contract/constants.js";
import { contentHash } from "../contract/hash.js";
import type { ArtifactRevision, ErrorBody, ProviderDraft, RunRecord } from "../contract/types.js";
import type { RunStore } from "../storage/store.js";
import { appendJournal, nextUserAction } from "./journal.js";

export type ReviseResult =
  | { outcome: "revised"; run: RunRecord; revision: ArtifactRevision; previous: ArtifactRevision }
  | { outcome: "unchanged"; revision: ArtifactRevision }
  | { outcome: "rejected"; error: ErrorBody };

export async function reviseDraft(store: RunStore, runId: string, newText: string): Promise<ReviseResult> {
  const run = await store.readRun(runId);
  if (!run || run.status !== "succeeded" || !run.artifact_id || run.current_revision === null) {
    return { outcome: "rejected", error: { code: "artifact_missing", message: MESSAGES.artifact_missing, field: null } };
  }
  const snapshot = await store.readSnapshot(runId);
  const current = await store.readArtifactRevision(run.artifact_id, run.current_revision);
  if (!snapshot || !current) {
    return { outcome: "rejected", error: { code: "artifact_missing", message: MESSAGES.artifact_missing, field: null } };
  }
  const hash = contentHash(newText);
  if (hash === current.content_hash) return { outcome: "unchanged", revision: current };

  const draft: ProviderDraft = {
    ok: true,
    provider: "FixtureProvider",
    variant: "revision",
    body: newText,
    // A changed body has no reviewed claim bindings. Previous links belong
    // exclusively to the previous revision and cannot approve this text.
    claims: [],
    sources: snapshot.input.sources.map((source) => ({
      source_id: source.source_id,
      url: source.url,
      title: source.title,
    })),
  };
  const verification = verifyDraft(snapshot.input, draft);
  verification.grounds.push("Текст изменён: прежние привязки утверждений аннулированы. Нужна новая проверка утверждений по источникам для этой версии.");
  const revision: ArtifactRevision = {
    artifact_id: run.artifact_id,
    revision: current.revision + 1,
    run_id: run.run_id,
    text: newText,
    content_hash: hash,
    hash_algorithm: "sha256",
    created_at: new Date().toISOString(),
    scenario_version: run.scenario_version,
    claim_links: verification.claim_links,
    verification,
    immutable: true,
  };
  await store.saveArtifactRevision(revision);
  run.current_revision = revision.revision;
  run.verification = verification;
  run.quality_gate = verification.blocks_external_action ? "blocked" : "open";
  run.publication = { status: "not_published", handler: "absent", permitted: false };
  run.next_user_action = nextUserAction(run);
  appendJournal(run, "revise", "ok", null, [`artifacts/${run.artifact_id}/${revision.revision}.json`]);
  await store.saveRun(run);
  return { outcome: "revised", run, revision, previous: current };
}
