import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CHECKSUM_ASSETS,
  PACKAGE_ASSETS,
  REQUIRED_CI_JOBS,
  assertSuccessfulCi,
  expectedAssetNames,
  normalizeConfig,
  parseArgs,
  parseChecksumManifest,
  parseVersion,
  sanitizeReadme,
  validateChecksumCoverage,
  validateContentRange,
  validateReleaseAssets,
} from "./release-lib.mjs";
import { createPublicSnapshot, git } from "./sync-public-remote.mjs";
import {
  downloadAsset,
  installLocalRelease,
  readTarEntries,
  readZipEntries,
  safeArchivePath,
  validateLocalAssets,
  validateWebArchive,
} from "./release-assets.mjs";
import {
  GitHubClient,
  ensureTag,
  publishVerifiedRelease,
  waitForCi,
} from "./release-github.mjs";
import {
  assetDirectory,
  digest,
  inspectInstallers,
  tar,
  temporary,
  webFiles,
  zip,
} from "./__tests__/release-fixtures.mjs";
import {
  dispatchReleaseWithJournal,
  assertFrozenRefs,
  readProductVersion,
  synchronizeRemotes,
  validateRemoteUrls,
} from "./release.mjs";

const SHA = "a".repeat(40);
const DIGEST = "b".repeat(64);
const greenJobs = () =>
  REQUIRED_CI_JOBS.map((name) => ({
    name,
    status: "completed",
    conclusion: "success",
  }));
const greenRun = (patch = {}) => ({
  head_sha: SHA,
  event: "push",
  head_branch: "main",
  status: "completed",
  conclusion: "success",
  ...patch,
});
const assets = () =>
  expectedAssetNames().map((name) => ({
    name,
    size: 128,
    digest: `sha256:${DIGEST}`,
  }));
const manifest = (names) =>
  names.map((name) => `${DIGEST}  ${name}`).join("\n");

test("should accept stable release versions and reject malformed tags", () => {
  assert.equal(parseVersion("v1.2.0"), "1.2.0");
  assert.equal(parseVersion("1.2.0"), "1.2.0");
  for (const value of [
    "1.2",
    "v1.2.0-rc.1",
    "v1.2.0/other",
    " 1.2.0",
    "v1.2.0\n",
    null,
  ]) {
    assert.throws(() => parseVersion(value));
  }
});

test("should parse explicit remote mappings and reject missing or unsafe arguments", () => {
  assert.equal(
    parseArgs(["--tag", "v1.2.0", "--expected-sha", SHA]).expectedSha,
    SHA,
  );
  for (const argv of [
    ["--tag"],
    ["--unknown"],
    ["--expected-sha", "abc"],
    ["--workflow-gate", "--workflow-publish"],
  ]) {
    assert.throws(() => parseArgs(argv));
  }
});

test("should route every configured remote explicitly while isolating private history", () => {
  assert.deepEqual(normalizeConfig().remotes, [
    { name: "github", source: "public-release", destination: "main" },
    { name: "lc-server", source: "main", destination: "main" },
  ]);
  assert.throws(() =>
    normalizeConfig({ remotes: ["github=main:main", "lc-server=main:main"] }),
  );
  assert.throws(() => normalizeConfig({}, ["github", "lc-server", "backup"]));
  assert.throws(() =>
    normalizeConfig({
      remotes: ["github=public-release:main", "github=main:main"],
    }),
  );
  assert.throws(() =>
    normalizeConfig({
      remotes: ["github=public-release:main", "lc-server=main:../bad"],
    }),
  );
});

test("should reject alternate GitHub push URLs and private-main aliases", () => {
  const config = normalizeConfig();
  const normal = (args) =>
    args.at(-1) === "github"
      ? "https://github.com/Diselorya/PortViewer.git"
      : "http://server.home:6610/PortViewer/";
  assert.doesNotThrow(() => validateRemoteUrls(config, { gitRunner: normal }));
  assert.throws(
    () =>
      validateRemoteUrls(config, {
        gitRunner: (args) =>
          args.includes("--push") && args.at(-1) === "github"
            ? "https://github.com/attacker/other.git"
            : normal(args),
      }),
    /推送地址/,
  );
  assert.throws(
    () =>
      validateRemoteUrls(config, {
        gitRunner: (args) =>
          args.at(-1) === "lc-server"
            ? "git@github.com:private-leak/repo.git"
            : normal(args),
      }),
    /GitHub 别名/,
  );
  assert.throws(
    () =>
      validateRemoteUrls(config, {
        gitRunner: (args) =>
          args.includes("--push")
            ? `${normal(args)}\nhttps://github.com/attacker/other.git`
            : normal(args),
      }),
    /一个推送地址/,
  );
  assert.throws(
    () =>
      validateRemoteUrls(config, {
        gitRunner: (args) =>
          args.at(-1) === "lc-server"
            ? "https://user:secret@private.invalid/repo.git"
            : normal(args),
      }),
    /不可内嵌凭据/,
  );
});

test("should reject inconsistent versions across the seven product metadata files", async (t) => {
  const root = await temporary(t);
  await mkdir(path.join(root, "src-tauri"));
  await mkdir(path.join(root, "web-service"));
  const files = {
    "package.json": JSON.stringify({ version: "1.2.0" }),
    "package-lock.json": JSON.stringify({
      version: "1.2.0",
      packages: { "": { version: "1.2.0" } },
    }),
    "src-tauri/tauri.conf.json": JSON.stringify({ version: "1.2.0" }),
    "src-tauri/Cargo.toml":
      '[package]\nname = "portviewer-app"\nversion = "1.2.0"\n',
    "web-service/Cargo.toml":
      '[package]\nname = "portviewer-web"\nversion = "1.2.0"\n',
    "src-tauri/Cargo.lock":
      '[[package]]\nname = "portviewer-app"\nversion = "1.2.0"\n',
    "web-service/Cargo.lock":
      '[[package]]\nname = "portviewer-app"\nversion = "1.2.0"\n\n[[package]]\nname = "portviewer-web"\nversion = "1.2.0"\n',
  };
  for (const [name, contents] of Object.entries(files))
    await writeFile(path.join(root, name), contents);
  assert.equal(await readProductVersion(root), "1.2.0");
  for (const [name, contents] of Object.entries(files)) {
    await writeFile(
      path.join(root, name),
      contents.replaceAll("1.2.0", "1.1.0"),
    );
    await assert.rejects(readProductVersion(root), /版本不一致/);
    await writeFile(path.join(root, name), contents);
  }
});

test("should require all CI jobs to pass for the exact public source commit", () => {
  assert.equal(assertSuccessfulCi(greenRun(), greenJobs(), SHA).head_sha, SHA);
  for (const run of [
    greenRun({ head_sha: "c".repeat(40) }),
    greenRun({ event: "workflow_dispatch" }),
    greenRun({ head_branch: "other" }),
    greenRun({ status: "in_progress" }),
    greenRun({ conclusion: "failure" }),
    greenRun({ conclusion: "cancelled" }),
  ])
    assert.throws(() => assertSuccessfulCi(run, greenJobs(), SHA));
  assert.throws(() =>
    assertSuccessfulCi(greenRun(), greenJobs().slice(0, 1), SHA),
  );
  assert.throws(() =>
    assertSuccessfulCi(
      greenRun(),
      greenJobs().map((job) => ({ ...job, conclusion: "skipped" })),
      SHA,
    ),
  );
});

test("should require exactly four packages and two checksum manifests with GitHub digests", () => {
  assert.equal(validateReleaseAssets(assets()).length, 6);
  assert.equal(
    expectedAssetNames().length,
    PACKAGE_ASSETS.length + CHECKSUM_ASSETS.length,
  );
  for (const list of [
    assets().slice(0, 5),
    [...assets(), { name: "extra.txt", size: 1, digest: `sha256:${DIGEST}` }],
    assets().map((asset, index) =>
      index === 0 ? { ...asset, name: assets()[1].name } : asset,
    ),
  ]) {
    assert.throws(() => validateReleaseAssets(list));
  }
  for (const patch of [
    { size: 0 },
    { size: 1.5 },
    { size: 1024 ** 3 + 1 },
    { digest: undefined },
    { digest: "sha256:bad" },
  ]) {
    assert.throws(() =>
      validateReleaseAssets(
        assets().map((asset, index) =>
          index ? asset : { ...asset, ...patch },
        ),
      ),
    );
  }
});

test("should verify complete platform-specific checksum coverage", () => {
  assert.equal(
    validateChecksumCoverage(
      manifest(PACKAGE_ASSETS.slice(0, 3)),
      manifest(PACKAGE_ASSETS.slice(3)),
    ).size,
    4,
  );
  assert.throws(() =>
    validateChecksumCoverage(
      manifest(PACKAGE_ASSETS.slice(0, 2)),
      manifest(PACKAGE_ASSETS.slice(3)),
    ),
  );
  assert.throws(() =>
    validateChecksumCoverage(
      manifest(PACKAGE_ASSETS.slice(0, 3)),
      manifest(PACKAGE_ASSETS.slice(0, 1)),
    ),
  );
});

test("should reject malformed, duplicate and path-traversing checksum entries", () => {
  assert.equal(
    parseChecksumManifest(
      `\uFEFF${DIGEST.toUpperCase()} *${PACKAGE_ASSETS[0]}\r\n`,
    ).get(PACKAGE_ASSETS[0]),
    DIGEST,
  );
  for (const text of [
    "",
    `bad  ${PACKAGE_ASSETS[0]}`,
    `${DIGEST}  ../${PACKAGE_ASSETS[0]}`,
    `${DIGEST}  sub\\${PACKAGE_ASSETS[0]}`,
    manifest([PACKAGE_ASSETS[0], PACKAGE_ASSETS[0]]),
    `${DIGEST}  unknown.exe`,
  ]) {
    assert.throws(() => parseChecksumManifest(text));
  }
});

test("should reject Content-Range responses for a different byte interval or total", () => {
  assert.equal(validateContentRange("bytes 4-7/12", 4, 7, 12), 4);
  for (const header of [
    null,
    "bytes 0-3/12",
    "bytes 4-7/13",
    "bytes 4-8/12",
    "bytes */12",
    "bytes 4-7/*",
  ]) {
    assert.throws(() => validateContentRange(header, 4, 7, 12));
  }
});

test("should remove private documentation links from public README content", () => {
  const sanitized = sanitizeReadme(
    "# PortViewer\n\nPublic description\n\n## Private\n[internal](docs/qa/report.md)\n\n## Usage\n[guide](docs/installation.md)\n",
  );
  assert(!sanitized.includes("docs/qa"));
  assert(!sanitized.includes("## Private"));
  assert(sanitized.includes("docs/installation.md"));
});

async function repository(t) {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "portviewer-release-test-"),
  );
  t.after(async () => {
    assert(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert(path.basename(root).startsWith("portviewer-release-test-"));
    await rm(root, { recursive: true, force: true });
  });
  git(["init", "--initial-branch=main"], { root });
  git(["config", "user.name", "PortViewer Release Test"], { root });
  git(["config", "user.email", "release-test@example.invalid"], { root });
  git(["config", "commit.gpgsign", "false"], { root });
  await writeFile(path.join(root, ".gitignore"), ".tmp/\n");
  await writeFile(
    path.join(root, "README.md"),
    "# Public\n\nPublic description\n\n[secret](docs/qa/private.md)\n",
  );
  await mkdir(path.join(root, "docs", "qa"), { recursive: true });
  await writeFile(
    path.join(root, "docs", "qa", "private.md"),
    "private-only evidence",
  );
  await writeFile(path.join(root, "app.txt"), "public app");
  git(["add", "."], { root });
  git(["commit", "-m", "private initial"], { root });
  return root;
}

test("should create public snapshots without any private parent commits or excluded files", async (t) => {
  const root = await repository(t);
  const privateSha = git(["rev-parse", "main"], { root });
  const first = await createPublicSnapshot({ root });
  assert.equal(first.source, privateSha);
  assert.equal(first.changed, true);
  assert.equal(git(["rev-list", "--count", first.publicCommit], { root }), "1");
  assert(
    !git(["ls-tree", "-r", "--name-only", first.publicCommit], {
      root,
    }).includes("docs/qa"),
  );
  assert(
    !git(["show", `${first.publicCommit}:README.md`], { root }).includes(
      "docs/qa",
    ),
  );
  assert.equal(
    await readFile(path.join(root, "docs", "qa", "private.md"), "utf8"),
    "private-only evidence",
  );
  assert.equal(git(["branch", "--show-current"], { root }), "main");
  await writeFile(path.join(root, "app.txt"), "public app updated");
  git(["add", "app.txt"], { root });
  git(["commit", "-m", "private update"], { root });
  const second = await createPublicSnapshot({ root });
  assert.equal(
    git(["show", "-s", "--format=%P", second.publicCommit], { root }),
    first.publicCommit,
  );
  assert(
    !git(["rev-list", second.publicCommit], { root })
      .split("\n")
      .includes(privateSha),
  );
  assert.equal((await createPublicSnapshot({ root })).changed, false);
});

test("should refuse a public branch containing private history", async (t) => {
  const root = await repository(t);
  git(["branch", "public-release", "main"], { root });
  await assert.rejects(createPublicSnapshot({ root }), /main 历史/);
});

test("should refuse an uncommitted workspace before creating a public ref", async (t) => {
  const root = await repository(t);
  await writeFile(path.join(root, "app.txt"), "uncommitted");
  await assert.rejects(createPublicSnapshot({ root }), /提交工作区/);
  assert.throws(() =>
    git(["rev-parse", "--verify", "public-release"], { root }),
  );
});

function rangeResponse(bytes, start, end, total, { interrupted = false } = {}) {
  return {
    status: 206,
    headers: new Headers({ "content-range": `bytes ${start}-${end}/${total}` }),
    body: (async function* () {
      yield bytes;
      if (interrupted) throw new Error("connection interrupted");
    })(),
  };
}

test("should resume an interrupted byte range without reusing a stale tail after a failed fetch", async (t) => {
  const root = await temporary(t),
    destination = path.join(root, "download.bin");
  const bytes = Buffer.from("abcdef"),
    ranges = [];
  const asset = {
    name: "fixture.bin",
    size: bytes.length,
    digest: "sha256:" + digest(bytes),
    browser_download_url:
      "https://github.com/fixture/repo/releases/download/v1.2.0/fixture.bin",
  };
  const fetchImpl = async (_url, options) => {
    ranges.push(options.headers.Range);
    if (ranges.length === 1)
      return rangeResponse(bytes.subarray(0, 2), 0, 5, 6, {
        interrupted: true,
      });
    if (ranges.length === 2) throw new Error("failed before response headers");
    return rangeResponse(bytes.subarray(2), 2, 5, 6);
  };
  await downloadAsset({
    asset,
    destination,
    fetchImpl,
    attempts: 4,
    chunkSize: 6,
    sleepImpl: async () => {},
  });
  assert.deepEqual(ranges, ["bytes=0-5", "bytes=2-5", "bytes=2-5"]);
  assert.deepEqual(await readFile(destination), bytes);
});

test("should reject the wrong Content-Range before appending response bytes", async (t) => {
  const root = await temporary(t),
    destination = path.join(root, "download.bin"),
    bytes = Buffer.from("abcd");
  const asset = {
    name: "fixture.bin",
    size: 4,
    digest: "sha256:" + digest(bytes),
    browser_download_url:
      "https://github.com/fixture/repo/releases/download/v1.2.0/fixture.bin",
  };
  const ranges = [];
  await downloadAsset({
    asset,
    destination,
    chunkSize: 4,
    sleepImpl: async () => {},
    fetchImpl: async (_url, options) => {
      ranges.push(options.headers.Range);
      return ranges.length === 1
        ? rangeResponse(Buffer.from("xxxx"), 1, 4, 5)
        : rangeResponse(bytes, 0, 3, 4);
    },
  });
  assert.deepEqual(ranges, ["bytes=0-3", "bytes=0-3"]);
  assert.deepEqual(await readFile(destination), bytes);
});

test("should fail closed when downloaded bytes never match the GitHub digest", async (t) => {
  const root = await temporary(t),
    destination = path.join(root, "download.bin");
  const asset = {
    name: "fixture.bin",
    size: 4,
    digest: "sha256:" + digest(Buffer.from("good")),
    browser_download_url:
      "https://github.com/fixture/repo/releases/download/v1.2.0/fixture.bin",
  };
  await assert.rejects(
    downloadAsset({
      asset,
      destination,
      chunkSize: 4,
      sleepImpl: async () => {},
      fetchImpl: async () => rangeResponse(Buffer.from("evil"), 0, 3, 4),
    }),
    /SHA-256/,
  );
  await assert.rejects(readFile(destination), { code: "ENOENT" });
});

test("should refuse foreign download origins before issuing any HTTP request", async (t) => {
  const root = await temporary(t);
  let calls = 0;
  await assert.rejects(
    downloadAsset({
      asset: {
        name: "fixture.bin",
        size: 4,
        digest: "sha256:" + DIGEST,
        browser_download_url: "https://attacker.invalid/package",
      },
      destination: path.join(root, "fixture.bin"),
      fetchImpl: async () => {
        calls++;
      },
    }),
    /GitHub HTTPS/,
  );
  assert.equal(calls, 0);
});

test("should inspect real ZIP and tar layouts and verify built-in frontend identities", () => {
  const windows = readZipEntries(zip(webFiles())),
    linux = readTarEntries(tar(webFiles("1.2.0", true)));
  assert.equal(validateWebArchive(windows, "1.2.0").productVersion, "1.2.0");
  assert.equal(
    validateWebArchive(linux, "v1.2.0", true).productVersion,
    "1.2.0",
  );
  assert.equal(linux.get("start.sh").mode, 0o755);
});

test("should reject archive paths escaping the package", () => {
  for (const name of [
    "../outside",
    "/absolute",
    "C:/outside",
    "sub\\outside",
    "a/../../outside",
    "a\0b",
  ])
    assert.throws(() => safeArchivePath(name));
  assert.equal(safeArchivePath("./docs/readme.md"), "docs/readme.md");
});

test("should detect tampered frontend assets, missing documentation and non-executable Linux launchers", () => {
  const tampered = webFiles();
  tampered.get("web-assets/index.html").contents = Buffer.from("tampered");
  assert.throws(() => validateWebArchive(tampered, "1.2.0"), /distHash/);
  const missing = webFiles();
  missing.delete("docs/webgui-deployment.md");
  assert.throws(() => validateWebArchive(missing, "1.2.0"), /缺少/);
  const permissions = webFiles("1.2.0", true);
  permissions.get("start.sh").mode = 0o644;
  assert.throws(() => validateWebArchive(permissions, "1.2.0", true), /0755/);
});

test("should require the service knowledge guide from v1.3 while retaining v1.2 recovery", () => {
  for (const linux of [false, true]) {
    const files = webFiles("1.3.0", linux);
    assert.doesNotThrow(() => validateWebArchive(files, "1.3.0", linux));
    files.delete("docs/service-knowledge.md");
    assert.throws(
      () => validateWebArchive(files, "1.3.0", linux),
      /service-knowledge/,
    );
    const previous = webFiles("1.2.0", linux);
    previous.delete("docs/service-knowledge.md");
    assert.doesNotThrow(() => validateWebArchive(previous, "1.2.0", linux));
  }
});

test("should validate all package hashes, API digests and installer product versions", async (t) => {
  const fixture = await assetDirectory(t);
  const result = await validateLocalAssets(fixture.directory, {
    version: "1.2.0",
    assets: fixture.assets,
    installerInspector: inspectInstallers,
    runtimeInspector: async () => ({}),
  });
  assert.equal(result.version, "1.2.0");
  assert.equal(Object.keys(result.hashes).length, 6);
  await assert.rejects(
    validateLocalAssets(fixture.directory, {
      version: "1.2.0",
      installerInspector: async () => ({ exe: "1.1.0", msi: "1.2.0" }),
    }),
    /ProductVersion/,
  );
  await assert.rejects(
    validateLocalAssets(fixture.directory, {
      version: "1.1.0",
      installerInspector: inspectInstallers,
      runtimeInspector: async () => ({}),
    }),
    /版本\/身份/,
  );
  await assert.rejects(
    validateLocalAssets(fixture.directory, {
      version: "1.2.0",
      assets: fixture.assets.map((asset, index) =>
        index ? asset : { ...asset, digest: "sha256:" + DIGEST },
      ),
      installerInspector: inspectInstallers,
      runtimeInspector: async () => ({}),
    }),
    /digest/,
  );
});

test("should preserve current release files until every staged file passes validation", async (t) => {
  const fixture = await assetDirectory(t),
    release = path.join(fixture.root, "release");
  await mkdir(release);
  await writeFile(
    path.join(release, PACKAGE_ASSETS[0]),
    "current stable installer",
  );
  await writeFile(
    path.join(fixture.directory, PACKAGE_ASSETS[1]),
    "corrupt staged MSI",
  );
  await assert.rejects(
    installLocalRelease(fixture.directory, {
      root: fixture.root,
      tag: "v1.2.0",
      publicSha: SHA,
      releaseUrl: "https://github.com/fixture/repo/releases/tag/v1.2.0",
      assets: fixture.assets,
      installerInspector: inspectInstallers,
      runtimeInspector: async () => ({}),
    }),
    /SHA-256/,
  );
  assert.equal(
    await readFile(path.join(release, PACKAGE_ASSETS[0]), "utf8"),
    "current stable installer",
  );
  await assert.rejects(readFile(path.join(release, PACKAGE_ASSETS[1])), {
    code: "ENOENT",
  });
});

test("should update current and versioned release copies only after complete verification", async (t) => {
  const fixture = await assetDirectory(t);
  await installLocalRelease(fixture.directory, {
    root: fixture.root,
    tag: "v1.2.0",
    publicSha: SHA,
    releaseUrl: "https://github.com/fixture/repo/releases/tag/v1.2.0",
    assets: fixture.assets,
    installerInspector: inspectInstallers,
    runtimeInspector: async () => ({}),
  });
  for (const [name, bytes] of fixture.files) {
    assert.deepEqual(
      await readFile(path.join(fixture.root, "release", name)),
      bytes,
    );
    assert.deepEqual(
      await readFile(path.join(fixture.root, "release", "v1.2.0", name)),
      bytes,
    );
  }
});

function githubFixture(
  fixture,
  {
    ciConclusion = "success",
    tagSha = SHA,
    published = false,
    assetMismatch = false,
  } = {},
) {
  const calls = [];
  let release = published
    ? {
        id: 9,
        tag_name: "v1.2.0",
        draft: false,
        assets: fixture.assets.map((asset, index) =>
          index || !assetMismatch
            ? asset
            : { ...asset, digest: "sha256:" + DIGEST },
        ),
      }
    : null;
  const response = (value, status = 200) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { "content-type": "application/json" },
    });
  const client = new GitHubClient({
    repository: "fixture/repo",
    token: "fixture-token",
    fetchImpl: async (url, options = {}) => {
      const parsed = new URL(url),
        route = parsed.pathname.replace(/^\/repos\/fixture\/repo\//, ""),
        method = options.method ?? "GET";
      calls.push({ route, method });
      if (route.startsWith("actions/workflows/ci.yml/runs"))
        return response({
          workflow_runs: [{ ...greenRun({ conclusion: ciConclusion }), id: 3 }],
        });
      if (route === "actions/runs/3/jobs")
        return response({ jobs: greenJobs() });
      if (route === "git/ref/tags/v1.2.0")
        return tagSha
          ? response({ object: { type: "commit", sha: tagSha } })
          : response({}, 404);
      if (route === "releases/tags/v1.2.0")
        return release ? response(release) : response({}, 404);
      if (route === "releases" && method === "POST") {
        release = { id: 9, tag_name: "v1.2.0", draft: true, assets: [] };
        return response(release, 201);
      }
      if (route === "releases/9/assets" && method === "POST") {
        const name = parsed.searchParams.get("name"),
          bytes = Buffer.from(options.body);
        const asset = {
          id: 100 + release.assets.length,
          name,
          size: bytes.length,
          digest: "sha256:" + digest(bytes),
        };
        release.assets.push(asset);
        return response(asset, 201);
      }
      if (route === "releases/9" && method === "GET") return response(release);
      if (route === "releases/9" && method === "PATCH") {
        release = { ...release, ...JSON.parse(options.body) };
        return response(release);
      }
      throw new Error(`Unexpected HTTP ${method} ${route}`);
    },
  });
  return { client, calls, release: () => release };
}

test("should publish exactly six verified files after the exact-source CI gate", async (t) => {
  const fixture = await assetDirectory(t),
    remote = githubFixture(fixture);
  const release = await publishVerifiedRelease(remote.client, {
    directory: fixture.directory,
    version: "1.2.0",
    tag: "v1.2.0",
    sha: SHA,
    installerInspector: inspectInstallers,
    runtimeInspector: async () => ({}),
  });
  assert.equal(release.draft, false);
  assert.equal(release.assets.length, 6);
  assert.deepEqual(
    release.assets.map((asset) => asset.name),
    expectedAssetNames(),
  );
  assert.equal(remote.calls.at(-1).method, "PATCH");
  assert(
    remote.calls.findIndex((call) => call.route.startsWith("actions/")) <
      remote.calls.findIndex((call) => call.method === "POST"),
  );
});

test("should not create or publish a release when CI failed", async (t) => {
  const fixture = await assetDirectory(t),
    remote = githubFixture(fixture, { ciConclusion: "failure" });
  await assert.rejects(
    publishVerifiedRelease(remote.client, {
      directory: fixture.directory,
      version: "1.2.0",
      tag: "v1.2.0",
      sha: SHA,
      installerInspector: inspectInstallers,
      runtimeInspector: async () => ({}),
    }),
    /CI 尚未全绿/,
  );
  assert.equal(remote.calls.filter((call) => call.method !== "GET").length, 0);
});

test("should never move a release tag already pointing to another commit", async (t) => {
  const fixture = await assetDirectory(t),
    remote = githubFixture(fixture, { tagSha: "c".repeat(40) });
  await assert.rejects(ensureTag(remote.client, "v1.2.0", SHA), /拒绝移动标签/);
  assert.equal(remote.calls.filter((call) => call.method !== "GET").length, 0);
});

test("should reuse an identical public release without modifying any asset", async (t) => {
  const fixture = await assetDirectory(t),
    remote = githubFixture(fixture, { published: true });
  const release = await publishVerifiedRelease(remote.client, {
    directory: fixture.directory,
    version: "1.2.0",
    tag: "v1.2.0",
    sha: SHA,
    installerInspector: inspectInstallers,
    runtimeInspector: async () => ({}),
  });
  assert.equal(release.draft, false);
  assert.equal(remote.calls.filter((call) => call.method !== "GET").length, 0);
});

test("should refuse overwriting any file of an already public release", async (t) => {
  const fixture = await assetDirectory(t),
    remote = githubFixture(fixture, { published: true, assetMismatch: true });
  await assert.rejects(
    publishVerifiedRelease(remote.client, {
      directory: fixture.directory,
      version: "1.2.0",
      tag: "v1.2.0",
      sha: SHA,
      installerInspector: inspectInstallers,
      runtimeInspector: async () => ({}),
    }),
    /禁止覆盖/,
  );
  assert.equal(remote.calls.filter((call) => call.method !== "GET").length, 0);
});

test("should refuse stale green CI for another SHA without polling or mutating remote state", async (t) => {
  const fixture = await assetDirectory(t),
    remote = githubFixture(fixture);
  await assert.rejects(
    waitForCi(remote.client, "c".repeat(40), { wait: false }),
    /CI 未全绿/,
  );
  assert.equal(remote.calls.length, 1);
});

test("should preserve current installers when the packaged WebGUI fails its runtime smoke test", async (t) => {
  const fixture = await assetDirectory(t),
    release = path.join(fixture.root, "release");
  await mkdir(release);
  await writeFile(
    path.join(release, PACKAGE_ASSETS[0]),
    "known working installer",
  );
  await assert.rejects(
    installLocalRelease(fixture.directory, {
      root: fixture.root,
      tag: "v1.2.0",
      publicSha: SHA,
      releaseUrl: "https://github.com/fixture/repo/releases/tag/v1.2.0",
      assets: fixture.assets,
      installerInspector: inspectInstallers,
      runtimeInspector: async () => {
        throw new Error("packaged health check failed");
      },
    }),
    /health check failed/,
  );
  assert.equal(
    await readFile(path.join(release, PACKAGE_ASSETS[0]), "utf8"),
    "known working installer",
  );
});

test("should not mutate GitHub state when the packaged WebGUI fails runtime acceptance", async (t) => {
  const fixture = await assetDirectory(t),
    remote = githubFixture(fixture);
  await assert.rejects(
    publishVerifiedRelease(remote.client, {
      directory: fixture.directory,
      version: "1.2.0",
      tag: "v1.2.0",
      sha: SHA,
      installerInspector: inspectInstallers,
      runtimeInspector: async () => {
        throw new Error("packaged scan failed");
      },
    }),
    /packaged scan failed/,
  );
  assert.equal(remote.calls.length, 0);
});

test("should retry read-only GitHub requests after a network error, 503 and truncated JSON", async () => {
  let attempts = 0;
  const client = new GitHubClient({
    repository: "fixture/repo",
    token: "fixture-token",
    sleepImpl: async () => {},
    fetchImpl: async () => {
      attempts++;
      if (attempts === 1) throw new Error("temporary disconnect");
      if (attempts === 2)
        return new Response("temporarily unavailable", { status: 503 });
      if (attempts === 3) return new Response('{"id":', { status: 200 });
      return new Response('{"id":77}', { status: 200 });
    },
  });
  assert.deepEqual(await client.api("actions/runs/77"), { id: 77 });
  assert.equal(attempts, 4);
});

test("should not automatically repeat a non-idempotent GitHub POST after a lost response", async () => {
  let attempts = 0;
  const client = new GitHubClient({
    repository: "fixture/repo",
    token: "fixture-token",
    sleepImpl: async () => {},
    fetchImpl: async () => {
      attempts++;
      throw new Error("response lost");
    },
  });
  await assert.rejects(
    client.api("actions/workflows/release.yml/dispatches", {
      method: "POST",
      body: { ref: "main" },
    }),
    /不会盲目重发/,
  );
  assert.equal(attempts, 1);
});

test("should recover a workflow dispatch with a lost response from its journal without another POST", async (t) => {
  const root = await temporary(t),
    stateFile = path.join(root, "state.json"),
    methods = [];
  const run = {
    id: 77,
    head_sha: SHA,
    head_branch: "main",
    event: "workflow_dispatch",
    status: "in_progress",
    created_at: new Date().toISOString(),
  };
  let dispatched = false;
  const client = new GitHubClient({
    repository: "fixture/repo",
    token: "fixture-token",
    sleepImpl: async () => {},
    fetchImpl: async (_url, options) => {
      methods.push(options.method);
      if (options.method === "POST") {
        dispatched = true;
        throw new Error("dispatch accepted but response lost");
      }
      return new Response(
        JSON.stringify(
          _url.includes("/runs?")
            ? { workflow_runs: dispatched ? [run] : [] }
            : run,
        ),
        { status: 200 },
      );
    },
  });
  const options = {
    stateFile,
    sha: SHA,
    source: "c".repeat(40),
    tag: "v1.2.0",
    sleepImpl: async () => {},
  };
  assert.equal((await dispatchReleaseWithJournal(client, options)).id, 77);
  assert.equal((await dispatchReleaseWithJournal(client, options)).id, 77);
  assert.equal(methods.filter((method) => method === "POST").length, 1);
  assert.deepEqual(methods.slice(0, 2), ["GET", "POST"]);
  assert.equal(JSON.parse(await readFile(stateFile, "utf8")).runId, 77);
  assert.equal(JSON.parse(await readFile(stateFile, "utf8")).baselineRunId, 0);
});

test("should keep an unknown dispatch journal and refuse blind duplicate publishing", async (t) => {
  const root = await temporary(t),
    stateFile = path.join(root, "state.json");
  let posts = 0;
  const client = new GitHubClient({
    repository: "fixture/repo",
    token: "fixture-token",
    sleepImpl: async () => {},
    fetchImpl: async (_url, options) => {
      if (options.method === "POST") {
        posts++;
        throw new Error("response lost");
      }
      return new Response('{"workflow_runs":[]}', { status: 200 });
    },
  });
  const options = {
    stateFile,
    sha: SHA,
    source: "c".repeat(40),
    tag: "v1.2.0",
    sleepImpl: async () => {},
  };
  await assert.rejects(
    dispatchReleaseWithJournal(client, options),
    /调度响应中断/,
  );
  await assert.rejects(
    dispatchReleaseWithJournal(client, options),
    /未重复 POST/,
  );
  assert.equal(posts, 1);
  assert.equal(JSON.parse(await readFile(stateFile, "utf8")).baselineRunId, 0);
  assert.equal(
    JSON.parse(await readFile(stateFile, "utf8")).phase,
    "dispatching",
  );
});

for (const skewMinutes of [-5, 5]) {
  test(`should discover the dispatched run when GitHub time differs from local time by ${skewMinutes} minutes`, async (t) => {
    const root = await temporary(t),
      stateFile = path.join(root, "state.json");
    let posts = 0;
    const run = {
      id: 101,
      head_sha: SHA,
      head_branch: "main",
      event: "workflow_dispatch",
      status: "queued",
      created_at: new Date(Date.now() + skewMinutes * 60_000).toISOString(),
    };
    const client = new GitHubClient({
      repository: "fixture/repo",
      token: "fixture-token",
      sleepImpl: async () => {},
      fetchImpl: async (_url, options) => {
        if (options.method === "POST") {
          posts++;
          return new Response(null, { status: 204 });
        }
        return new Response(
          JSON.stringify({ workflow_runs: posts ? [run] : [] }),
          { status: 200 },
        );
      },
    });
    assert.equal(
      (
        await dispatchReleaseWithJournal(client, {
          stateFile,
          sha: SHA,
          source: "c".repeat(40),
          tag: "v1.2.0",
          sleepImpl: async () => {},
        })
      ).id,
      101,
    );
    assert.equal(posts, 1);
    assert.equal(
      JSON.parse(await readFile(stateFile, "utf8")).baselineRunId,
      0,
    );
  });
}

test("should ignore pre-dispatch runs and require new run ID, SHA, event and main to match", async (t) => {
  const root = await temporary(t),
    stateFile = path.join(root, "state.json");
  let posts = 0,
    readsAfterPost = 0;
  const old = {
    id: 100,
    head_sha: SHA,
    head_branch: "main",
    event: "workflow_dispatch",
    status: "completed",
    conclusion: "success",
    created_at: "2099-01-01T00:00:00Z",
  };
  const fresh = {
    ...old,
    id: 101,
    status: "queued",
    conclusion: null,
    created_at: "2000-01-01T00:00:00Z",
  };
  const client = new GitHubClient({
    repository: "fixture/repo",
    token: "fixture-token",
    sleepImpl: async () => {},
    fetchImpl: async (_url, options) => {
      if (options.method === "POST") {
        posts++;
        return new Response(null, { status: 204 });
      }
      const runs = !posts
        ? [{ ...old, id: 90 }, old]
        : ++readsAfterPost === 1
          ? [old]
          : [
              old,
              fresh,
              { ...fresh, id: 102, head_sha: "d".repeat(40) },
              { ...fresh, id: 103, event: "push" },
              { ...fresh, id: 104, head_branch: "other" },
            ];
      return new Response(JSON.stringify({ workflow_runs: runs }), {
        status: 200,
      });
    },
  });
  assert.equal(
    (
      await dispatchReleaseWithJournal(client, {
        stateFile,
        sha: SHA,
        source: "c".repeat(40),
        tag: "v1.2.0",
        sleepImpl: async () => {},
      })
    ).id,
    101,
  );
  assert.equal(posts, 1);
  assert.equal(readsAfterPost, 2);
  assert.equal(
    JSON.parse(await readFile(stateFile, "utf8")).baselineRunId,
    100,
  );
});

test("should resume dispatch discovery from the saved run baseline without another POST or clock comparison", async (t) => {
  const root = await temporary(t),
    stateFile = path.join(root, "state.json");
  await writeFile(
    stateFile,
    JSON.stringify({
      sha: SHA,
      source: "c".repeat(40),
      tag: "v1.2.0",
      phase: "awaiting-run",
      baselineRunId: 100,
      startedAt: "2099-01-01T00:00:00Z",
    }),
  );
  let posts = 0;
  const old = {
    id: 100,
    head_sha: SHA,
    head_branch: "main",
    event: "workflow_dispatch",
    status: "completed",
    created_at: "2099-01-01T00:00:00Z",
  };
  const fresh = {
    ...old,
    id: 101,
    status: "in_progress",
    created_at: "2000-01-01T00:00:00Z",
  };
  const client = new GitHubClient({
    repository: "fixture/repo",
    token: "fixture-token",
    sleepImpl: async () => {},
    fetchImpl: async (_url, options) => {
      if (options.method === "POST") {
        posts++;
        throw new Error("must not repeat dispatch");
      }
      return new Response(JSON.stringify({ workflow_runs: [old, fresh] }), {
        status: 200,
      });
    },
  });
  assert.equal(
    (
      await dispatchReleaseWithJournal(client, {
        stateFile,
        sha: SHA,
        source: "c".repeat(40),
        tag: "v1.2.0",
        sleepImpl: async () => {},
      })
    ).id,
    101,
  );
  assert.equal(posts, 0);
  assert.equal(JSON.parse(await readFile(stateFile, "utf8")).runId, 101);
});

test("should refuse source or public branch movement while CI is running", () => {
  const source = "c".repeat(40);
  for (const moved of ["main", "public-release"]) {
    const gitRunner = (args) =>
      args[1].endsWith("/" + moved)
        ? "d".repeat(40)
        : args[1].endsWith("/main")
          ? source
          : SHA;
    assert.throws(() =>
      assertFrozenRefs({ source, publicSha: SHA }, { gitRunner }),
    );
  }
});

test("should push frozen commit hashes to every remote instead of moving local branch names", async () => {
  const source = "c".repeat(40),
    calls = [];
  const gitRunner = (args) => {
    calls.push(args);
    if (args[0] === "rev-parse")
      return args[1] === "refs/heads/main" ? source : SHA;
    if (args[0] === "ls-remote")
      return `${args[1] === "lc-server" ? source : SHA}\trefs/heads/main\n${SHA}\trefs/tags/v1.2.0`;
    return "";
  };
  await synchronizeRemotes(normalizeConfig(), SHA, "v1.2.0", {
    source,
    gitRunner,
  });
  const pushes = calls.filter((args) => args[0] === "push");
  assert.equal(pushes.length, 2);
  assert(
    pushes.some(
      (args) => args[1] === "github" && args.includes(`${SHA}:refs/heads/main`),
    ),
  );
  assert(
    pushes.some(
      (args) =>
        args[1] === "lc-server" && args.includes(`${source}:refs/heads/main`),
    ),
  );
  assert(
    pushes.every(
      (args) =>
        !args.includes("refs/heads/main:refs/heads/main") &&
        !args.includes("refs/heads/public-release:refs/heads/main"),
    ),
  );
});

test("should refuse a tag moved between resolving its commit and capturing its object", async () => {
  const source = "c".repeat(40),
    movedTag = "d".repeat(40),
    calls = [];
  const gitRunner = (args) => {
    calls.push(args);
    if (args[0] === "rev-parse") {
      if (args[1] === "refs/heads/main") return source;
      if (args[1] === "refs/tags/v1.2.0") return movedTag;
      if (args[1] === `${movedTag}^{commit}`) return "e".repeat(40);
      return SHA;
    }
    return "";
  };
  await assert.rejects(
    synchronizeRemotes(normalizeConfig(), SHA, "v1.2.0", { source, gitRunner }),
    /冻结的标签对象/,
  );
  assert.equal(calls.filter((args) => args[0] === "push").length, 0);
});

test("should recover a valid completed download by removing stale sidecars without another HTTP request", async (t) => {
  const root = await temporary(t),
    destination = path.join(root, "fixture.bin"),
    bytes = Buffer.from("completed verified download");
  await writeFile(destination, bytes);
  const sidecars = [
    destination + ".part",
    destination + ".part.json",
    destination + ".part.tail",
  ];
  for (const file of sidecars)
    await writeFile(file, "stale interrupted cleanup");
  let requests = 0;
  const result = await downloadAsset({
    asset: {
      name: "fixture.bin",
      size: bytes.length,
      digest: "sha256:" + digest(bytes),
      browser_download_url:
        "https://github.com/fixture/repo/releases/download/v1.2.0/fixture.bin",
    },
    destination,
    fetchImpl: async () => {
      requests++;
      throw new Error("network must not be used");
    },
  });
  assert.equal(result, destination);
  assert.equal(requests, 0);
  assert.deepEqual(await readFile(destination), bytes);
  for (const file of sidecars)
    await assert.rejects(readFile(file), { code: "ENOENT" });
});
