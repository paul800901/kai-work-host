import { randomBytes } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function atomicWriteFile(target: string, content: string): void {
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, target);
}
