import { execFileSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
// 分支名避开仓库内已存在的 public/ 目录，防止 git 命令歧义。
const publicBranch = "public-release";

// 仅从 public 分支剔除：设计过程文档与开发辅助工具，源代码与用户可见产物全部保留。
const excludedPrefixes = [
  "docs/design/",
  "docs/product/",
  "docs/architecture/",
  "docs/qa/",
  "skills/",
  ".vscode/",
];
const excludedFiles = new Set(["StartClaudeCode-Full.bat"]);

// 剔除路径出现在 README 文档索引与目录树中，同步时按行移除，避免公开版死链。
const lineFilter =
  /docs\/(?:design|product|architecture|qa)\/|skills\/|StartClaudeCode/;
const filteredTexts = ["README.md", "README.zh-CN.md"];
const headingPattern = /^#{1,6} /;

// 部分清理后段落仍剩有效链接，但原标题不再准确，净化版中改用通用标题。
const renamedHeadings = new Map([["## 产品与设计文档", "## 延伸阅读"]]);

function git(args, options = {}) {
  return execFileSync("git", args, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trimEnd();
}

function isExcluded(relativePath) {
  return (
    excludedFiles.has(relativePath) ||
    excludedPrefixes.some((prefix) => relativePath.startsWith(prefix))
  );
}

// 移除指向被剔除路径的行，并清理因此变空的标题段落、压缩连续空行。
function filterText(content) {
  const kept = content.split(/\r?\n/).filter((line) => !lineFilter.test(line));
  const out = [];
  let previousBlank = false;
  for (let i = 0; i < kept.length; i += 1) {
    let line = kept[i];
    if (headingPattern.test(line)) {
      let next = i + 1;
      while (next < kept.length && kept[next].trim() === "") next += 1;
      if (next >= kept.length || headingPattern.test(kept[next])) continue;
      line = renamedHeadings.get(line) ?? line;
    }
    const blank = line.trim() === "";
    if (blank && previousBlank) continue;
    previousBlank = blank;
    out.push(line);
  }
  return `${out.join("\n").replace(/\s+$/, "")}\n`;
}

const dirty = git(["status", "--porcelain"]);
if (dirty) {
  console.error("工作区存在未提交改动，public 快照必须对应 main 的确定提交。");
  console.error("请先提交或暂存后再运行本脚本。");
  process.exit(1);
}

const tracked = git(["ls-files"]).split("\n").filter(Boolean);
const keptFiles = tracked.filter((file) => !isExcluded(file));
const droppedCount = tracked.length - keptFiles.length;

let branchExists = false;
try {
  execFileSync("git", ["show-ref", "--verify", `refs/heads/${publicBranch}`], {
    cwd: root,
    stdio: "ignore",
  });
  branchExists = true;
} catch {
  branchExists = false;
}

const worktree = await mkdtemp(path.join(tmpdir(), "portviewer-public-"));
try {
  if (branchExists) {
    git(["worktree", "add", worktree, publicBranch]);
  } else {
    git(["worktree", "add", "--detach", worktree]);
    git(["checkout", "--orphan", publicBranch], { cwd: worktree });
    git(["rm", "-rf", "--quiet", "."], { cwd: worktree });
  }

  // public 分支内容完全由 main 的跟踪文件清单重建，不继承 main 历史。
  for (const entry of await readdir(worktree, { withFileTypes: true })) {
    if (entry.name !== ".git") {
      await rm(path.join(worktree, entry.name), {
        recursive: true,
        force: true,
      });
    }
  }
  for (const file of keptFiles) {
    const target = path.join(worktree, file);
    await mkdir(path.dirname(target), { recursive: true });
    if (filteredTexts.includes(file)) {
      await writeFile(
        target,
        filterText(await readFile(path.join(root, file), "utf8")),
        "utf8",
      );
    } else {
      await cp(path.join(root, file), target);
    }
  }

  git(["add", "-A"], { cwd: worktree });
  const staged = git(["diff", "--cached", "--name-only"], { cwd: worktree });
  if (!staged) {
    console.log(
      `public 分支已是最新（${keptFiles.length} 个文件，剔除 ${droppedCount} 个）。`,
    );
  } else {
    const sourceHash = git(["rev-parse", "HEAD"]);
    const message = [
      `chore(public): 净化快照同步自 main@${sourceHash.slice(0, 7)}`,
      "",
      `来源: main ${sourceHash}`,
      `剔除: docs/design docs/product docs/architecture docs/qa skills .vscode StartClaudeCode-Full.bat`,
    ].join("\n");
    git(["commit", "--quiet", "-m", message], { cwd: worktree });
    console.log(
      `public 分支已更新：${keptFiles.length} 个文件，剔除 ${droppedCount} 个路径。`,
    );
  }

  // 泄漏自检：任何被剔除路径出现在 public 树中即失败，防止误同步。
  const publicTree = git(["ls-tree", "-r", "--name-only", publicBranch]);
  const leaked = publicTree
    .split("\n")
    .filter((file) => file && isExcluded(file));
  if (leaked.length > 0) {
    console.error("泄漏自检失败，以下路径出现在 public 分支中：");
    for (const file of leaked) console.error(`  ${file}`);
    process.exit(1);
  }
  console.log("泄漏自检通过：public 分支不含任何剔除路径。");
} finally {
  git(["worktree", "remove", "--force", worktree]);
}

console.log("");
console.log("推送到 GitHub（建仓后执行）：");
console.log("  git remote add github <仓库URL>");
console.log(`  git push github ${publicBranch}:main`);
