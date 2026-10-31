import type { SCHEMA_VERSION } from "./constants.js";

export type RunStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "succeeded"
  | "failed"
  | "cancelled";

export type TerminalStatus = "succeeded" | "failed" | "cancelled";

export type VerificationStatus = "pass" | "fail" | "needs_review";

export type UrlCheckStatus = "reachable" | "unreachable" | "not_checked";

export type ErrorBody = {
  code: string;
  message: string;
  field: string | null;
};

export type PreparedSource = {
  source_id: string;
  url: string;
  title: string;
  provided_text: string;
  provenance: {
    kind: "fixture";
    fixture_id: string;
    note: string | null;
  };
};

export type PrepareDraftInput = {
  schema_version: typeof SCHEMA_VERSION;
  workspace_id: string;
  project_id: string;
  operation: "prepare_draft";
  mode: "educational";
  topic: string;
  audience: string;
  language: string;
  format: "short_note";
  sources: PreparedSource[];
  criteria: {
    max_body_chars: number;
    link_policy: "sources_separate";
    factual_claims: "each_bound_to_fragment";
    forbid_measured_savings_claims: boolean;
  };
  destination: null | {
    channel: string;
    target: string;
    metadata_only: true;
  };
  budget: {
    amount: string;
    currency: string;
    external_spend_amount: string;
  };
  idempotency_key: string;
  retry_of_run_id: string | null;
};

export type Money = {
  amount: string;
  currency: string;
};

export type CostReport = {
  external: {
    estimate: Money;
    reserved: Money;
    actual: Money;
  };
  model: {
    estimate: null;
    reserved: null;
    actual: null;
    status: "not_measured";
  };
};

export type VerificationCheck = {
  code: string;
  executed: true;
  pass: boolean;
  detail: string;
};

export type ClaimLink = {
  statement: string;
  source_id: string;
  fragment: string;
  bound: boolean;
  weak: boolean;
};

export type UrlCheck = {
  source_id: string;
  status: UrlCheckStatus;
  checked_at: string | null;
  limitation: string;
};

export type VerificationReport = {
  status: VerificationStatus;
  grounds: string[];
  limitations: string[];
  checks: VerificationCheck[];
  claim_links: ClaimLink[];
  url_checks: UrlCheck[];
  rules_version: string;
  blocks_external_action: boolean;
};

export type JournalEntry = {
  run_id: string;
  step: string;
  at: string;
  outcome: "ok" | "fail" | "skipped";
  error_code: string | null;
  schema_version: string;
  rules_version: string;
  artifact_refs: string[];
  costs: CostReport;
};

export type RunRecord = {
  run_id: string;
  status: RunStatus;
  stop: { code: string; message: string } | null;
  workspace_id: string;
  project_id: string;
  operation: "prepare_draft";
  mode: "educational";
  scenario_version: string;
  schema_version: string;
  rules_version: string;
  workflow_version: string;
  task_id: string;
  workflow_version_id: string;
  input_hash: string;
  snapshot_ref: string;
  idempotency_key: string;
  retry_of_run_id: string | null;
  artifact_id: string | null;
  current_revision: number | null;
  verification: VerificationReport | null;
  publication: {
    status: "not_published";
    handler: "absent";
    permitted: false;
  };
  quality_gate: "open" | "blocked";
  costs: CostReport;
  journal: JournalEntry[];
  next_user_action: string;
  fixture: true;
  provider_name: "FixtureProvider";
  provider_invoked: boolean;
  provider_variant: string;
  test_scope: {
    fixture_provider: true;
    real_model: false;
    live_site: false;
    rls: false;
    production: false;
  };
  access_check: "not_performed" | "educational_membership_checked";
  access_check_note: string;
  cancel_requested: boolean;
  lease: { pid: number | null; abandoned: boolean; at: string } | null;
  recovery: null | {
    recovered_at: string;
    previous_status: "queued" | "running";
    resulting_status: "failed" | "cancelled";
    code: string;
    message: string;
  };
  step_attempts: { provider: number; max_provider_attempts: 1 };
  external_side_effects: false;
  created_at: string;
  updated_at: string;
};

export type InputSnapshot = {
  run_id: string;
  schema_version: string;
  scenario_version: string;
  rules_version: string;
  captured_at: string;
  input_hash: string;
  fixture: true;
  input: PrepareDraftInput;
};

export type ArtifactRevision = {
  artifact_id: string;
  revision: number;
  run_id: string;
  text: string;
  content_hash: string;
  hash_algorithm: "sha256";
  created_at: string;
  scenario_version: string;
  claim_links: ClaimLink[];
  verification: VerificationReport;
  immutable: true;
};

export type IdempotencyRecord = {
  scope_hash: string;
  workspace_id: string;
  operation: "prepare_draft";
  idempotency_key: string;
  input_hash: string;
  run_id: string;
  created_at: string;
};

export type ProviderVariant =
  | "standard"
  | "refuse"
  | "overlong"
  | "unbound"
  | "savings"
  | "omit_sources"
  | "weak_fragment";

export type ProviderClaim = {
  statement: string;
  source_id: string;
  fragment: string;
};

export type ProviderSource = {
  source_id: string;
  url: string;
  title: string;
};

export type ProviderDraft = {
  ok: true;
  provider: "FixtureProvider";
  variant: string;
  body: string;
  claims: ProviderClaim[];
  sources: ProviderSource[];
};

export type ProviderRefusal = {
  ok: false;
  provider: "FixtureProvider";
  code: "provider_refused";
  message: string;
};

export type ProviderResult = ProviderDraft | ProviderRefusal;

export function isTerminal(status: RunStatus): status is TerminalStatus {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}
