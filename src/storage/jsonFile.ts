import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export class JsonFileStore<T> {
  constructor(private readonly filePath: string) {}

  read(fallback: T): T {
    try {
      return JSON.parse(fs.readFileSync(this.filePath, "utf8")) as T;
    } catch (error) {
      // Only a genuinely missing store is a fresh installation. Treating a
      // truncated/unreadable file as empty lets load() destroy persisted data.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
      // Do not include JSON parser messages: they can contain credentials.
      const reason = error instanceof SyntaxError ? "invalid JSON" : (error as NodeJS.ErrnoException).code || "read error";
      throw new Error(`Cannot load JSON store ${this.filePath}: ${reason}; existing file left unchanged`);
    }
  }

  write(value: T): void {
    const contents = `${JSON.stringify(value, null, 2)}\n`;
    const parent = path.dirname(this.filePath);
    if (parent && parent !== ".") fs.mkdirSync(parent, { recursive: true });
    let mode = 0o600;
    try {
      mode = fs.statSync(this.filePath).mode & 0o777;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    // A same-directory rename publishes a complete file atomically. A signal,
    // failed write or full disk can only damage the temporary file, never the
    // previous configuration. Keep its existing access mode when replacing it.
    const temporary = path.join(parent, `.${path.basename(this.filePath)}.${process.pid}.${randomUUID()}.tmp`);
    let fd: number | undefined;
    try {
      fd = fs.openSync(temporary, "wx", mode);
      fs.fchmodSync(fd, mode);
      fs.writeFileSync(fd, contents, "utf8");
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(temporary, this.filePath);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }
}
