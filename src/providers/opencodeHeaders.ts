import { ocId } from "../utils/ids.js";

// Verified against @opencode/cli 2.0.29. Send the canonical session header and
// its legacy alias together; both must carry a valid descending session ID.
export const OPENCODE_USER_AGENT = "opencode/latest/2.0.29/cli";

/** Shared by inference and proxy health checks so their wire identity agrees. */
export const createOpenCodeHeaders = (body: string, sessionId: string): Record<string, string | number> => ({
  "Accept-Encoding": "identity",
  "Content-Type": "application/json",
  "Content-Length": Buffer.byteLength(body),
  Authorization: "Bearer public",
  "User-Agent": OPENCODE_USER_AGENT,
  "x-opencode-client": "cli",
  "x-opencode-project": "global",
  "x-opencode-request": ocId("msg"),
  "x-opencode-session": sessionId,
  "x-opencode-session-id": sessionId,
});
