import { MESSAGES } from "./constants.js";
import { isTerminal, type RunStatus } from "./types.js";

const ALLOWED: Record<RunStatus, readonly RunStatus[]> = {
  queued: ["running", "failed", "cancelled"],
  running: ["succeeded", "failed", "cancelled"],
  waiting_approval: ["succeeded", "failed", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
};

export function assertTransition(from: RunStatus, to: RunStatus): void {
  if (!ALLOWED[from].includes(to)) {
    throw Object.assign(new Error(`${MESSAGES.illegal_transition} ${from} -> ${to}`), {
      code: "illegal_transition",
    });
  }
}

export function canEnterWaitingApproval(): false {
  return false;
}

export { isTerminal };
