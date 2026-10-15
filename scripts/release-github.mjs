import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  assertSuccessfulCi,
  expectedAssetNames,
  validateReleaseAssets,
} from "./release-lib.mjs";
import { validateLocalAssets } from "./release-assets.mjs";

export function githubToken(root) {
  if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN)
    return process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  try {
    const token = execFileSync(
      "gh",
      ["auth", "token", "--hostname", "github.com"],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 30_000,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    ).trim();
    if (token) return token;
  } catch {}
  try {
    const credential = execFileSync("git", ["credential", "fill"], {
      cwd: root,
      input: "protocol=https\nhost=github.com\n\n",
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const token = /^password=(.+)$/m.exec(credential)?.[1].trim();
    if (token) return token;
  } catch {}
  throw new Error(
    "GitHub 凭据不可用：设置 GH_TOKEN/GITHUB_TOKEN 或登录 gh/Git Credential Manager；凭据不会写入日志",
  );
}

export class GitHubClient {
  constructor({ repository, token, fetchImpl = fetch, sleepImpl = delay }) {
    this.repository = repository;
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.sleepImpl = sleepImpl;
  }
  async api(route, { method = "GET", body, allow404 = false } = {}) {
    const attempts = method === "GET" ? 4 : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      let response;
      try {
        response = await this.fetchImpl(
          `https://api.github.com/repos/${this.repository}/${route}`,
          {
            method,
            headers: {
              Accept: "application/vnd.github+json",
              "X-GitHub-Api-Version": "2022-11-28",
              Authorization: `Bearer ${this.token}`,
              ...(body === undefined
                ? {}
                : { "Content-Type": "application/json" }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            signal: AbortSignal.timeout(60_000),
          },
        );
      } catch {
        if (attempt + 1 < attempts) {
          await this.sleepImpl(500 * 2 ** attempt);
          continue;
        }
        throw new Error(
          "GitHub API 网络请求失败，可原命令恢复；非幂等请求不会盲目重发",
        );
      }
      if (
        [408, 429, 500, 502, 503, 504].includes(response.status) &&
        attempt + 1 < attempts
      ) {
        await response.body?.cancel();
        await this.sleepImpl(500 * 2 ** attempt);
        continue;
      }
      if (allow404 && response.status === 404) return null;
      assert(
        response.ok,
        `GitHub API ${method} 请求失败：HTTP ${response.status}`,
      );
      if (response.status === 204) return null;
      try {
        return await response.json();
      } catch {
        if (attempt + 1 < attempts) {
          await this.sleepImpl(500 * 2 ** attempt);
          continue;
        }
        throw new Error("GitHub API 响应不完整，可原命令恢复");
      }
    }
  }
  async upload(releaseId, name, bytes) {
    const response = await this.fetchImpl(
      `https://uploads.github.com/repos/${this.repository}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/octet-stream",
          Accept: "application/vnd.github+json",
        },
        body: bytes,
        signal: AbortSignal.timeout(15 * 60_000),
      },
    ).catch(() => {
      throw new Error(`上传中断，可原命令恢复：${name}`);
    });
    assert(response.ok, `上传资产失败：${name}，HTTP ${response.status}`);
    return response.json();
  }
}

export async function resolveTag(client, tag) {
  let reference = await client.api("git/ref/tags/" + encodeURIComponent(tag), {
    allow404: true,
  });
  if (!reference) return null;
  reference = reference.object;
  for (let depth = 0; reference.type === "tag" && depth < 8; depth++)
    reference = (await client.api("git/tags/" + reference.sha)).object;
  assert(
    reference.type === "commit" && /^[a-f0-9]{40}$/.test(reference.sha),
    "标签未指向有效提交",
  );
  return reference.sha;
}

export async function ensureTag(client, tag, sha) {
  const existing = await resolveTag(client, tag);
  assert(!existing || existing === sha, "已有标签指向其他提交，拒绝移动标签");
  if (!existing)
    await client.api("git/refs", {
      method: "POST",
      body: { ref: "refs/tags/" + tag, sha },
    });
  assert((await resolveTag(client, tag)) === sha, "标签提交校验失败");
}

const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
export async function waitForCi(
  client,
  sha,
  { timeoutMs = 90 * 60_000, sleepImpl = delay, wait = true } = {},
) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const response = await client.api(
      `actions/workflows/ci.yml/runs?head_sha=${sha}&event=push&per_page=100`,
    );
    const run = response.workflow_runs
      .filter(
        (run) =>
          run.head_sha === sha &&
          run.head_branch === "main" &&
          run.event === "push",
      )
      .sort((left, right) => right.id - left.id)[0];
    if (run?.status === "completed") {
      const jobs = await client.api(`actions/runs/${run.id}/jobs?per_page=100`);
      return assertSuccessfulCi(run, jobs.jobs, sha);
    }
    assert(
      wait && Date.now() < deadline,
      "精确公开 SHA 的 CI 未全绿；未调度发布，可稍后原命令恢复",
    );
    console.log(`等待 CI ${sha.slice(0, 12)}：${run?.status ?? "queued"}`);
    await sleepImpl(20_000);
  }
}

export async function publishVerifiedRelease(
  client,
  { directory, version, tag, sha, installerInspector, runtimeInspector } = {},
) {
  const verified = await validateLocalAssets(directory, {
    version,
    installerInspector,
    runtimeInspector,
  });
  await waitForCi(client, sha, { wait: false });
  await ensureTag(client, tag, sha);
  let release = await client.api("releases/tags/" + encodeURIComponent(tag), {
    allow404: true,
  });
  if (release && !release.draft) {
    validateReleaseAssets(release.assets);
    for (const asset of release.assets)
      assert(
        asset.digest === "sha256:" + verified.hashes[asset.name],
        "已有公开 Release 与本次构建不同，禁止覆盖",
      );
    return release;
  }
  if (!release) {
    const notes = await readFile(
      path.join(
        path.resolve(import.meta.dirname, ".."),
        "docs",
        "releases",
        tag + ".md",
      ),
      "utf8",
    ).catch(
      () => `PortViewer ${tag}\n\n安装包与 SHA-256 校验清单已通过自动验收。`,
    );
    release = await client.api("releases", {
      method: "POST",
      body: {
        tag_name: tag,
        target_commitish: sha,
        name: tag,
        body: notes,
        draft: true,
        prerelease: false,
      },
    });
  }
  for (const name of expectedAssetNames()) {
    for (let attempt = 0; attempt < 3; attempt++) {
      release = await client.api("releases/" + release.id);
      assert(release.draft, "上传期间 Release 已公开，拒绝修改资产");
      const existing = release.assets.find((asset) => asset.name === name);
      if (existing?.digest === "sha256:" + verified.hashes[name]) break;
      if (existing)
        await client.api("releases/assets/" + existing.id, {
          method: "DELETE",
        });
      try {
        const uploaded = await client.upload(
          release.id,
          name,
          await readFile(path.join(directory, name)),
        );
        assert(
          uploaded.digest === "sha256:" + verified.hashes[name],
          `上传后 digest 不符：${name}`,
        );
        break;
      } catch (error) {
        if (attempt === 2) throw error;
      }
    }
  }
  release = await client.api("releases/" + release.id);
  validateReleaseAssets(release.assets);
  for (const asset of release.assets)
    assert(
      asset.digest === "sha256:" + verified.hashes[asset.name],
      "公开前 API asset digest 不符",
    );
  assert((await resolveTag(client, tag)) === sha, "公开前标签目标发生变化");
  return client.api("releases/" + release.id, {
    method: "PATCH",
    body: { draft: false, make_latest: "true" },
  });
}
