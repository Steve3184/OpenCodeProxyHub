import type { IncomingMessage } from "node:http";
import { StringDecoder } from "node:string_decoder";
import { parseSsePayloads } from "../converters/streamAggregator.js";
import { parseUpstreamErrorPayload, type UpstreamErrorPayload } from "./opencodeAccessErrors.js";

/** Inspect complete JSON/SSE payloads before a converter can emit headers or success. */
export const readUpstreamResponse = (
  response: IncomingMessage,
  onData: (chunk: Buffer) => void,
  onEnd: () => void,
  onError: (error: UpstreamErrorPayload) => void,
): void => {
  const status = response.statusCode || 502;
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  let plainJson = false;
  let stopped = false;
  let receivedPayload = false;
  const fail = (error: UpstreamErrorPayload) => {
    stopped = true;
    onError(error);
    response.resume();
  };
  const processEvent = (event: string): boolean => {
    const payload = event.split(/\r?\n/).filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart()).join("\n").trim();
    if (!payload) {
      // Hold initial keepalives so an initial error can still set HTTP status.
      if (receivedPayload) onData(Buffer.from(event));
      return true;
    }
    const error = parseUpstreamErrorPayload(status, payload);
    if (error) {
      fail(error);
      return false;
    }
    receivedPayload = true;
    onData(Buffer.from(event));
    return true;
  };
  const processBuffer = () => {
    if (status >= 400) return;
    plainJson ||= buffer.trimStart().startsWith("{");
    if (plainJson) return;
    let boundary: RegExpExecArray | null;
    while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
      const end = boundary.index + boundary[0].length;
      const event = buffer.slice(0, end);
      buffer = buffer.slice(end);
      if (!processEvent(event)) return;
    }
  };
  response.on("data", (chunk: Buffer) => {
    if (stopped) return;
    buffer += decoder.write(chunk);
    processBuffer();
  });
  response.on("end", () => {
    if (stopped) return;
    buffer += decoder.end();
    processBuffer();
    if (stopped) return;
    if (status >= 400 || plainJson) {
      const error = (status >= 400 ? parseSsePayloads(buffer)
        .map((payload) => parseUpstreamErrorPayload(status, JSON.stringify(payload))).find(Boolean) : null)
        ?? parseUpstreamErrorPayload(status, buffer);
      if (error) return fail(error);
      if (buffer) onData(Buffer.from(buffer));
    } else if (buffer.trim() && !processEvent(`${buffer}\n\n`)) return;
    onEnd();
  });
};
