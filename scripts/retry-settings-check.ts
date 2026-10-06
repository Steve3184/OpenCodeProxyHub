import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SettingsStore } from "../src/settings/settingsStore.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oph-retry-settings-"));
try {
  const store = new SettingsStore(path.join(dir, "settings.json"));
  store.load();
  assert.equal(store.get().autoRetryCount, 1, "new installs keep the existing one-retry default");

  for (const value of [0, 1, 3, 10]) {
    assert.equal(store.update({ autoRetryCount: value }).autoRetryCount, value);
  }
  for (const value of [-1, 11, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => store.update({ autoRetryCount: value }), /autoRetryCount must be between 0 and 10/);
  }
  assert.equal(store.get().autoRetryCount, 10, "invalid updates do not change the current setting");
  assert.equal(store.update({ autoRetryCount: 1.5 }).autoRetryCount, 1, "fractional values are truncated consistently with other numeric settings");
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8")).settings.autoRetryCount, 1);
  console.log("[pass] autoRetryCount defaults to 1, accepts 0-10, persists, and rejects invalid values");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
