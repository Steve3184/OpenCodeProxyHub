import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { registerResponseAttempt } from "../src/runtime/responseLifecycle.js";

const response = new EventEmitter();
let cleanupCalls = 0;
const first = registerResponseAttempt(response as any, () => { cleanupCalls += 1; });
const second = registerResponseAttempt(response as any, () => { cleanupCalls += 10; });

assert.equal(response.listenerCount("close"), 1, "retries must not add close listeners");
assert.equal(response.listenerCount("finish"), 1, "retries must not add finish listeners");
response.emit("close");
assert.equal(cleanupCalls, 10, "only the active retry attempt should be cleaned up");
assert.equal(first.closed, true);
assert.equal(second.closed, true);

console.log("[pass] response retries keep one close/finish listener and clean up the active attempt");
