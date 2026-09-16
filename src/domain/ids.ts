import { v4 as uuidv4 } from "uuid";

function prefixed(prefix: string): string {
  return `${prefix}${uuidv4()}`;
}

export function newRequestId(): string {
  return prefixed("req_");
}

export function newSessionId(): string {
  return prefixed("sess_");
}

export function newMessageId(): string {
  return prefixed("msg_");
}

export function newGenerationId(): string {
  return prefixed("gen_");
}

export function newAttemptId(): string {
  return prefixed("att_");
}

export function newLeaseId(): string {
  return prefixed("lease_");
}

export function newOwnerToken(): string {
  return prefixed("own_");
}

export function newEventId(): string {
  return prefixed("evt_");
}

export function newBranchId(): string {
  return prefixed("br_");
}

export function newSnapshotId(): string {
  return prefixed("snap_");
}

export function newOperationId(): string {
  return prefixed("op_");
}

export function newJobId(): string {
  return prefixed("job_");
}
