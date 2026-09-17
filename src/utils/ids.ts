import crypto from "node:crypto";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export const ocId = (prefix: string): string => {
  const ts = Date.now().toString(16).padStart(12, "0");
  const rnd = Array.from(crypto.randomBytes(14), (b) => BASE62[b % 62]).join("");
  return `${prefix}_${ts}${rnd}`;
};
