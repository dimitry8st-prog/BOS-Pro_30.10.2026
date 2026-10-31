import { MESSAGES } from "../contract/constants.js";
import { assertTransition } from "../contract/transitions.js";
import type { RunRecord } from "../contract/types.js";
import { releaseDeadLocks, type DevStore } from "../storage/dev-store.js";
import { pidAlive } from "../storage/pid.js";
import { appendJournal, nextUserAction } from "./journal.js";

export async function recoverInterruptedRuns(store: DevStore): Promise<RunRecord[]> {
  await releaseDeadLocks(store.directory);
  const recovered: RunRecord[] = [];
  for (const run of await store.listRuns()) {
    if (run.status !== "running" && run.status !== "queued") continue;
    if (!shouldRecover(run)) continue;
    const previous = run.status;
    const code = run.cancel_requested ? "cancelled_by_user" : "interrupted";
    const message = run.cancel_requested ? MESSAGES.cancelled_by_user : MESSAGES.interrupted;
    const next = run.cancel_requested ? "cancelled" : "failed";
    assertTransition(previous, next);
    run.status = next;
    run.stop = { code, message };
    run.lease = null;
    run.quality_gate = "blocked";
    run.publication = { status: "not_published", handler: "absent", permitted: false };
    run.external_side_effects = false;
    run.recovery = {
      recovered_at: new Date().toISOString(),
      previous_status: previous,
      resulting_status: next,
      code,
      message,
    };
    run.next_user_action = nextUserAction(run);
    appendJournal(run, "recover", "ok", code);
    await store.saveRun(run);
    recovered.push(run);
  }
  return recovered;
}

function shouldRecover(run: RunRecord): boolean {
  if (!run.lease) return true;
  if (run.lease.abandoned) return true;
  if (run.lease.pid === null) return true;
  return !pidAlive(run.lease.pid);
}
