import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const output = "docs/qa/authored-hash-manifest.sha256";
const excludedDirectories = new Set([
  ".git",
  ".tmp",
  "coverage",
  "dist",
  "node_modules",
  "release",
  "target",
  "tmp",
]);
const excludedRelativeDirectories = new Set(["src-tauri/gen/schemas"]);
const textExtensions = new Set([
  ".bat",
  ".css",
  ".html",
  ".json",
  ".jsonl",
  ".md",
  ".mjs",
  ".nsi",
  ".nsh",
  ".rs",
  ".toml",
  ".ts",
  ".txt",
  ".vue",
  ".yaml",
  ".yml",
]);
const textNames = new Set([".gitignore", ".prettierignore", "LICENSE"]);

async function collect(directory, relative = "") {
  const files = [];
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name, "en"));
  for (const entry of entries) {
    const childRelative = path.posix.join(relative, entry.name);
    if (
      entry.isDirectory() &&
      (excludedDirectories.has(entry.name) ||
        excludedRelativeDirectories.has(childRelative))
    )
      continue;
    if (childRelative === output) continue;
    const child = path.join(directory, entry.name);
    if (entry.isDirectory())
      files.push(...(await collect(child, childRelative)));
    else if (
      entry.isFile() &&
      (textNames.has(entry.name) ||
        textExtensions.has(path.extname(entry.name)))
    ) {
      files.push(childRelative);
    }
  }
  return files;
}

const files = await collect(root);
const lines = [];
for (const file of files) {
  const bytes = await readFile(path.join(root, file));
  lines.push(`${createHash("sha256").update(bytes).digest("hex")}  ${file}`);
}
const header = [
  "# PortViewer authored text snapshot SHA-256",
  `# Generated: ${new Date().toISOString()}`,
  "# Excludes: this manifest, VCS/dependencies/build caches, generated images/icons and binaries.",
  "# File count: " + files.length,
];
await writeFile(
  path.join(root, output),
  `${header.concat(lines).join("\n")}\n`,
  "utf8",
);
console.log(`Wrote ${output} (${files.length} authored text files)`);
