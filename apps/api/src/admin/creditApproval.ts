import { ConflictError } from "../lib/errors.js";

/** An operator on one side of a credit's two-person control. */
export interface CreditActor {
  adminUserId: string;
  displayName: string;
}

/** Two-person control: the operator who approves a credit must not be the one who requested it. */
export function assertDistinctApprover(requester: CreditActor, approver: CreditActor): void {
  // Compare identities, not display names: names are mutable and need not be
  // unique, so a renamed requester could approve their own credit.
  if (approver.adminUserId === requester.adminUserId) {
    throw new ConflictError("self_approval_forbidden");
  }
}
