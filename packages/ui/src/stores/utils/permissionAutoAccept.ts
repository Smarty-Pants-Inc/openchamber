import type { Session } from "@opencode-ai/sdk/v2/client";

export type PermissionAutoAcceptMap = Record<string, boolean>;

// Retain the caller contract, but stored/ancestor policies grant no automatic
// permission authority in this fork, including for old or scheduled callers.
export const autoRespondsPermission = (_input: {
  autoAccept: PermissionAutoAcceptMap;
  sessions: Session[];
  sessionById?: ReadonlyMap<string, Session>;
  sessionID: string;
}): boolean => { void _input; return false; };
