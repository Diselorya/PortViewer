import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, unlink, rmdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isExcludedPublicPath, sanitizeReadme } from "./release-lib.mjs";

export function git(
  args,
  { root = path.resolve(import.meta.dirname, ".."), ...options } = {},
) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    ...options,
  }).trimEnd();
}

export async function createPublicSnapshot({
  root = path.resolve(import.meta.dirname, ".."),
  sourceBranch = "main",
  publicBranch = "public-release",
  prompt,
} = {}) {
  assert(
    !git(["status", "--porcelain"], { root }),
    "请先提交工作区；公开快照必须对应确定的 clean main",
  );
  assert(
    git(["branch", "--show-current"], { root }) === sourceBranch,
    "必须在 main 工作区执行",
  );
  const source = git(["rev-parse", `refs/heads/${sourceBranch}`], { root });
  if (prompt === undefined) {
    const sourceMessage = git(["show", "-s", "--format=%B", source], { root });
    prompt =
      /用户提示词[：:]\s*([\s\S]*?)(?:\n\s*变更清单[：:]|$)/
        .exec(sourceMessage)?.[1]
        ?.trim() ??
      "执行一键发布：CI 全绿后发布 GitHub Release、同步所有远端并更新本地 release。";
  }
  let previous;
  try {
    previous = git(["rev-parse", "--verify", `refs/heads/${publicBranch}`], {
      root,
    });
  } catch {}
  if (previous) {
    const parents = git(["rev-list", previous], { root }).split("\n");
    const privateAncestors = new Set(
      git(["rev-list", source], { root }).split("\n"),
    );
    assert(
      !parents.some((commit) => privateAncestors.has(commit)),
      "public-release 已含完整 main 历史，拒绝发布",
    );
  }
  await mkdir(path.join(root, ".tmp"), { recursive: true });
  const temporary = await mkdtemp(path.join(root, ".tmp", "public-index-"));
  const index = path.join(temporary, "index");
  const env = { ...process.env, GIT_INDEX_FILE: index };
  const run = (args, options = {}) => git(args, { root, env, ...options });
  try {
    run(["read-tree", source]);
    const files = git(["ls-tree", "-r", "--name-only", "-z", source], { root })
      .split("\0")
      .filter(Boolean);
    const dropped = files.filter(isExcludedPublicPath);
    if (dropped.length)
      run(["update-index", "--force-remove", "-z", "--stdin"], {
        input: dropped.join("\0") + "\0",
      });
    for (const file of ["README.md", "README.zh-CN.md"].filter((file) =>
      files.includes(file),
    )) {
      const content = git(["show", `${source}:${file}`], { root });
      const blob = run(["hash-object", "-w", "--stdin"], {
        input: sanitizeReadme(content),
      });
      run(["update-index", "--cacheinfo", `100644,${blob},${file}`]);
    }
    const tree = run(["write-tree"]);
    const publicFiles = git(["ls-tree", "-r", "--name-only", "-z", tree], {
      root,
    })
      .split("\0")
      .filter(Boolean);
    assert(!publicFiles.some(isExcludedPublicPath), "公开快照泄漏自检失败");
    if (previous && tree === git(["rev-parse", `${previous}^{tree}`], { root }))
      return { source, publicCommit: previous, changed: false };
    const message = `chore(public): 同步公开发行快照\n\n简报：同步 main@${source.slice(0, 7)} 的净化源码，完整 main 历史不进入公开仓库。\n\n用户提示词：\n${prompt}\n\n变更清单：\n- 按原有六个排除前缀和开发辅助文件清单重建公开源码。\n- 净化 README 链接并执行路径泄漏检查。\n- 来源提交：${source}\n`;
    const commit = run(
      ["commit-tree", tree, ...(previous ? ["-p", previous] : []), "-F", "-"],
      { input: message },
    );
    git(
      [
        "update-ref",
        `refs/heads/${publicBranch}`,
        commit,
        previous ?? "0".repeat(40),
      ],
      { root },
    );
    return {
      source,
      publicCommit: commit,
      changed: true,
      keptFiles: publicFiles.length,
      droppedFiles: dropped.length,
    };
  } finally {
    await unlink(index).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    await rmdir(temporary);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  createPublicSnapshot().then(
    (result) => console.log(JSON.stringify(result)),
    (error) => {
      console.error(error.message);
      process.exitCode = 1;
    },
  );
}
