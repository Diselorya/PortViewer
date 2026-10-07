import { spawnSync } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

const root = resolve(import.meta.dirname, "..");
const tauriRoot = resolve(root, "src-tauri");

function runCargo(args, extraEnvironment = {}) {
  return spawnSync("cargo", args, {
    cwd: tauriRoot,
    encoding: "utf8",
    env: { ...process.env, ...extraEnvironment },
    maxBuffer: 16 * 1024 * 1024,
  });
}

function expectFailure(result, expectedMessage) {
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (result.status === 0 || !output.includes(expectedMessage)) {
    throw new Error(
      `Expected Cargo failure containing ${JSON.stringify(expectedMessage)}.\n${output}`,
    );
  }
}

expectFailure(
  runCargo(["check", "--release"]),
  "Refusing to build PortViewer release without the `custom-protocol` feature",
);

expectFailure(
  runCargo(["check", "--release", "--features", "custom-protocol"], {
    TAURI_CONFIG: JSON.stringify({
      app: { windows: [{ label: "main", url: "http://localhost:5173" }] },
    }),
  }),
  "external and dev URLs are forbidden",
);

const assetsRoot = resolve(root, "dist", "assets");
const assetName = (await readdir(assetsRoot)).sort()[0];
if (!assetName) {
  throw new Error("dist/assets is empty; run `npm run build` first");
}
const assetPath = resolve(assetsRoot, assetName);
const originalAsset = await readFile(assetPath);
try {
  await writeFile(
    assetPath,
    Buffer.concat([
      originalAsset,
      Buffer.from("\nPORTVIEWER_GUARD_TAMPER_TEST\n"),
    ]),
  );
  expectFailure(
    runCargo(["check", "--release", "--features", "custom-protocol"]),
    "Frontend dist contents changed after identity finalization",
  );
} finally {
  await writeFile(assetPath, originalAsset);
}

const positive = runCargo([
  "check",
  "--release",
  "--features",
  "custom-protocol",
]);
if (positive.status !== 0) {
  throw new Error(
    `Build guard did not recover after restoring dist.\n${positive.stdout}\n${positive.stderr}`,
  );
}

process.stdout.write(
  "PortViewer build guard: bare release, external URL, dist tamper, and recovery checks passed.\n",
);
