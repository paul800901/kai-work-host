import { writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const output = path.resolve(process.argv[2] ?? path.join(root, "sbom.cdx.json"));
const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const lock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));

const components = Object.entries(lock.packages)
  .filter(([location, entry]) => location.startsWith("node_modules/") && typeof entry.version === "string")
  .map(([location, entry]) => {
    const name = packageNameFromLocation(location);
    const component = {
      type: "library",
      name,
      version: entry.version,
      purl: `pkg:npm/${encodeURIComponent(name).replace("%40", "@")}@${entry.version}`,
      scope: entry.dev ? "optional" : "required",
      licenses: typeof entry.license === "string"
        ? [{ license: { id: entry.license } }]
        : [],
      properties: [
        { name: "kai:lockfile-location", value: location.replaceAll("\\", "/") },
        { name: "kai:optional", value: String(entry.optional === true) },
      ],
    };
    if (typeof entry.integrity === "string") {
      component.properties.push({ name: "npm:integrity", value: entry.integrity });
    }
    return component;
  })
  .sort((left, right) => `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`));

const pin = JSON.parse(await readFile(path.join(root, "config", "dsh-pin.json"), "utf8"));
components.push({
  type: "application",
  name: "DeepSeek Harness",
  version: pin.version,
  purl: `pkg:github/deepseek-ai/deepseek-harness@${pin.commit}`,
  scope: "required",
  licenses: [{ license: { id: "MIT" } }],
  externalReferences: [{ type: "vcs", url: pin.repository }],
  properties: [{ name: "kai:git-commit", value: pin.commit }],
});

const bom = {
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  version: 1,
  metadata: {
    component: {
      type: "application",
      name: manifest.name,
      version: manifest.version,
      licenses: [{ license: { id: manifest.license } }],
    },
    tools: { components: [{ type: "application", name: "KAI Work Host SBOM generator", version: manifest.version }] },
  },
  components,
};

await writeFile(output, `${JSON.stringify(bom, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ ok: true, output, components: components.length })}\n`);

function packageNameFromLocation(location) {
  const parts = location.split("node_modules/");
  return parts.at(-1).replaceAll("\\", "/");
}
