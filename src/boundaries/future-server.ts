import { MESSAGES } from "../contract/constants.js";

/**
 * Typed boundary for a future server.
 * Authentication, membership and RLS are not implemented.
 * This class refuses instead of allowing access.
 */
export class MembershipCheckNotImplemented {
  async assertMember(_request: {
    currentUserId: string;
    workspaceId: string;
    projectId: string;
  }): Promise<never> {
    throw Object.assign(new Error(MESSAGES.membership_check_not_implemented), {
      code: "membership_check_not_implemented",
    });
  }
}

export type FuturePersistenceKind = "postgres";

export type FuturePostgresStorage = {
  kind: FuturePersistenceKind;
  implemented: false;
};
