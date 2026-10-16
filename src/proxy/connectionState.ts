import type https from "node:https";
import type { HttpsProxyAgent } from "https-proxy-agent";

/** State belongs to one agent/lease, so concurrent requests cannot mix failures. */
export interface ProxyConnectionState {
  failed: boolean;
  statusCode?: number;
  message?: string;
}

export class ProxyConnectError extends Error {
  readonly proxyConnect = true;

  constructor(message: string, readonly statusCode = 502) {
    super(message);
    this.name = "ProxyConnectError";
  }
}

export const isProxyConnectFailure = (connection?: ProxyConnectionState, body = ""): boolean => (
  Boolean(connection?.failed) || /not enough bandwidth|bandwidth limit reached|(?:HTTP proxy|Pre-proxy|Proxy) CONNECT failed/i.test(body)
);

export const trackProxyConnection = (agent: https.Agent): ProxyConnectionState => {
  const state: ProxyConnectionState = { failed: false };
  const fail = (error: unknown) => {
    state.failed = true;
    state.message = error instanceof Error ? error.message : "Proxy CONNECT failed";
    if (error instanceof ProxyConnectError) state.statusCode = error.statusCode;
  };
  // HttpsProxyAgent replays non-200 CONNECT replies as HTTP responses. Observe
  // the handshake itself rather than guessing their origin from HTTP status.
  agent.on("proxyConnect", ({ statusCode }: { statusCode: number }) => {
    if (statusCode === 200) return;
    fail(new ProxyConnectError(`Proxy CONNECT failed with HTTP ${statusCode}`, statusCode));
  });
  agent.on("proxyConnectError", fail);

  // HTTP and SOCKS agent-base implementations reject connect() for transport,
  // DNS and authentication failures before an upstream response can exist.
  const connector = agent as https.Agent & Partial<Pick<HttpsProxyAgent<string>, "connect">>;
  const connect = connector.connect;
  if (connect) {
    connector.connect = async function (...args) {
      try {
        return await connect.apply(this, args);
      } catch (error) {
        fail(error);
        throw error;
      }
    };
  }
  return state;
};
