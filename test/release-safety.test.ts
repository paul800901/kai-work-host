import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));

test("package metadata points at the public GitHub repository", () => {
  const manifest = JSON.parse(readFileSync(path.join(projectRoot, "package.json"), "utf8"));
  assert.deepEqual(manifest.repository, {
    type: "git",
    url: "git+https://github.com/paul800901/kai-work-host.git",
  });
  assert.equal(manifest.homepage, "https://github.com/paul800901/kai-work-host#readme");
  assert.equal(manifest.bugs?.url, "https://github.com/paul800901/kai-work-host/issues");
});

test("tag releases enforce version identity and the complete keyless install gate", () => {
  const workflow = readFileSync(path.join(projectRoot, ".github", "workflows", "release.yml"), "utf8");
  assert.match(workflow, /GITHUB_REF_NAME -ne \$expectedTag/u);
  assert.match(workflow, /npm run validate/u);
  assert.match(workflow, /-SourceTag \$env:GITHUB_REF_NAME/u);
  assert.match(workflow, /Release manifest does not match the clean tag source/u);
  assert.match(workflow, /install-windows\.ps1/u);
  assert.match(workflow, /verify-windows\.ps1/u);
  assert.match(workflow, /Expected four release assets/u);
});

test("public-tree scan excludes local state roots and local secret files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kai-work-host-public-scan-"));
  const syntheticSecret = "sk-" + "test-secret-value-1234567890";
  try {
    await writeFile(path.join(root, "README.md"), "# fixture\n");
    for (const directory of ["credentials", "runtime", "state", "state-root", "secrets"]) {
      await mkdir(path.join(root, directory));
      await writeFile(path.join(root, directory, "leak.json"), `${JSON.stringify({ api_key: syntheticSecret })}\n`);
    }
    for (const filename of [".env", ".env.local", "local.credentials.json", "local.secrets.json", "runtime.secret", "bearer.token"]) {
      await writeFile(path.join(root, filename), `${syntheticSecret}\n`);
    }

    const output = execFileSync(
      process.execPath,
      [path.join(projectRoot, "scripts", "release", "scan-public-tree.mjs"), root],
      { encoding: "utf8" },
    );
    const result = JSON.parse(output);
    assert.equal(result.ok, true);
    assert.equal(result.inspectedFiles, 1);
    assert.ok(result.excludedEntries >= 10);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release and installer scripts reject source-tree output targets before packaging or install", () => {
  const sourceTreeOutput = path.join(projectRoot, "release-test-output");
  const release = spawnSync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(projectRoot, "scripts", "release", "create-release.ps1"),
      "-OutputDirectory",
      sourceTreeOutput,
      "-SkipValidation",
      "-AllowUncommitted",
    ],
    { encoding: "utf8" },
  );
  assert.notEqual(release.status, 0);
  assert.match(`${release.stdout}\n${release.stderr}`, /OutputDirectory must be outside the source tree/u);

  const install = spawnSync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(projectRoot, "scripts", "deploy", "install-windows.ps1"),
      "-InstanceId",
      "east",
      "-InstallRoot",
      path.join(projectRoot, "install-test-output"),
      "-SkipValidation",
      "-NoDshBootstrap",
    ],
    { encoding: "utf8" },
  );
  assert.notEqual(install.status, 0);
  assert.match(`${install.stdout}\n${install.stderr}`, /InstallRoot must be outside the source or extracted release tree/u);
});
