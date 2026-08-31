import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(process.argv[2] ?? ".");
const excludedDirectories = new Set([
  ".git",
  "node_modules",
  "dist",
  "coverage",
  ".tmp",
  "credentials",
  "runtime",
  "state",
  "state-root",
  "secrets",
]);
const forbiddenBasenames = [
  /^work-host\.local\.json$/iu,
  /^\.env$/iu,
  /^\.env\.(?!example$).+$/iu,
  /^\.credentials\.ya?ml$/iu,
  /^.*\.credentials\.json$/iu,
  /^.*\.secrets\.json$/iu,
  /^.*\.secret$/iu,
  /^.*\.token$/iu,
  /^\.npmrc$/iu,
  /^handoff-.*\.ps1$/iu,
  /^LIVE_VALIDATION_.*\.md$/u,
  /\.(?:log|pem|key|pfx|p12)$/iu,
];
const textExtensions = new Set([".cjs", ".css", ".d.ts", ".html", ".js", ".json", ".md", ".mjs", ".mts", ".ps1", ".ts", ".txt", ".yaml", ".yml"]);
const signatures = [
  { name: "OpenAI-style secret", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/gu },
  { name: "tunnel identifier", pattern: /\btunnel_[A-Za-z0-9_-]{16,}\b/gu },
  { name: "embedded JSON secret", pattern: /"(?:access_token|refresh_token|client_secret|api_key)"\s*:\s*"(?!<|\$\{|REDACTED|example)[^"\r\n]{8,}"/giu },
  { name: "user-specific Windows profile", pattern: /C:\\Users\\[^\\\s"']+/giu },
  { name: "maintainer-specific path", pattern: /D:\\(?:KAI|DSH架構)(?:\\|\b)/giu },
  { name: "maintainer identity", pattern: /\bPaulus\b/gu },
];

const violations = [];
let inspected = 0;
let excluded = 0;
await walk(root);
if (violations.length > 0) {
  process.stderr.write(`${violations.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`${JSON.stringify({ ok: true, root, inspectedFiles: inspected, excludedEntries: excluded })}\n`);
}

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    const relative = path.relative(root, absolute).replaceAll("\\", "/");
    if (entry.isDirectory()) {
      const isRootReleaseOutput = directory === root && entry.name === "release";
      const isTemporaryVerificationTree = /^\.(?:stage|verify)-/u.test(entry.name);
      if (excludedDirectories.has(entry.name) || isRootReleaseOutput || isTemporaryVerificationTree) {
        excluded += 1;
        continue;
      }
      await walk(absolute);
      continue;
    }
    if (entry.isSymbolicLink()) {
      violations.push(`${relative}: symbolic links are not allowed in the public release tree`);
      continue;
    }
    if (!entry.isFile()) continue;
    if (forbiddenBasenames.some((pattern) => pattern.test(entry.name))) { excluded += 1; continue; }
    const extension = compoundExtension(entry.name);
    if (!textExtensions.has(extension)) continue;
    const metadata = await lstat(absolute);
    if (metadata.size > 2_000_000) continue;
    const content = await readFile(absolute, "utf8");
    inspected += 1;
    for (const signature of signatures) {
      signature.pattern.lastIndex = 0;
      if (signature.pattern.test(content)) violations.push(`${relative}: ${signature.name}`);
    }
  }
}

function compoundExtension(filename) {
  if (filename.endsWith(".d.ts")) return ".d.ts";
  return path.extname(filename).toLowerCase();
}
