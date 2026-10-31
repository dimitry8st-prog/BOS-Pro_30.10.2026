import { LIMITS, MESSAGES, SCHEMA_VERSION } from "./constants.js";
import { codePointLength, normalizeNewlines } from "./hash.js";
import type { ErrorBody, PrepareDraftInput, PreparedSource } from "./types.js";

const TOP_KEYS = [
  "schema_version",
  "workspace_id",
  "project_id",
  "operation",
  "mode",
  "topic",
  "audience",
  "language",
  "format",
  "sources",
  "criteria",
  "destination",
  "budget",
  "idempotency_key",
  "retry_of_run_id",
] as const;

const SOURCE_KEYS = ["source_id", "url", "title", "provided_text", "provenance"] as const;
const PROVENANCE_KEYS = ["kind", "fixture_id", "note"] as const;
const CRITERIA_KEYS = [
  "max_body_chars",
  "link_policy",
  "factual_claims",
  "forbid_measured_savings_claims",
] as const;
const BUDGET_KEYS = ["amount", "currency", "external_spend_amount"] as const;
const DESTINATION_KEYS = ["channel", "target", "metadata_only"] as const;

const DECIMAL = /^(0|[1-9][0-9]{0,8})(\.[0-9]{1,2})?$/;
const WORKSPACE_ID = /^ws_[a-z0-9]{1,32}$/;
const PROJECT_ID = /^prj_[a-z0-9]{1,32}$/;
const SOURCE_ID = /^src_[a-z0-9]{1,32}$/;
const FIXTURE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/;
const RUN_ID = /^run_[a-f0-9]{32}$/;
const LANGUAGE = /^[a-z]{2}$/;

export type ValidationResult =
  | { ok: true; value: PrepareDraftInput }
  | { ok: false; error: ErrorBody };

export function validatePrepareDraftInput(raw: unknown): ValidationResult {
  if (!isRecord(raw)) {
    return fail("invalid_shape", MESSAGES.invalid_shape, null);
  }
  const unknown = unknownKey(raw, TOP_KEYS, null);
  if (unknown) {
    return fail("unknown_field", MESSAGES.unknown_field, clip(unknown));
  }
  if (raw.schema_version !== SCHEMA_VERSION) {
    return fail("schema_version_unsupported", MESSAGES.schema_version_unsupported, "schema_version");
  }
  if (!isString(raw.workspace_id) || !WORKSPACE_ID.test(raw.workspace_id)) {
    return fail("invalid_shape", MESSAGES.invalid_shape, "workspace_id");
  }
  if (!isString(raw.project_id) || !PROJECT_ID.test(raw.project_id)) {
    return fail("invalid_shape", MESSAGES.invalid_shape, "project_id");
  }
  if (raw.operation !== "prepare_draft") {
    return fail("operation_not_enabled", MESSAGES.operation_not_enabled, "operation");
  }
  if (raw.mode !== "educational") {
    return fail("mode_not_enabled", MESSAGES.mode_not_enabled, "mode");
  }

  const topic = checkedText(raw.topic, LIMITS.topicMax, true);
  if (!topic.ok) {
    return fail(topic.empty ? "invalid_topic" : "invalid_shape", topic.empty ? MESSAGES.invalid_topic : MESSAGES.invalid_shape, "topic");
  }
  const audience = checkedText(raw.audience, LIMITS.audienceMax, true);
  if (!audience.ok) {
    return fail("invalid_shape", MESSAGES.invalid_shape, "audience");
  }
  if (!isString(raw.language) || !LANGUAGE.test(raw.language)) {
    return fail("invalid_shape", MESSAGES.invalid_shape, "language");
  }
  if (raw.format !== "short_note") {
    return fail("format_not_enabled", MESSAGES.format_not_enabled, "format");
  }
  if (!Array.isArray(raw.sources)) {
    return fail("invalid_shape", MESSAGES.invalid_shape, "sources");
  }
  if (raw.sources.length > LIMITS.sourcesMax) {
    return fail("invalid_shape", MESSAGES.invalid_shape, "sources");
  }

  const sources: PreparedSource[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < raw.sources.length; index += 1) {
    const parsed = parseSource(raw.sources[index], index);
    if (!parsed.ok) return parsed;
    if (seen.has(parsed.value.source_id)) {
      return fail("invalid_shape", MESSAGES.invalid_shape, `sources.${index}.source_id`);
    }
    seen.add(parsed.value.source_id);
    sources.push(parsed.value);
  }

  const criteria = parseCriteria(raw.criteria);
  if (!criteria.ok) return criteria;
  const destination = parseDestination(raw.destination);
  if (!destination.ok) return destination;
  const budget = parseBudget(raw.budget);
  if (!budget.ok) return budget;
  if (!isString(raw.idempotency_key) || !IDEMPOTENCY_KEY.test(raw.idempotency_key)) {
    return fail("invalid_shape", MESSAGES.invalid_shape, "idempotency_key");
  }
  const retry = parseRetry(raw.retry_of_run_id, Object.hasOwn(raw, "retry_of_run_id"));
  if (!retry.ok) return retry;

  const value: PrepareDraftInput = {
    schema_version: SCHEMA_VERSION,
    workspace_id: raw.workspace_id,
    project_id: raw.project_id,
    operation: "prepare_draft",
    mode: "educational",
    topic: topic.value,
    audience: audience.value,
    language: raw.language,
    format: "short_note",
    sources,
    criteria: criteria.value,
    destination: destination.value,
    budget: budget.value,
    idempotency_key: raw.idempotency_key,
    retry_of_run_id: retry.value,
  };
  return { ok: true, value };
}

function parseSource(raw: unknown, index: number): { ok: true; value: PreparedSource } | { ok: false; error: ErrorBody } {
  const field = `sources.${index}`;
  if (!isRecord(raw)) return fail("invalid_shape", MESSAGES.invalid_shape, field);
  const unknown = unknownKey(raw, SOURCE_KEYS, field);
  if (unknown) return fail("unknown_field", MESSAGES.unknown_field, clip(unknown));
  if (!isString(raw.source_id) || !SOURCE_ID.test(raw.source_id)) {
    return fail("invalid_shape", MESSAGES.invalid_shape, `${field}.source_id`);
  }
  if (!isString(raw.url) || !isHttpUrl(raw.url)) {
    return fail("invalid_shape", MESSAGES.invalid_shape, `${field}.url`);
  }
  const title = checkedText(raw.title, LIMITS.titleMax, true);
  if (!title.ok) return fail("invalid_shape", MESSAGES.invalid_shape, `${field}.title`);
  if (!isString(raw.provided_text)) {
    return fail("invalid_shape", MESSAGES.invalid_shape, `${field}.provided_text`);
  }
  const provided = normalizeNewlines(raw.provided_text);
  const providedLength = codePointLength(provided);
  if (providedLength < 1 || providedLength > LIMITS.providedTextMax) {
    return fail("invalid_shape", MESSAGES.invalid_shape, `${field}.provided_text`);
  }
  if (!isRecord(raw.provenance)) {
    return fail("invalid_shape", MESSAGES.invalid_shape, `${field}.provenance`);
  }
  const unknownProvenance = unknownKey(raw.provenance, PROVENANCE_KEYS, `${field}.provenance`);
  if (unknownProvenance) return fail("unknown_field", MESSAGES.unknown_field, clip(unknownProvenance));
  if (raw.provenance.kind !== "fixture") {
    return fail("provenance_not_enabled", MESSAGES.provenance_not_enabled, `${field}.provenance.kind`);
  }
  if (!isString(raw.provenance.fixture_id) || !FIXTURE_ID.test(raw.provenance.fixture_id)) {
    return fail("invalid_shape", MESSAGES.invalid_shape, `${field}.provenance.fixture_id`);
  }
  let note: string | null = null;
  if (Object.hasOwn(raw.provenance, "note") && raw.provenance.note !== null) {
    if (!isString(raw.provenance.note) || codePointLength(raw.provenance.note) > LIMITS.noteMax) {
      return fail("invalid_shape", MESSAGES.invalid_shape, `${field}.provenance.note`);
    }
    note = raw.provenance.note;
  }
  return {
    ok: true,
    value: {
      source_id: raw.source_id,
      url: raw.url,
      title: title.value,
      provided_text: provided,
      provenance: { kind: "fixture", fixture_id: raw.provenance.fixture_id, note },
    },
  };
}

function parseCriteria(
  raw: unknown,
): { ok: true; value: PrepareDraftInput["criteria"] } | { ok: false; error: ErrorBody } {
  if (!isRecord(raw)) return fail("invalid_shape", MESSAGES.invalid_shape, "criteria");
  const unknown = unknownKey(raw, CRITERIA_KEYS, "criteria");
  if (unknown) return fail("unknown_field", MESSAGES.unknown_field, clip(unknown));
  if (!isInteger(raw.max_body_chars) || raw.max_body_chars < 1 || raw.max_body_chars > LIMITS.bodyCharsMax) {
    return fail("invalid_shape", MESSAGES.invalid_shape, "criteria.max_body_chars");
  }
  if (raw.link_policy !== "sources_separate") {
    return fail("invalid_shape", MESSAGES.invalid_shape, "criteria.link_policy");
  }
  if (raw.factual_claims !== "each_bound_to_fragment") {
    return fail("invalid_shape", MESSAGES.invalid_shape, "criteria.factual_claims");
  }
  if (typeof raw.forbid_measured_savings_claims !== "boolean") {
    return fail("invalid_shape", MESSAGES.invalid_shape, "criteria.forbid_measured_savings_claims");
  }
  return {
    ok: true,
    value: {
      max_body_chars: raw.max_body_chars,
      link_policy: "sources_separate",
      factual_claims: "each_bound_to_fragment",
      forbid_measured_savings_claims: raw.forbid_measured_savings_claims,
    },
  };
}

function parseDestination(
  raw: unknown,
): { ok: true; value: PrepareDraftInput["destination"] } | { ok: false; error: ErrorBody } {
  if (raw === null) return { ok: true, value: null };
  if (!isRecord(raw)) return fail("invalid_shape", MESSAGES.invalid_shape, "destination");
  const unknown = unknownKey(raw, DESTINATION_KEYS, "destination");
  if (unknown) return fail("unknown_field", MESSAGES.unknown_field, clip(unknown));
  if (raw.metadata_only !== true) {
    return fail("destination_not_metadata", MESSAGES.destination_not_metadata, "destination.metadata_only");
  }
  const channel = checkedText(raw.channel, LIMITS.channelMax, true);
  const target = checkedText(raw.target, LIMITS.targetMax, true);
  if (!channel.ok || !target.ok) {
    return fail("destination_not_metadata", MESSAGES.destination_not_metadata, "destination");
  }
  return {
    ok: true,
    value: { channel: channel.value, target: target.value, metadata_only: true },
  };
}

function parseBudget(raw: unknown): { ok: true; value: PrepareDraftInput["budget"] } | { ok: false; error: ErrorBody } {
  if (!isRecord(raw)) return fail("invalid_budget", MESSAGES.invalid_budget, "budget");
  const unknown = unknownKey(raw, BUDGET_KEYS, "budget");
  if (unknown) return fail("unknown_field", MESSAGES.unknown_field, clip(unknown));
  if (!isString(raw.amount) || !DECIMAL.test(raw.amount)) {
    return fail("invalid_budget", MESSAGES.invalid_budget, "budget.amount");
  }
  if (!isString(raw.currency) || !/^[A-Z]{3}$/.test(raw.currency)) {
    return fail("invalid_budget", MESSAGES.invalid_budget, "budget.currency");
  }
  if (!isString(raw.external_spend_amount) || !DECIMAL.test(raw.external_spend_amount) || !isZeroDecimal(raw.external_spend_amount)) {
    return fail("invalid_budget", MESSAGES.invalid_budget, "budget.external_spend_amount");
  }
  return {
    ok: true,
    value: {
      amount: raw.amount,
      currency: raw.currency,
      external_spend_amount: raw.external_spend_amount,
    },
  };
}

function parseRetry(
  raw: unknown,
  present: boolean,
): { ok: true; value: string | null } | { ok: false; error: ErrorBody } {
  if (!present || raw === null) return { ok: true, value: null };
  if (!isString(raw) || !RUN_ID.test(raw)) {
    return fail("invalid_shape", MESSAGES.invalid_shape, "retry_of_run_id");
  }
  return { ok: true, value: raw };
}

export function isHttpUrl(value: string): boolean {
  if (value.length > LIMITS.urlMax) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (url.username !== "" || url.password !== "") return false;
    return true;
  } catch {
    return false;
  }
}

function isZeroDecimal(value: string): boolean {
  return Number(value) === 0;
}

function checkedText(
  raw: unknown,
  max: number,
  trim: boolean,
): { ok: true; value: string } | { ok: false; empty: boolean } {
  if (!isString(raw)) return { ok: false, empty: false };
  const value = trim ? raw.trim() : raw;
  const length = codePointLength(value);
  if (length < 1 || length > max) return { ok: false, empty: length < 1 };
  return { ok: true, value };
}

function unknownKey(record: Record<string, unknown>, allowed: readonly string[], prefix: string | null): string | null {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      return prefix ? `${prefix}.${key}` : key;
    }
  }
  return null;
}

function fail(code: string, message: string, field: string | null): { ok: false; error: ErrorBody } {
  return { ok: false, error: { code, message, field } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function clip(field: string): string {
  return [...field].slice(0, 80).join("");
}
