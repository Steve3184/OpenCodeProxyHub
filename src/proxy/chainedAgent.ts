import https from "node:https";
import type { Duplex } from "node:stream";
import net from "node:net";
import tls from "node:tls";
import { ProxyConnectError } from "./connectionState.js";

const readUntil = (socket: net.Socket, marker: Buffer): Promise<Buffer> => new Promise((resolve, reject) => {
  let buffer = Buffer.alloc(0);
  const onData = (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (!buffer.includes(marker)) return;
    cleanup();
    resolve(buffer);
  };
  const onError = (error: Error) => {
    cleanup();
    reject(error);
  };
  const cleanup = () => {
    socket.off("data", onData);
    socket.off("error", onError);
  };
  socket.on("data", onData);
  socket.on("error", onError);
});

const readN = (socket: net.Socket, length: number): Promise<Buffer> => new Promise((resolve, reject) => {
  let buffer = Buffer.alloc(0);
  const onData = (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length < length) return;
    cleanup();
    resolve(buffer);
  };
  const onError = (error: Error) => {
    cleanup();
    reject(error);
  };
  const cleanup = () => {
    socket.off("data", onData);
    socket.off("error", onError);
  };
  socket.on("data", onData);
  socket.on("error", onError);
});

const authHeader = (proxy: URL): string => {
  if (!proxy.username && !proxy.password) return "";
  const username = decodeURIComponent(proxy.username);
  const password = decodeURIComponent(proxy.password);
  return `Proxy-Authorization: Basic ${Buffer.from(`${username}:${password}`).toString("base64")}\r\n`;
};

const connectToPreProxy = async (preProxy: URL, timeout: number): Promise<net.Socket> => {
  const port = Number(preProxy.port || (preProxy.protocol === "https:" ? 443 : 80));
  const rawSocket = net.connect(port, preProxy.hostname);
  rawSocket.setTimeout(timeout);

  await new Promise<void>((resolve, reject) => {
    rawSocket.once("connect", resolve);
    rawSocket.once("error", reject);
    rawSocket.once("timeout", () => reject(new Error("Pre-proxy connection timeout")));
  });

  if (preProxy.protocol !== "https:") return rawSocket;

  return new Promise<tls.TLSSocket>((resolve, reject) => {
    const socket = tls.connect({ socket: rawSocket, servername: preProxy.hostname }, () => resolve(socket));
    socket.once("error", reject);
  });
};

const httpConnect = async (socket: net.Socket, host: string, port: number, proxy?: URL, label = "Proxy"): Promise<void> => {
  socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${proxy ? authHeader(proxy) : ""}\r\n`);
  const response = await readUntil(socket, Buffer.from("\r\n\r\n"));
  const statusCode = Number(response.toString("utf8").match(/^HTTP\/\d\.\d\s+(\d{3})\b/)?.[1]) || 502;
  if (statusCode !== 200) {
    socket.destroy();
    throw new ProxyConnectError(`${label} CONNECT failed with HTTP ${statusCode}`, statusCode);
  }
};

class ChainedAgentBase extends https.Agent {
  protected readonly preProxy: URL;

  constructor(preProxyUrl: string) {
    super({ keepAlive: false });
    this.preProxy = new URL(preProxyUrl);
    if (!["http:", "https:"].includes(this.preProxy.protocol)) throw new Error("Pre-proxy must use http:// or https://");
  }

  override createConnection(options: any, callback?: (error: Error | null, socket: Duplex) => void): Duplex | null | undefined {
    this.createChainedConnection(options)
      .then((socket) => callback?.(null, socket))
      .catch((error) => {
        this.emit("proxyConnectError", error);
        callback?.(error, new net.Socket());
      });
    return undefined;
  }

  protected async createChainedConnection(_options: any): Promise<net.Socket> {
    throw new Error("Not implemented");
  }
}

export class HttpPreProxyToSocksAgent extends ChainedAgentBase {
  private readonly socksProxy: URL;

  constructor(preProxyUrl: string, socksProxyUrl: string) {
    super(preProxyUrl);
    this.socksProxy = new URL(socksProxyUrl);
    if (!this.socksProxy.protocol.startsWith("socks")) throw new Error("Chained proxy target must be SOCKS");
  }

  protected override async createChainedConnection(options: any): Promise<net.Socket> {
    const preProxySocket = await connectToPreProxy(this.preProxy, Number(options.timeout || 120000));

    const socksHost = this.socksProxy.hostname;
    const socksPort = Number(this.socksProxy.port || 1080);
    await httpConnect(preProxySocket, socksHost, socksPort, this.preProxy, "Pre-proxy");

    preProxySocket.write(Buffer.from([0x05, 0x01, 0x02]));
    const method = await readN(preProxySocket, 2);
    if (method[0] !== 0x05 || method[1] !== 0x02) throw new Error("SOCKS5 username/password auth is not accepted");

    const username = Buffer.from(decodeURIComponent(this.socksProxy.username));
    const password = Buffer.from(decodeURIComponent(this.socksProxy.password));
    preProxySocket.write(Buffer.concat([Buffer.from([0x01, username.length]), username, Buffer.from([password.length]), password]));
    const auth = await readN(preProxySocket, 2);
    if (auth[1] !== 0x00) throw new Error("SOCKS5 authentication failed");

    const targetHost = Buffer.from(String(options.host || options.hostname));
    const targetPort = Number(options.port || 443);
    preProxySocket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, targetHost.length]), targetHost, Buffer.from([(targetPort >> 8) & 0xff, targetPort & 0xff])]));
    const socksConnect = await readN(preProxySocket, 10);
    if (socksConnect[1] !== 0x00) throw new Error(`SOCKS5 connect failed with code ${socksConnect[1]}`);

    return tls.connect({ socket: preProxySocket, servername: String(options.servername || options.host || options.hostname) });
  }
}

export class HttpPreProxyToHttpAgent extends ChainedAgentBase {
  private readonly httpProxy: URL;

  constructor(preProxyUrl: string, httpProxyUrl: string) {
    super(preProxyUrl);
    this.httpProxy = new URL(httpProxyUrl);
    if (!["http:", "https:"].includes(this.httpProxy.protocol)) throw new Error("Chained proxy target must be HTTP/HTTPS");
  }

  protected override async createChainedConnection(options: any): Promise<net.Socket> {
    const preProxySocket = await connectToPreProxy(this.preProxy, Number(options.timeout || 120000));
    const proxyHost = this.httpProxy.hostname;
    const proxyPort = Number(this.httpProxy.port || (this.httpProxy.protocol === "https:" ? 443 : 80));

    await httpConnect(preProxySocket, proxyHost, proxyPort, this.preProxy, "Pre-proxy");

    const proxySocket = this.httpProxy.protocol === "https:"
      ? await new Promise<tls.TLSSocket>((resolve, reject) => {
        const socket = tls.connect({ socket: preProxySocket, servername: proxyHost }, () => resolve(socket));
        socket.once("error", reject);
      })
      : preProxySocket;

    const targetHost = String(options.host || options.hostname);
    const targetPort = Number(options.port || 443);
    await httpConnect(proxySocket, targetHost, targetPort, this.httpProxy, "HTTP proxy");

    return tls.connect({ socket: proxySocket, servername: String(options.servername || targetHost) });
  }
}
