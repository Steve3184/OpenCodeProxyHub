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
  /**
   * Atomically write without blocking the event loop on disk I/O. The caller
   * should debounce/coalesce writes when the value is large.
   */
  async writeAsync(value: T): Promise<void> {
    const contents = `${JSON.stringify(value, null, 2)}\n`;
    const parent = path.dirname(this.filePath);
    if (parent && parent !== ".") await fs.promises.mkdir(parent, { recursive: true });
    let mode = 0o600;
    try {
      mode = (await fs.promises.stat(this.filePath)).mode & 0o777;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const temporary = path.join(parent, `.${path.basename(this.filePath)}.${process.pid}.${randomUUID()}.tmp`);
    let handle: fs.promises.FileHandle | undefined;
    try {
      handle = await fs.promises.open(temporary, "wx", mode);
      await handle.chmod(mode);
      await handle.writeFile(contents, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.promises.rename(temporary, this.filePath);
    } finally {
      if (handle) await handle.close().catch(() => undefined);
      await fs.promises.unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }
  async append(value: T): Promise<void> {
    const line = `${JSON.stringify(value)}\n`;
    const parent = path.dirname(this.filePath);
    if (parent && parent !== ".") await fs.promises.mkdir(parent, { recursive: true });
    let handle: fs.promises.FileHandle | undefined;
    try {
      handle = await fs.promises.open(this.filePath, "a", 0o600);
      await handle.writeFile(line, "utf8");
      await handle.sync();
    } finally {
      if (handle) await handle.close();
    }
  }

  async appendMany(values: T[]): Promise<void> {
    if (values.length === 0) return;
    const contents = values.map((value) => `${JSON.stringify(value)}\n`).join("");
    const parent = path.dirname(this.filePath);
    if (parent && parent !== ".") await fs.promises.mkdir(parent, { recursive: true });
    let handle: fs.promises.FileHandle | undefined;
    try {
      handle = await fs.promises.open(this.filePath, "a", 0o600);
      await handle.writeFile(contents, "utf8");
      await handle.sync();
    } finally {
      if (handle) await handle.close();
    }
  }

  readLines(fallback: T[] = []): T[] {
    let contents: string;
    try {
      contents = fs.readFileSync(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
      throw new Error(`Cannot load JSON lines store ${this.filePath}: ${(error as NodeJS.ErrnoException).code || "read error"}`);
    }
    if (!contents) return [];
    const lines = contents.split("\n");
    const values: T[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line) continue;
      try {
        values.push(JSON.parse(line) as T);
      } catch (error) {
        // A process killed during append can leave only the final line partial.
        if (index === lines.length - 1 && !contents.endsWith("\n")) break;
        throw new Error(`Cannot load JSON lines store ${this.filePath}: invalid JSON`);
      }
    }
    return values;
  }

  async size(): Promise<number> {
    try {
      return (await fs.promises.stat(this.filePath)).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }
  }

  async truncate(): Promise<void> {
    const handle = await fs.promises.open(this.filePath, "w", 0o600);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}
