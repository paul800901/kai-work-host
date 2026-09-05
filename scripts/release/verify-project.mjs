import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const [manifest, sbom, runtimePin, version] = await Promise.all([
  readJson(path.join(root, "package.json")),
  readJson(path.join(root, "sbom.cdx.json")),
  import("../../src/codex-pin.ts"),
  import("../../src/version.ts"),
]);

assert.equal(manifest.name, version.HOST_PACKAGE_NAME);
assert.equal(manifest.version, version.HOST_VERSION);
assert.equal(manifest.license, "MIT");
assert.equal(manifest.private, true, "private:true prevents accidental npm publication; it does not restrict the MIT source license");
assert.equal(manifest.dependencies["@openai/codex"], runtimePin.CODEX_VERSION);
assert.equal(version.PUBLIC_TOOL_COUNT, 18);
assert.equal(version.RAW_TOOL_COUNT, 19);
assert.equal(sbom.bomFormat, "CycloneDX");
assert.equal(sbom.specVersion, "1.5");
assert.equal(sbom.metadata?.component?.name, manifest.name);
assert.equal(sbom.metadata?.component?.version, manifest.version);
assert.ok(
  sbom.components?.some((component) =>
    component.name === "@openai/codex" && component.version === runtimePin.CODEX_VERSION),
  "SBOM must include the exact official Codex package",
);
for (const dependency of Object.keys(manifest.dependencies ?? {})) {
  assert.ok(
    sbom.components?.some((component) => component.name === dependency),
    `SBOM must include runtime dependency ${dependency}`,
  );
}

for (const required of [
  "LICENSE",
  "NOTICE",
  "THIRD_PARTY_NOTICES.md",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "CODE_OF_CONDUCT.md",
  "README.en.md",
  "sbom.cdx.json",
  "docs/THREAT_MODEL.md",
  "docs/DEPLOYMENT_WINDOWS.md",
  "docs/RELEASE.md",
]) {
  const content = await readFile(path.join(root, required), "utf8");
  assert.ok(content.trim().length > 0, `${required} must not be empty`);
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  package: manifest.name,
  version: manifest.version,
  license: manifest.license,
  codex: { version: runtimePin.CODEX_VERSION },
  publicTools: version.PUBLIC_TOOL_COUNT,
  rawTools: version.RAW_TOOL_COUNT,
})}\n`);

async function readJson(filename) {
  return JSON.parse(await readFile(filename, "utf8"));
}
