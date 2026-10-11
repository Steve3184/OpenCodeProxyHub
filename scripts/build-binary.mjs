import { spawnSync } from "node:child_process";
import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";

const targets = {
  "linux-amd64": "bun-linux-x64-baseline",
  "linux-arm64": "bun-linux-arm64",
};
const platform = process.argv[2] || (process.platform === "linux" && process.arch === "arm64" ? "linux-arm64" : "linux-amd64");
if (!targets[platform]) throw new Error(`Unsupported binary platform: ${platform}`);
const output = path.resolve("releases", `opencode-proxy-hub-${platform}`);
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
const result = spawnSync("bun", ["build", "--compile", `--target=${targets[platform]}`, "--minify", "--env=disable", "--no-compile-autoload-bunfig", "src/main.ts", "--outfile", path.join(output, "opencode-proxy-hub")], { stdio: "inherit" });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
await cp("web/dist", path.join(output, "web/dist"), { recursive: true });
for (const file of ["README.md", "LICENSE", ".env.example"]) await cp(file, path.join(output, file));
console.log(`Binary distribution: ${output}`);
