import { MESSAGES } from "../contract/constants.js";

/**
 * File-store boundary. Calling this class does not authorize access.
 * The local PostgreSQL path uses EducationalAuthAdapter and is not this stub.
 * Neither one is authentication for a public service.
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
