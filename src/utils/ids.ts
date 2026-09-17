import crypto from "node:crypto";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

// Mirrors upstream Identifier.create(): time component is (ms * 0x1000 + counter) packed into 6 bytes
let lastTimestamp = 0;
let counter = 0;

export const ocId = (prefix: string): string => {
  const currentTimestamp = Date.now();
  if (currentTimestamp !== lastTimestamp) {
    lastTimestamp = currentTimestamp;
    counter = 0;
  }
  counter++;
  const now = BigInt(currentTimestamp) * BigInt(0x1000) + BigInt(counter);
  const timeBytes = Buffer.alloc(6);
  for (let i = 0; i < 6; i++) {
    timeBytes[i] = Number((now >> BigInt(40 - 8 * i)) & BigInt(0xff));
  }
  const rnd = Array.from(crypto.randomBytes(14), (b) => BASE62[b % 62]).join("");
  return `${prefix}_${timeBytes.toString("hex")}${rnd}`;
};
