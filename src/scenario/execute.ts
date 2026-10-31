import { educationalCosts, verifyDraft } from "../checks/draft-checks.js";
import { assertCatalogFixtures } from "../contract/catalog.js";
import {
  ACCESS_CHECK_NOTE,
  MESSAGES,
  RULES_VERSION,
  SCENARIO_VERSION,
  SCHEMA_VERSION,
  WORKFLOW_VERSION,
} from "../contract/constants.js";
import { canonicalize, contentHash, newId, sha256Hex } from "../contract/hash.js";
import { assertTransition } from "../contract/transitions.js";
import type { ArtifactRevision, ErrorBody, InputSnapshot, PrepareDraftInput, ProviderVariant, RunRecord } from "../contract/types.js";
import { validatePrepareDraftInput } from "../contract/validate.js";
import { FixtureProvider } from "../provider/fixture-provider.js";
import type { RunStore } from "../storage/store.js";
import { appendJournal, nextUserAction } from "./journal.js";

export type ExecuteResult =
  | { outcome: "rejected"; error: ErrorBody; run: null }
  | { outcome: "conflict"; error: ErrorBody; existing_run_id: string; run: RunRecord | null }
  | { outcome: "finished"; replay: boolean; run: RunRecord }
  | { outcome: "interrupted"; run: RunRecord }
  | { outcome: "diagnostics_only"; error: ErrorBody; run: null };

export type StepName = "running" | "snapshot" | "before_provider" | "before_checks" | "before_persist";

export type ExecuteOptions = {
  store: RunStore;
  root: string;
  provider?: FixtureProvider;
  providerVariant?: ProviderVariant;
  interruptAfter?: "running";
  onStep?: (step: StepName, runId: string) => Promise<void> | void;
};

export async function executePrepareDraft(raw: unknown, options: ExecuteOptions): Promise<ExecuteResult> {
  const validated = validatePrepareDraftInput(raw);
  if (!validated.ok) return { outcome: "rejected", error: validated.error, run: null };
  const fixtures = await assertCatalogFixtures(validated.value, options.root);
  if (!fixtures.ok) return { outcome: "rejected", error: fixtures.error, run: null };

  const input = validated.value;
  const inputHash = sha256Hex(canonicalize(input));
  const scopeHash = sha256Hex([input.workspace_id, input.operation, input.idempotency_key].join("\0"));
  const provider = options.provider ?? new FixtureProvider();
  const variant = options.providerVariant ?? "standard";

  try {
    return await options.store.withIdempotencyLock(scopeHash, async () => {
      const existing = await options.store.getIdempotency(scopeHash);
      if (existing) {
        const prior = await options.store.readRun(existing.run_id);
        if (existing.input_hash !== inputHash) {
          return {
            outcome: "conflict" as const,
            error: { code: "idempotency_conflict", message: MESSAGES.idempotency_conflict, field: "idempotency_key" },
            existing_run_id: existing.run_id,
            run: prior,
          };
        }
        if (!prior) {
          return {
            outcome: "diagnostics_only" as const,
            error: { code: "storage_error", message: MESSAGES.storage_error, field: null },
            run: null,
          };
        }
        return { outcome: "finished" as const, replay: true, run: prior };
      }

      const run = blankRun(input, inputHash, variant);
      const snapshot: InputSnapshot = {
        run_id: run.run_id,
        schema_version: SCHEMA_VERSION,
        scenario_version: SCENARIO_VERSION,
        rules_version: RULES_VERSION,
        captured_at: run.created_at,
        input_hash: inputHash,
        fixture: true,
        input,
      };
      try {
        await options.store.saveSnapshot(snapshot);
        await options.store.saveRun(run);
        await options.store.putIdempotency({
          scope_hash: scopeHash,
          workspace_id: input.workspace_id,
          operation: "prepare_draft",
          idempotency_key: input.idempotency_key,
          input_hash: inputHash,
          run_id: run.run_id,
          created_at: run.created_at,
        });
      } catch {
        return {
          outcome: "diagnostics_only" as const,
          error: { code: "storage_error", message: MESSAGES.storage_error, field: null },
          run: null,
        };
      }

      appendJournal(run, "validate", "ok", null);
      appendJournal(run, "snapshot", "ok", null, [run.snapshot_ref]);
      assertTransition(run.status, "running");
      run.status = "running";
      run.lease = { pid: process.pid, abandoned: false, at: new Date().toISOString() };
      await options.store.saveRun(run);
      await options.onStep?.("running", run.run_id);

      if (options.interruptAfter === "running") {
        run.lease = { pid: process.pid, abandoned: true, at: new Date().toISOString() };
        await options.store.saveRun(run);
        return { outcome: "interrupted" as const, run };
      }

      const cancelled = await stopIfCancelled(options.store, run);
      if (cancelled) return cancelled;

      if (input.sources.length === 0) {
        appendJournal(run, "sources", "fail", "insufficient_sources");
        return conclude(options.store, run, "failed", {
          code: "insufficient_sources",
          message: MESSAGES.insufficient_sources,
        });
      }

      await options.onStep?.("before_provider", run.run_id);
      const cancelledBeforeProvider = await stopIfCancelled(options.store, run);
      if (cancelledBeforeProvider) return cancelledBeforeProvider;

      run.provider_invoked = true;
      run.step_attempts = { provider: 1, max_provider_attempts: 1 };
      const draft = provider.generate(input, variant);
      if (!draft.ok) {
        appendJournal(run, "provider", "fail", "provider_refused");
        return conclude(options.store, run, "failed", { code: "provider_refused", message: draft.message });
      }
      appendJournal(run, "provider", "ok", null);

      await options.onStep?.("before_checks", run.run_id);
      const cancelledBeforeChecks = await stopIfCancelled(options.store, run);
      if (cancelledBeforeChecks) return cancelledBeforeChecks;

      const verification = verifyDraft(input, draft);
      run.verification = verification;
      run.quality_gate = verification.status === "pass" ? "open" : "blocked";
      appendJournal(run, "checks", verification.status === "fail" ? "fail" : "ok", verification.status === "fail" ? "verification_failed" : null);

      await options.onStep?.("before_persist", run.run_id);
      const cancelledBeforePersist = await stopIfCancelled(options.store, run);
      if (cancelledBeforePersist) return cancelledBeforePersist;

      const artifactId = newId("art");
      const revision: ArtifactRevision = {
        artifact_id: artifactId,
        revision: 1,
        run_id: run.run_id,
        text: draft.body,
        content_hash: contentHash(draft.body),
        hash_algorithm: "sha256",
        created_at: new Date().toISOString(),
        scenario_version: SCENARIO_VERSION,
        claim_links: verification.claim_links,
        verification,
        immutable: true,
      };
      try {
        await options.store.saveArtifactRevision(revision);
      } catch {
        appendJournal(run, "persist", "fail", "storage_error");
        run.artifact_id = null;
        run.current_revision = null;
        return conclude(options.store, run, "failed", { code: "storage_error", message: MESSAGES.storage_error });
      }

      run.artifact_id = artifactId;
      run.current_revision = 1;
      appendJournal(run, "persist", "ok", null, [`artifacts/${artifactId}/1.json`]);
      return conclude(options.store, run, "succeeded", null);
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "lock_timeout") {
      return { outcome: "diagnostics_only", error: { code: "lock_timeout", message: MESSAGES.lock_timeout, field: null }, run: null };
    }
    return { outcome: "diagnostics_only", error: { code: "storage_error", message: MESSAGES.storage_error, field: null }, run: null };
  }
}

function blankRun(input: PrepareDraftInput, inputHash: string, variant: string): RunRecord {
  const now = new Date().toISOString();
  const runId = newId("run");
  return {
    run_id: runId,
    status: "queued",
    stop: null,
    workspace_id: input.workspace_id,
    project_id: input.project_id,
    operation: "prepare_draft",
    mode: "educational",
    scenario_version: SCENARIO_VERSION,
    schema_version: SCHEMA_VERSION,
    rules_version: RULES_VERSION,
    workflow_version: WORKFLOW_VERSION,
    input_hash: inputHash,
    snapshot_ref: `snapshots/${runId}.json`,
    idempotency_key: input.idempotency_key,
    retry_of_run_id: input.retry_of_run_id,
    artifact_id: null,
    current_revision: null,
    verification: null,
    publication: { status: "not_published", handler: "absent", permitted: false },
    quality_gate: "blocked",
    costs: educationalCosts(input.budget.currency),
    journal: [],
    next_user_action: "Запуск поставлен в очередь.",
    fixture: true,
    provider_name: "FixtureProvider",
    provider_invoked: false,
    provider_variant: variant,
    test_scope: {
      fixture_provider: true,
      real_model: false,
      live_site: false,
      rls: false,
      production: false,
    },
    access_check: "not_performed",
    access_check_note: ACCESS_CHECK_NOTE,
    cancel_requested: false,
    lease: null,
    recovery: null,
    step_attempts: { provider: 0, max_provider_attempts: 1 },
    external_side_effects: false,
    created_at: now,
    updated_at: now,
  };
}

async function stopIfCancelled(store: RunStore, run: RunRecord): Promise<ExecuteResult | null> {
  const fresh = await store.readRun(run.run_id);
  if (!fresh?.cancel_requested) return null;
  run.cancel_requested = true;
  appendJournal(run, "cancel", "ok", "cancelled_by_user");
  return conclude(store, run, "cancelled", { code: "cancelled_by_user", message: MESSAGES.cancelled_by_user });
}

async function conclude(
  store: RunStore,
  run: RunRecord,
  status: "succeeded" | "failed" | "cancelled",
  stop: { code: string; message: string } | null,
): Promise<ExecuteResult> {
  if (run.status !== status) {
    assertTransition(run.status, status);
    run.status = status;
  }
  run.stop = stop;
  run.lease = null;
  run.publication = { status: "not_published", handler: "absent", permitted: false };
  run.external_side_effects = false;
  if (status === "succeeded" && run.verification?.status === "pass") run.quality_gate = "open";
  else run.quality_gate = "blocked";
  run.next_user_action = nextUserAction(run);
  appendJournal(run, "finish", status === "succeeded" ? "ok" : "fail", stop?.code ?? null, run.artifact_id ? [`artifacts/${run.artifact_id}/${run.current_revision}.json`] : []);
  try {
    await store.saveRun(run);
    return { outcome: "finished", replay: false, run };
  } catch {
    return {
      outcome: "diagnostics_only",
      error: { code: stop?.code ?? "storage_error", message: stop?.message ?? MESSAGES.storage_error, field: null },
      run: null,
    };
  }
}
