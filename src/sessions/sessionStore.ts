import { ocId } from "../utils/ids.js";

const firstHeader = (value: string | string[] | undefined): string | undefined => Array.isArray(value) ? value[0] : value;

export class SessionStore {
  /**
   * OpenCode binds free-tier request identities to the egress path. Reusing an
   * x-opencode-session after proxy rotation can trigger a false "outside
   * OpenCode" 403, so each upstream attempt gets a fresh session id.
   */
  getSession(_scope: string): string {
    return ocId("ses");
  }
}

export const sessionScopeFromHeaders = (
  keyId: string,
  protocol: "openai" | "anthropic" | "responses" | "systemone",
  model: string,
  headers: Record<string, string | string[] | undefined>,
): string => {
  const explicitSession = firstHeader(headers["x-session-id"]);
  const clientId = firstHeader(headers["x-client-id"]) || firstHeader(headers["x-device-id"]);
  const clientScope = explicitSession || clientId || ocId("anon");
  return `${keyId}:${protocol}:${model}:${clientScope}`;
};
