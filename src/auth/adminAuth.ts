import crypto from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { AdminSessionStore } from "./adminSessions.js";

export const tokenFromRequest = (request: FastifyRequest): string => {
  const raw = request.headers.authorization || request.headers["x-api-key"] || "";
  const header = (Array.isArray(raw) ? raw[0] : raw) || "";
  return header.startsWith("Bearer ") ? header.slice(7) : header;
};

export const isAdminRequest = (
  request: FastifyRequest,
  sessions: AdminSessionStore,
): boolean => {
  return sessions.validate(tokenFromRequest(request));
};

export const adminAuthMode = (
  request: FastifyRequest,
  sessions: AdminSessionStore,
): "password" | null => {
  return sessions.validate(tokenFromRequest(request)) ? "password" : null;
};

export const passwordMatches = (candidate: string, expected: string): boolean => {
  const candidateBytes = Buffer.from(candidate);
  const expectedBytes = Buffer.from(expected);
  return candidateBytes.length === expectedBytes.length && crypto.timingSafeEqual(candidateBytes, expectedBytes);
};
