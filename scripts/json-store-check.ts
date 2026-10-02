import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { JsonFileStore } from "../src/storage/jsonFile.js";
import { ProxyPoolStore } from "../src/proxy/proxyPool.js";
import { SettingsStore } from "../src/settings/settingsStore.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oph-json-store-"));
try {
  const file = path.join(dir, "proxies.json");
  const store = new JsonFileStore<{ version: number; proxies: unknown[] }>(file);
  const original = { version: 1, proxies: [{ id: "retained", enabled: false }] };
  const next = { version: 1, proxies: [{ id: "new", enabled: true }] };
  assert.deepEqual(store.read({ version: 1, proxies: [] }), { version: 1, proxies: [] });
  store.write(original);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  fs.chmodSync(file, 0o640);
  store.write(next);
  assert.equal(fs.statSync(file).mode & 0o777, 0o640);
  assert.deepEqual(store.read(original), next);
  store.write(original);

  const originalWrite = fs.writeFileSync;
  fs.writeFileSync = ((target: any, ...args: any[]) => {
    if (typeof target === "number") {
      fs.writeSync(target, '{"partial":');
      throw Object.assign(new Error("Disk full"), { code: "ENOSPC" });
    }
    return (originalWrite as any)(target, ...args);
  }) as typeof fs.writeFileSync;
  try {
    assert.throws(() => store.write(next), /Disk full/);
  } finally { fs.writeFileSync = originalWrite; }
  assert.deepEqual(store.read(next), original);
  assert.deepEqual(fs.readdirSync(dir), ["proxies.json"]);

  const originalRename = fs.renameSync;
  fs.renameSync = (() => { throw Object.assign(new Error("Rename denied"), { code: "EACCES" }); }) as typeof fs.renameSync;
  try { assert.throws(() => store.write(next), /Rename denied/); }
  finally { fs.renameSync = originalRename; }
  assert.deepEqual(store.read(next), original);
  assert.deepEqual(fs.readdirSync(dir), ["proxies.json"]);
  console.log("[pass] atomic writes preserve existing data on partial writes and rename failures; modes preserved and temporary files cleaned");

  const moduleUrl = new URL("../src/storage/jsonFile.ts", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import fs from 'node:fs';
    import {JsonFileStore} from ${JSON.stringify(moduleUrl)};
    const write=fs.writeFileSync;
    fs.writeFileSync=(target,...args)=>{
      if(typeof target==='number') {fs.writeSync(target,'{"partial":');process.kill(process.pid,'SIGKILL');}
      return write(target,...args);
    };
    new JsonFileStore(${JSON.stringify(file)}).write(${JSON.stringify(next)});
  `], { encoding: "utf8" });
  assert.equal(child.signal, "SIGKILL", child.stderr);
  assert.deepEqual(store.read(next), original);
  console.log("[pass] killing a writer after truncating/writing its temporary file leaves the original JSON intact");

  const settings = new SettingsStore(path.join(dir, "settings.json"), {});
  settings.load();
  for (const bad of ["", '{"password":"TEST_SECRET",bad', '{"version":1,"proxies":null}']) {
    fs.writeFileSync(file, bad);
    const pool = new ProxyPoolStore(file, settings);
    let failure: unknown;
    try { pool.load(); } catch (error) { failure = error; }
    assert.ok(failure instanceof Error);
    assert.ok(!String(failure).includes("TEST_SECRET"));
    assert.equal(fs.readFileSync(file, "utf8"), bad);
  }
  const directoryStore = new JsonFileStore(dir);
  assert.throws(() => directoryStore.read({}), /existing file left unchanged/);
  assert.deepEqual(new JsonFileStore(path.join(dir, "missing.json")).read({ fresh: true }), { fresh: true });
  console.log("[pass] empty, malformed and invalid proxy stores fail startup without being overwritten; only ENOENT uses defaults and errors do not expose file contents");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
