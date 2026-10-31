import { MESSAGES } from "../contract/constants.js";
import type { ErrorBody } from "../contract/types.js";
import type { RunStore } from "../storage/store.js";
import { appendJournal } from "./journal.js";

export type PublicationResult = {
  outcome: "rejected";
  publication_status: "not_published";
  error: ErrorBody;
  run_id: string;
};

export async function requestPublication(store: RunStore, runId: string): Promise<PublicationResult> {
  const result: PublicationResult = {
    outcome: "rejected",
    publication_status: "not_published",
    error: {
      code: "publication_handler_absent",
      message: MESSAGES.publication_handler_absent,
      field: null,
    },
    run_id: runId,
  };
  const run = await store.readRun(runId);
  if (!run) return result;
  run.publication = { status: "not_published", handler: "absent", permitted: false };
  run.external_side_effects = false;
  appendJournal(run, "publish_rejected", "fail", "publication_handler_absent");
  await store.saveRun(run);
  return result;
}
