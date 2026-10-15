import assert from "node:assert/strict";

export const PACKAGE_ASSETS = Object.freeze([
  "PortViewer-windows-x64-setup.exe",
  "PortViewer-windows-x64-offline.msi",
  "PortViewer-WebGUI-windows-x64.zip",
  "PortViewer-WebGUI-linux-x64.tar.gz",
]);
export const CHECKSUM_ASSETS = Object.freeze([
  "SHA256SUMS-windows.txt",
  "SHA256SUMS-linux.txt",
]);
export const EXCLUDED_PREFIXES = Object.freeze([
  "docs/design/",
  "docs/product/",
  "docs/architecture/",
  "docs/qa/",
  "skills/",
  ".vscode/",
]);
export const REQUIRED_CI_JOBS = Object.freeze([
  "Windows / Node and Rust",
  "Linux / WebGUI",
]);
export const expectedAssetNames = () => [...PACKAGE_ASSETS, ...CHECKSUM_ASSETS];
export const isExcludedPublicPath = (file) =>
  file === "StartClaudeCode-Full.bat" ||
  EXCLUDED_PREFIXES.some((prefix) => file.startsWith(prefix));

export function sanitizeReadme(content) {
  const kept = content
    .split(/\r?\n/)
    .filter(
      (line) =>
        !/docs\/(?:design|product|architecture|qa)\/|skills\/|StartClaudeCode/.test(
          line,
        ),
    );
  const output = [];
  for (let index = 0; index < kept.length; index++) {
    let line = kept[index];
    if (/^#{1,6} /.test(line)) {
      let next = index + 1;
      while (next < kept.length && !kept[next].trim()) next++;
      if (next === kept.length || /^#{1,6} /.test(kept[next])) continue;
      if (line === "## 产品与设计文档") line = "## 延伸阅读";
    }
    if (!line.trim() && output.length && !output.at(-1).trim()) continue;
    output.push(line);
  }
  return output.join("\n").replace(/\s+$/, "") + "\n";
}

export function parseVersion(tag) {
  assert(
    typeof tag === "string" && /^v?\d+\.\d+\.\d+$/.test(tag),
    "版本必须是稳定版本 x.y.z 或 vx.y.z",
  );
  return tag.replace(/^v/, "");
}

export function parseArgs(argv) {
  const result = { check: false, dryRun: false, syncOnly: false, remotes: [] };
  const switches = new Map([
    ["--check", "check"],
    ["--dry-run", "dryRun"],
    ["--sync-only", "syncOnly"],
    ["--workflow-gate", "workflowGate"],
    ["--workflow-publish", "workflowPublish"],
    ["--help", "help"],
  ]);
  const values = new Map([
    ["--repository", "repository"],
    ["--tag", "tag"],
    ["--expected-sha", "expectedSha"],
    ["--assets-dir", "assetsDir"],
    ["--remote", "remotes"],
  ]);
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (switches.has(flag)) result[switches.get(flag)] = true;
    else if (values.has(flag)) {
      const value = argv[++index];
      assert(value && !value.startsWith("--"), `${flag} 缺少参数`);
      if (flag === "--remote") result.remotes.push(value);
      else result[values.get(flag)] = value;
    } else throw new Error(`未知参数：${flag}`);
  }
  assert(
    !(result.workflowGate && result.workflowPublish),
    "workflow 模式不能组合",
  );
  if (result.expectedSha)
    assert(
      /^[a-f0-9]{40}$/.test(result.expectedSha),
      "expected SHA 必须是完整提交哈希",
    );
  if (result.tag) parseVersion(result.tag);
  return result;
}

export function normalizeConfig(
  options = {},
  configuredRemotes = ["github", "lc-server"],
) {
  const mappings = options.remotes?.length
    ? options.remotes
    : ["github=public-release:main", "lc-server=main:main"];
  const remotes = mappings.map((mapping) => {
    const match =
      /^([A-Za-z0-9][A-Za-z0-9._-]*)=(main|public-release):([A-Za-z0-9][A-Za-z0-9._/-]*)$/.exec(
        mapping,
      );
    assert(
      match && !match[3].includes("..") && !match[3].includes("//"),
      "无效远端映射：使用 remote=main:branch 或 remote=public-release:branch",
    );
    return { name: match[1], source: match[2], destination: match[3] };
  });
  assert(
    new Set(remotes.map((remote) => remote.name)).size === remotes.length,
    "远端映射重复",
  );
  assert(
    configuredRemotes.length === remotes.length &&
      configuredRemotes.every((name) =>
        remotes.some((remote) => remote.name === name),
      ),
    "每个配置远端必须恰好有一个显式映射；请用 --remote 补全",
  );
  const github = remotes.find((remote) => remote.name === "github");
  assert(
    github?.source === "public-release" && github.destination === "main",
    "GitHub 只能推送 public-release:main，禁止 main 历史外泄",
  );
  assert(
    remotes.some(
      (remote) => remote.name === "lc-server" && remote.source === "main",
    ),
    "lc-server 必须接收完整 main",
  );
  const repository = options.repository ?? "Diselorya/PortViewer";
  assert(
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository),
    "无效 GitHub 仓库名",
  );
  return {
    repository,
    remotes,
    publicBranch: "public-release",
    sourceBranch: "main",
    ciWorkflow: "ci.yml",
    releaseWorkflow: "release.yml",
  };
}

export function parseChecksumManifest(contents) {
  const result = new Map();
  for (const line of contents
    .replace(/^\uFEFF/, "")
    .trim()
    .split(/\r?\n/)) {
    const match = /^([a-fA-F0-9]{64})[ \t]+\*?([^\\/\r\n]+)$/.exec(line);
    assert(
      match && PACKAGE_ASSETS.includes(match[2]) && !result.has(match[2]),
      "校验清单含无效、重复或未知文件",
    );
    result.set(match[2], match[1].toLowerCase());
  }
  return result;
}

export function validateChecksumCoverage(windows, linux) {
  const win =
    typeof windows === "string" ? parseChecksumManifest(windows) : windows;
  const lin = typeof linux === "string" ? parseChecksumManifest(linux) : linux;
  assert(
    win.size === 3 && PACKAGE_ASSETS.slice(0, 3).every((name) => win.has(name)),
    "Windows 清单必须且仅覆盖三个 Windows 包",
  );
  assert(
    lin.size === 1 && lin.has(PACKAGE_ASSETS[3]),
    "Linux 清单必须且仅覆盖 Linux 包",
  );
  return new Map([...win, ...lin]);
}

export function validateContentRange(value, start, end, total) {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value ?? "");
  assert(
    match &&
      Number(match[1]) === start &&
      Number(match[2]) === end &&
      Number(match[3]) === total,
    "Range 响应区间/总长度不符",
  );
  return end - start + 1;
}

export function assertSuccessfulCi(
  run,
  jobs = [],
  expectedSha = run?.head_sha,
) {
  assert(
    run?.head_sha === expectedSha && /^[a-f0-9]{40}$/.test(expectedSha ?? ""),
    "CI 提交不是目标公开 SHA",
  );
  assert(
    run.event === "push" && run.head_branch === "main",
    "CI 必须来自公开 main 的 push",
  );
  assert(
    run.status === "completed" && run.conclusion === "success",
    "目标提交 CI 尚未全绿",
  );
  for (const name of REQUIRED_CI_JOBS)
    assert(
      jobs.some(
        (job) =>
          job.name === name &&
          job.status === "completed" &&
          job.conclusion === "success",
      ),
      `CI 必需任务未成功：${name}`,
    );
  return run;
}

export function validateReleaseAssets(assets) {
  const expected = expectedAssetNames();
  assert(
    assets.length === expected.length &&
      new Set(assets.map((asset) => asset.name)).size === expected.length &&
      assets.every((asset) => expected.includes(asset.name)),
    "Release 必须恰好包含六个指定文件",
  );
  for (const asset of assets) {
    assert(
      Number.isSafeInteger(asset.size) &&
        asset.size > 0 &&
        asset.size <= 1024 ** 3,
      "Release 文件大小无效",
    );
    assert(
      /^sha256:[a-f0-9]{64}$/.test(asset.digest ?? ""),
      `GitHub API 缺少 SHA-256 digest：${asset.name}`,
    );
  }
  return assets;
}
