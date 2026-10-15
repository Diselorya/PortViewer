import assert from "node:assert/strict";
import {
  appendFile,
  copyFile,
  lstat,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createPublicSnapshot, git } from "./sync-public-remote.mjs";
import {
  parseArgs,
  parseVersion,
  normalizeConfig,
  validateReleaseAssets,
} from "./release-lib.mjs";
import {
  downloadAsset,
  installLocalRelease,
  sha256,
} from "./release-assets.mjs";
import {
  GitHubClient,
  githubToken,
  publishVerifiedRelease,
  resolveTag,
  waitForCi,
} from "./release-github.mjs";

const root = path.resolve(import.meta.dirname, "..");
const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function dispatchReleaseWithJournal(
  client,
  { stateFile, sha, source, tag, sleepImpl = delay } = {},
) {
  let state = JSON.parse(await readFile(stateFile, "utf8").catch(() => "{}"));
  if (state.sha !== sha) state = {};
  const save = async (value) => {
    const incoming = stateFile + ".next";
    await writeFile(incoming, JSON.stringify(value, null, 2));
    const { rename } = await import("node:fs/promises");
    await rename(incoming, stateFile);
    state = value;
  };
  if (state.runId) {
    const recorded = await client.api("actions/runs/" + state.runId, {
      allow404: true,
    });
    assert(
      !recorded ||
        (recorded.head_sha === sha && recorded.event === "workflow_dispatch"),
      "已记录 Release 运行的提交不符",
    );
    if (recorded && recorded.status !== "completed") return recorded;
    // A known terminal run can safely be retried. An unknown POST must first be reconciled.
    if (recorded?.status === "completed" && recorded.conclusion === "success")
      return recorded;
    state = {};
  }
  const find = async () => {
    const response = await client.api(
      `actions/workflows/release.yml/runs?head_sha=${sha}&event=workflow_dispatch&per_page=100`,
    );
    return response.workflow_runs
      .filter(
        (run) =>
          run.head_sha === sha &&
          run.event === "workflow_dispatch" &&
          run.head_branch === "main" &&
          Date.parse(run.created_at) >= Date.parse(state.startedAt) - 1000,
      )
      .sort((left, right) => right.id - left.id)[0];
  };
  if (state.phase === "dispatching" || state.phase === "awaiting-run") {
    for (let attempt = 0; attempt < 30; attempt++) {
      const run = await find();
      if (run) {
        await save({ ...state, runId: run.id, phase: "running" });
        return run;
      }
      await sleepImpl(2000);
    }
    throw new Error(
      "上次调度结果未知，已保留 journal 且未重复 POST。稍后运行原命令会继续查找既存运行；只有在 GitHub 确认未收到调度后，才移除该版本 .tmp/release-state/*.json 重新调度。",
    );
  }
  await save({
    sha,
    source,
    tag,
    startedAt: new Date().toISOString(),
    phase: "dispatching",
  });
  let dispatchError;
  try {
    await client.api("actions/workflows/release.yml/dispatches", {
      method: "POST",
      body: {
        ref: "main",
        inputs: { publish: "true", expected_sha: sha, tag },
      },
    });
    await save({ ...state, phase: "awaiting-run" });
  } catch (error) {
    dispatchError = error;
  }
  for (let attempt = 0; attempt < 30; attempt++) {
    const run = await find();
    if (run) {
      await save({ ...state, runId: run.id, phase: "running" });
      return run;
    }
    await sleepImpl(2000);
  }
  throw new Error(
    dispatchError
      ? "Release 调度响应中断且运行暂不可见；journal已保留，原命令将先查证，绝不盲目重复调度。"
      : "Release 调度已接受但运行暂不可见；journal已保留，请稍后原命令恢复查证。",
  );
}

export async function readProductVersion(directory = root) {
  const read = (file) => readFile(path.join(directory, file), "utf8");
  const version = parseVersion(JSON.parse(await read("package.json")).version);
  const npmLock = JSON.parse(await read("package-lock.json"));
  assert(
    npmLock.version === version && npmLock.packages[""].version === version,
    "npm 锁文件版本不一致",
  );
  assert(
    JSON.parse(await read("src-tauri/tauri.conf.json")).version === version,
    "Tauri 配置版本不一致",
  );
  for (const file of ["src-tauri/Cargo.toml", "web-service/Cargo.toml"])
    assert(
      /^version\s*=\s*"([^"]+)"/m.exec(await read(file))?.[1] === version,
      "Rust 包版本不一致",
    );
  for (const [file, names] of [
    ["src-tauri/Cargo.lock", ["portviewer-app"]],
    ["web-service/Cargo.lock", ["portviewer-app", "portviewer-web"]],
  ]) {
    const text = await read(file);
    for (const name of names) {
      const entries = [
        ...text.matchAll(
          new RegExp(`name = "${name}"\\r?\\nversion = "([^"]+)"`, "g"),
        ),
      ];
      assert(
        entries.length === 1 && entries[0][1] === version,
        "Rust 锁文件版本不一致",
      );
    }
  }
  return version;
}

function safeGit(args, directory = root) {
  try {
    return git(args, { root: directory });
  } catch {
    throw new Error(
      `git ${args[0]} 失败；请检查凭据、远端分支与快进条件（不自动 force）`,
    );
  }
}

export function validateRemoteUrls(config, { gitRunner = safeGit } = {}) {
  const github = gitRunner(["remote", "get-url", "github"]);
  const expected = config.repository.replace(/\.git$/, "");
  assert(
    github === `https://github.com/${expected}.git` ||
      github === `https://github.com/${expected}` ||
      github === `git@github.com:${expected}.git`,
    "github 远端与目标仓库不符，拒绝推送",
  );
  for (const remote of config.remotes) {
    for (const arguments_ of [["--all"], ["--push", "--all"]]) {
      const urls = gitRunner([
        "remote",
        "get-url",
        ...arguments_,
        remote.name,
      ]).split("\n");
      assert(urls.length === 1, "每个映射远端仅允许一个推送地址");
      if (remote.name !== "github")
        assert(
          !/(?:github\.com)(?=[:/]|$)/i.test(urls[0]),
          "完整 main 不可推向 GitHub 别名",
        );
      else
        assert(urls[0] === github, "GitHub 推送地址必须与目标仓库读取地址一致");
      assert(!/^https?:\/\/[^/]*@/.test(urls[0]), "远端 URL 不可内嵌凭据");
    }
  }
}

async function syncLocal(client, release, tag, sha) {
  assert(
    !release.draft && !release.prerelease && release.tag_name === tag,
    "只同步正式公开 Release",
  );
  validateReleaseAssets(release.assets);
  assert((await resolveTag(client, tag)) === sha, "下载前标签目标不符");
  const stage = path.join(
    root,
    ".tmp",
    "release-download",
    tag,
    String(release.id),
    "assets",
  );
  await mkdir(stage, { recursive: true });
  for (const asset of release.assets) {
    console.log(`同步本地 ${asset.name} (${asset.size} bytes)`);
    const destination = path.join(stage, asset.name);
    if (!(await lstat(destination).catch(() => null))) {
      for (const cache of [
        path.join(root, "release", tag, asset.name),
        path.join(root, "release", asset.name),
      ]) {
        const info = await lstat(cache).catch(() => null);
        if (
          info?.isFile() &&
          !info.isSymbolicLink() &&
          info.size === asset.size &&
          "sha256:" + (await sha256(cache)) === asset.digest
        ) {
          await copyFile(cache, destination);
          break;
        }
      }
    }
    await downloadAsset({ asset, destination });
  }
  const result = await installLocalRelease(stage, {
    root,
    tag,
    publicSha: sha,
    releaseUrl: release.html_url,
    assets: release.assets,
  });
  return { ...result, directory: path.join(root, "release", tag) };
}

export function assertFrozenRefs(
  { source, publicSha },
  { gitRunner = safeGit } = {},
) {
  assert(
    gitRunner(["rev-parse", "refs/heads/main"]) === source,
    "发布等待期间 main 已移动，停止以免同步未验收提交",
  );
  assert(
    gitRunner(["rev-parse", "refs/heads/public-release"]) === publicSha,
    "发布等待期间 public-release 已移动，停止同步",
  );
}

export async function synchronizeRemotes(
  config,
  sha,
  tag,
  { source, gitRunner = safeGit } = {},
) {
  assertFrozenRefs({ source, publicSha: sha }, { gitRunner });
  gitRunner(["fetch", "github", `refs/tags/${tag}:refs/tags/${tag}`]);
  assert(
    gitRunner(["rev-parse", `refs/tags/${tag}^{commit}`]) === sha,
    "本地标签与公开发行提交不符",
  );
  const tagObject = gitRunner(["rev-parse", `refs/tags/${tag}`]);
  assert(
    gitRunner(["rev-parse", `${tagObject}^{commit}`]) === sha,
    "冻结的标签对象未指向本次公开发行提交",
  );
  for (const remote of config.remotes) {
    assertFrozenRefs({ source, publicSha: sha }, { gitRunner });
    assert(
      gitRunner(["rev-parse", `refs/tags/${tag}`]) === tagObject,
      "同步期间本地标签已移动",
    );
    const expected = remote.source === "public-release" ? sha : source;
    gitRunner([
      "push",
      remote.name,
      `${expected}:refs/heads/${remote.destination}`,
      `${tagObject}:refs/tags/${tag}`,
    ]);
    const heads = gitRunner([
      "ls-remote",
      remote.name,
      `refs/heads/${remote.destination}`,
      `refs/tags/${tag}`,
      `refs/tags/${tag}^{}`,
    ]);
    assert(
      heads
        .split("\n")
        .some(
          (line) => line === `${expected}\trefs/heads/${remote.destination}`,
        ),
      "远端分支同步校验失败",
    );
    assert(
      heads
        .split("\n")
        .some(
          (line) =>
            line === `${sha}\trefs/tags/${tag}` ||
            line === `${sha}\trefs/tags/${tag}^{}`,
        ),
      "远端标签同步校验失败",
    );
    assertFrozenRefs({ source, publicSha: sha }, { gitRunner });
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.workflowGate || options.workflowPublish) {
    options.expectedSha ??= process.env.RELEASE_EXPECTED_SHA;
    options.tag ??= process.env.RELEASE_TAG || undefined;
  }
  if (options.help) {
    console.log(
      "node scripts/release.mjs [--check|--dry-run|--sync-only] [--tag vx.y.z] [--remote github=public-release:main --remote lc-server=main:main]\n默认：clean main → 公开快照 → 精确SHA CI全绿 → Release发布 → 全远端/标签 → 本地六文件验收落地。\n--sync-only：同步已公开的指定版本，不构建或发布。--check/--dry-run：只读检查并输出计划。",
    );
    return;
  }
  const productVersion = await readProductVersion();
  const version = options.tag ? parseVersion(options.tag) : productVersion;
  const tag = "v" + version;
  if (options.workflowGate || options.workflowPublish) {
    assert(
      process.env.GITHUB_ACTIONS === "true",
      "workflow 内部模式只能在 GitHub Actions 使用",
    );
    const sha = process.env.GITHUB_SHA;
    assert(
      /^[a-f0-9]{40}$/.test(sha ?? "") && options.expectedSha === sha,
      "Workflow SHA 与调度目标不符",
    );
    assert(
      safeGit(["rev-parse", "HEAD"]) === sha && version === productVersion,
      "Workflow checkout/版本不符",
    );
    const repository = process.env.GITHUB_REPOSITORY;
    assert(
      /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? ""),
      "Workflow 仓库无效",
    );
    const client = new GitHubClient({ repository, token: githubToken(root) });
    await waitForCi(client, sha, { wait: false });
    const currentTag = await resolveTag(client, tag);
    assert(!currentTag || currentTag === sha, "已有标签指向其他提交");
    if (options.workflowGate) {
      if (process.env.GITHUB_OUTPUT)
        await appendFile(
          process.env.GITHUB_OUTPUT,
          `tag=${tag}\nversion=${version}\nsha=${sha}\n`,
        );
      console.log(`发布门禁通过：${tag} @ ${sha}`);
    } else {
      assert(options.assetsDir, "发布模式缺少产物目录");
      const release = await publishVerifiedRelease(client, {
        directory: path.resolve(options.assetsDir),
        version,
        tag,
        sha,
      });
      console.log(`正式 Release：${release.html_url}`);
    }
    return;
  }
  assert(
    options.syncOnly || version === productVersion,
    "发布标签必须等于全部项目文件的当前版本",
  );
  assert(
    safeGit(["branch", "--show-current"]) === "main" &&
      !safeGit(["status", "--porcelain"]),
    "请先提交改动，并在 clean main 执行",
  );
  const config = normalizeConfig(
    options,
    safeGit(["remote"]).split("\n").filter(Boolean),
  );
  validateRemoteUrls(config);
  const source = safeGit(["rev-parse", "HEAD"]);
  if (options.check || options.dryRun) {
    console.log(
      JSON.stringify(
        {
          mode: options.syncOnly ? "sync-only" : "release",
          version,
          tag,
          source,
          remotes: config.remotes,
          gates: [
            "clean main / version locks",
            "public snapshot / no private ancestry",
            "exact public SHA CI success",
            "tag target / six artifacts / installer and WebGUI versions",
            "API digest / SHA-256 / all remotes / local release",
          ],
        },
        null,
        2,
      ),
    );
    return;
  }
  const client = new GitHubClient({
    repository: config.repository,
    token: githubToken(root),
  });
  if (options.syncOnly) {
    const release = await client.api("releases/tags/" + tag);
    const sha = await resolveTag(client, tag);
    assert(sha, "Release 标签不存在");
    const result = await syncLocal(client, release, tag, sha);
    console.log(
      JSON.stringify({ release: release.html_url, publicSha: sha, ...result }),
    );
    return;
  }
  safeGit(["fetch", "github", "main"]);
  const publicBefore = safeGit(["rev-parse", "refs/heads/public-release"]);
  const remoteBefore = safeGit(["rev-parse", "refs/remotes/github/main"]);
  // A previously generated but not pushed snapshot may safely resume if it is a descendant.
  safeGit(["merge-base", "--is-ancestor", remoteBefore, publicBefore]);
  const snapshot = await createPublicSnapshot({
    root,
    prompt: process.env.RELEASE_USER_PROMPT,
  });
  const sha = snapshot.publicCommit;
  assert(snapshot.source === source, "生成快照期间 main 已移动，请重新执行");
  const oldTag = await resolveTag(client, tag);
  assert(
    !oldTag || oldTag === sha,
    "版本标签已属于其他公开提交；请升级版本，禁止覆盖",
  );
  assertFrozenRefs({ source, publicSha: sha });
  safeGit(["push", "github", `${sha}:refs/heads/main`]);
  await waitForCi(client, sha);
  assertFrozenRefs({ source, publicSha: sha });
  let release = await client.api("releases/tags/" + tag, { allow404: true });
  if (!release || release.draft) {
    const stateDirectory = path.join(root, ".tmp", "release-state");
    await mkdir(stateDirectory, { recursive: true });
    const stateFile = path.join(stateDirectory, tag + ".json");
    let run = await dispatchReleaseWithJournal(client, {
      stateFile,
      sha,
      source,
      tag,
    });
    const deadline = Date.now() + 120 * 60_000;
    while (run.status !== "completed") {
      assert(Date.now() < deadline, "等待 Release 超时，可原命令恢复");
      console.log(`等待 Release ${tag}：${run.status} (${run.id})`);
      await delay(20_000);
      run = await client.api("actions/runs/" + run.id);
    }
    assert(
      run.head_sha === sha && run.conclusion === "success",
      "Release workflow 未成功，停止同步与落地",
    );
    release = await client.api("releases/tags/" + tag);
  }
  assert(
    !release.draft &&
      !release.prerelease &&
      (await resolveTag(client, tag)) === sha,
    "正式 Release 尚不可用或标签目标不符",
  );
  validateReleaseAssets(release.assets);
  await synchronizeRemotes(config, sha, tag, { source });
  const result = await syncLocal(client, release, tag, sha);
  assertFrozenRefs({ source, publicSha: sha });
  console.log(
    JSON.stringify({
      release: release.html_url,
      source,
      publicSha: sha,
      remotes: config.remotes.map((remote) => remote.name),
      ...result,
    }),
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
