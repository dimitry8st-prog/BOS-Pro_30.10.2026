import type { RunRecord, VerificationStatus } from "../contract/types.js";

/**
 * Typed view-model for a future React panel.
 * This stage does not render UI and does not depend on React.
 */
export type DraftReviewViewModel = {
  runId: string;
  body: string;
  fixture: true;
  verificationStatus: VerificationStatus | null;
  publicationStatus: "not_published";
  accessCheck: "not_performed";
};

export function toDraftReviewViewModel(run: RunRecord, body: string): DraftReviewViewModel {
  return {
    runId: run.run_id,
    body,
    fixture: true,
    verificationStatus: run.verification?.status ?? null,
    publicationStatus: "not_published",
    accessCheck: run.access_check,
  };
}
