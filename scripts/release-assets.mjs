import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  appendFile,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  truncate,
  unlink,
  writeFile,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { gunzipSync, inflateRawSync } from "node:zlib";
import {
  expectedAssetNames,
  PACKAGE_ASSETS,
  parseVersion,
  validateChecksumCoverage,
  validateContentRange,
  validateReleaseAssets,
} from "./release-lib.mjs";
import { validateWindowsArchiveRuntime } from "./release-runtime.mjs";

export async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
const exists = (file) =>
  lstat(file).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });

async function ensureOwnedDirectory(anchor, directory) {
  anchor = path.resolve(anchor);
  directory = path.resolve(directory);
  const relative = path.relative(anchor, directory);
  assert(
    !path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(".." + path.sep),
    "本地发行路径越界",
  );
  let current = anchor;
  for (const part of ["", ...relative.split(path.sep).filter(Boolean)]) {
    if (part) current = path.join(current, part);
    const info = await exists(current);
    if (info)
      assert(
        info.isDirectory() && !info.isSymbolicLink(),
        "发行目录中包含链接或非目录",
      );
    else await mkdir(current);
  }
}

export async function downloadAsset({
  asset,
  destination,
  fetchImpl = fetch,
  sleepImpl = delay,
  attempts = 8,
  chunkSize = 4 * 1024 * 1024,
}) {
  assert(
    /^[^\\/]+$/.test(asset.name) &&
      /^sha256:[a-f0-9]{64}$/.test(asset.digest ?? ""),
    "下载缺少可信资产 SHA-256",
  );
  assert(
    Number.isSafeInteger(asset.size) &&
      asset.size > 0 &&
      asset.size <= 1024 ** 3,
    "下载资产大小无效",
  );
  assert(
    Number.isSafeInteger(attempts) &&
      attempts > 0 &&
      attempts <= 20 &&
      Number.isSafeInteger(chunkSize) &&
      chunkSize > 0,
    "下载重试/分段参数无效",
  );
  const url = new URL(asset.browser_download_url);
  assert(
    url.protocol === "https:" &&
      url.hostname === "github.com" &&
      !url.username &&
      !url.password,
    "下载只允许 GitHub HTTPS 发布地址",
  );
  const digest = asset.digest.slice(7);
  const partial = destination + ".part";
  const metadata = partial + ".json";
  const tail = partial + ".tail";
  await mkdir(path.dirname(destination), { recursive: true });
  if (await exists(destination)) {
    assert((await lstat(destination)).isFile(), "下载目标不是普通文件");
    if (
      (await stat(destination)).size === asset.size &&
      (await sha256(destination)) === digest
    ) {
      // A process may stop after the final rename but before sidecar cleanup.
      // Recover that completed asset without leaving extra files in its stage.
      for (const sidecar of [partial, metadata, tail]) {
        const info = await exists(sidecar);
        if (info) {
          assert(info.isFile(), "下载恢复暂存文件不是普通文件");
          await unlink(sidecar);
        }
      }
      return destination;
    }
    throw new Error(`已有暂存资产不匹配，保留现场：${asset.name}`);
  }
  const fingerprint = JSON.stringify({
    size: asset.size,
    digest,
    id: asset.id ?? null,
  });
  if (await exists(partial))
    assert((await lstat(partial)).isFile(), "分段文件不是普通文件");
  const old = await readFile(metadata, "utf8").catch(() => "");
  if (
    old !== fingerprint ||
    (await stat(partial).catch(() => ({ size: 0 }))).size > asset.size
  )
    await writeFile(partial, Buffer.alloc(0));
  await writeFile(metadata, fingerprint);
  await appendFile(partial, Buffer.alloc(0));
  const progressTimer = setInterval(() => {
    stat(partial).then(
      (info) =>
        console.log(
          JSON.stringify({
            asset: asset.name,
            retainedBytes: info.size,
            totalBytes: asset.size,
            phase: "downloading",
          }),
        ),
      () => {},
    );
  }, 20_000);
  progressTimer.unref();
  try {
    for (let pass = 0; pass < 2; pass++) {
      while ((await stat(partial)).size < asset.size) {
        const segmentEnd =
          Math.min(asset.size, (await stat(partial)).size + chunkSize) - 1;
        let complete = false;
        for (let attempt = 1; attempt <= attempts; attempt++) {
          const start = (await stat(partial)).size;
          if (start > segmentEnd) {
            complete = true;
            break;
          }
          // Clear the tail before fetch, including failures before response headers.
          if (await exists(tail))
            assert((await lstat(tail)).isFile(), "下载尾段不是普通文件");
          const handle = await open(tail, "w");
          let validHeaders = false;
          let count = 0;
          try {
            const response = await fetchImpl(url, {
              headers: {
                Range: `bytes=${start}-${segmentEnd}`,
                "Accept-Encoding": "identity",
              },
              signal: AbortSignal.timeout(120_000),
              redirect: "follow",
            });
            if (response.status === 206)
              validateContentRange(
                response.headers.get("content-range"),
                start,
                segmentEnd,
                asset.size,
              );
            else
              assert(
                response.status === 200 &&
                  start === 0 &&
                  segmentEnd + 1 === asset.size &&
                  Number(response.headers.get("content-length")) === asset.size,
                "服务端未满足精确 Range 请求",
              );
            assert(
              !response.headers.get("content-encoding") ||
                response.headers.get("content-encoding") === "identity",
              "Range 响应不可压缩",
            );
            validHeaders = true;
            for await (const data of response.body) {
              count += data.length;
              assert(count <= segmentEnd - start + 1, "响应超过请求区间");
              await handle.writeFile(data);
            }
          } catch {
            // A verified range may have a valid prefix after TLS interruption. Never print redirect URLs.
            if (count > segmentEnd - start + 1) validHeaders = false;
          } finally {
            await handle.close();
          }
          if (validHeaders && count > 0) {
            const data = await readFile(tail);
            assert(data.length === count, "尾段长度不符");
            await appendFile(partial, data);
          }
          if ((await stat(partial)).size === segmentEnd + 1) {
            complete = true;
            break;
          }
          if (attempt < attempts)
            await sleepImpl(Math.min(10_000, 500 * 2 ** (attempt - 1)));
        }
        assert(complete, `下载分段重试耗尽，可原命令恢复：${asset.name}`);
      }
      if ((await sha256(partial)) === digest) {
        await rename(partial, destination);
        await unlink(tail).catch((error) => {
          if (error.code !== "ENOENT") throw error;
        });
        await unlink(metadata);
        return destination;
      }
      await truncate(partial, 0);
    }
    throw new Error(`下载完成但 SHA-256 不匹配：${asset.name}`);
  } finally {
    clearInterval(progressTimer);
  }
}

export function safeArchivePath(name) {
  assert(
    typeof name === "string" &&
      !name.startsWith("/") &&
      !name.includes("\\") &&
      !name.includes(":") &&
      !name.includes("\0"),
    "归档含不安全路径",
  );
  const parts = name.split("/");
  assert(!parts.includes(".."), "归档路径越界");
  return parts.filter((part) => part && part !== ".").join("/");
}

export function readZipEntries(data) {
  let footer = -1;
  for (
    let index = data.length - 22;
    index >= Math.max(0, data.length - 65_557);
    index--
  ) {
    if (
      data.readUInt32LE(index) === 0x06054b50 &&
      index + 22 + data.readUInt16LE(index + 20) === data.length
    ) {
      footer = index;
      break;
    }
  }
  assert(
    footer >= 0 &&
      data.readUInt16LE(footer + 4) === 0 &&
      data.readUInt16LE(footer + 6) === 0,
    "无效或分卷 ZIP",
  );
  const count = data.readUInt16LE(footer + 10);
  assert(
    count < 5000 && count === data.readUInt16LE(footer + 8),
    "ZIP 条目数量无效",
  );
  let offset = data.readUInt32LE(footer + 16);
  const entries = new Map();
  for (let index = 0; index < count; index++) {
    assert(data.readUInt32LE(offset) === 0x02014b50, "ZIP 目录无效");
    const flags = data.readUInt16LE(offset + 8);
    const method = data.readUInt16LE(offset + 10);
    const compressed = data.readUInt32LE(offset + 20);
    const size = data.readUInt32LE(offset + 24);
    const length = data.readUInt16LE(offset + 28);
    const name = safeArchivePath(
      data.subarray(offset + 46, offset + 46 + length).toString("utf8"),
    );
    const mode = data.readUInt32LE(offset + 38) >>> 16;
    assert(
      !entries.has(name) &&
        !(flags & 1) &&
        [0, 8].includes(method) &&
        size <= 32 * 1024 ** 2,
      "ZIP 含重复、加密、超大或不支持的条目",
    );
    assert(
      !mode || [0, 0o100000, 0o040000].includes(mode & 0o170000),
      "ZIP 含链接或特殊文件",
    );
    const local = data.readUInt32LE(offset + 42);
    assert(data.readUInt32LE(local) === 0x04034b50, "ZIP 本地头无效");
    const start =
      local +
      30 +
      data.readUInt16LE(local + 26) +
      data.readUInt16LE(local + 28);
    assert(start + compressed <= data.length, "ZIP 数据越界");
    const contents =
      method === 0
        ? data.subarray(start, start + compressed)
        : inflateRawSync(data.subarray(start, start + compressed), {
            maxOutputLength: 32 * 1024 ** 2,
          });
    assert(contents.length === size, "ZIP 解压长度不符");
    entries.set(name, {
      contents,
      mode,
      directory:
        Boolean(mode & 0o040000) ||
        (size === 0 && data[offset + 46 + length - 1] === 47),
    });
    offset +=
      46 +
      length +
      data.readUInt16LE(offset + 30) +
      data.readUInt16LE(offset + 32);
  }
  return entries;
}

export function readTarEntries(compressed) {
  const data = gunzipSync(compressed, { maxOutputLength: 512 * 1024 ** 2 });
  const entries = new Map();
  const field = (buffer) => buffer.toString("utf8").replace(/\0.*$/, "");
  const number = (buffer) => {
    const value = field(buffer).trim();
    assert(/^[0-7]*$/.test(value), "tar 数值格式无效");
    return value ? parseInt(value, 8) : 0;
  };
  for (let offset = 0; offset + 512 <= data.length;) {
    const header = data.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const sum = [...header].reduce(
      (total, byte, index) => total + (index >= 148 && index < 156 ? 32 : byte),
      0,
    );
    assert(sum === number(header.subarray(148, 156)), "tar 头校验失败");
    const prefix = field(header.subarray(345, 500));
    const name = safeArchivePath(
      (prefix ? prefix + "/" : "") + field(header.subarray(0, 100)),
    );
    const type = header[156];
    const size = number(header.subarray(124, 136));
    const mode = number(header.subarray(100, 108));
    assert(
      [0, 48, 53].includes(type) && !(mode & 0o7000) && !entries.has(name),
      "tar 含链接、特殊文件或重复路径",
    );
    assert(
      offset + 512 + size <= data.length && entries.size < 5000,
      "tar 数据越界",
    );
    entries.set(name, {
      contents: data.subarray(offset + 512, offset + 512 + size),
      mode,
      directory: type === 53,
    });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

export function validateWebArchive(entries, version, linux = false) {
  const [major, minor] = parseVersion(version).split(".").map(Number);
  if (major > 1 || (major === 1 && minor >= 3)) {
    const guide = entries.get("docs/service-knowledge.md");
    assert(
      guide && !guide.directory && guide.contents.length > 0,
      "部署包缺少 docs/service-knowledge.md",
    );
  }
  for (const name of [
    "README.md",
    "README.zh-CN.md",
    "LICENSE",
    "SECURITY.md",
    "docs/webgui-deployment.md",
    "docs/lan-port-api.md",
    "docs/api/portviewer-lan.openapi.yaml",
    "web-assets/index.html",
    "web-assets/portviewer-build-identity.json",
    linux ? "portviewer-web" : "portviewer-web.exe",
  ])
    assert(
      entries.has(name) && !entries.get(name).directory,
      `部署包缺少 ${name}`,
    );
  const identity = JSON.parse(
    entries
      .get("web-assets/portviewer-build-identity.json")
      .contents.toString("utf8"),
  );
  assert(
    identity.schemaVersion === 1 &&
      identity.productVersion === parseVersion(version) &&
      identity.productId === "com.portviewer.desktop" &&
      /^[a-f0-9]{64}$/.test(identity.sourceHash),
    "WebGUI 内置版本/身份不符",
  );
  const hash = createHash("sha256");
  const assets = [...entries]
    .filter(
      ([name, entry]) =>
        name.startsWith("web-assets/") &&
        !entry.directory &&
        name !== "web-assets/portviewer-build-identity.json",
    )
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  for (const [name, entry] of assets) {
    hash.update(name.slice("web-assets/".length));
    hash.update(Buffer.from([0]));
    hash.update(entry.contents);
    hash.update(Buffer.from([255]));
  }
  assert(
    hash.digest("hex") === identity.distHash,
    "WebGUI 内置 distHash 校验失败",
  );
  if (linux) {
    for (const name of ["start.sh", "portviewer-web"])
      assert(entries.get(name)?.mode === 0o755, `${name} 必须是0755`);
    const launcher = entries.get("start.sh").contents;
    assert(
      launcher.subarray(0, 2).toString() === "#!" && !launcher.includes(13),
      "Linux 启动脚本必须使用 LF",
    );
    assert(
      entries
        .get("deploy/linux/portviewer-web.service")
        ?.contents.includes("AF_NETLINK") &&
        entries.has("deploy/linux/portviewer-web-full-attribution.conf"),
      "Linux systemd 模板缺失或不完整",
    );
  }
  return identity;
}

export async function inspectInstallerVersions(directory) {
  assert(
    process.platform === "win32",
    "安装器版本验收需要 Windows PowerShell/Windows Installer；本地一键发布请在 Windows 执行",
  );
  const literal = (value) => "'" + value.replaceAll("'", "''") + "'";
  const exe = path.join(directory, PACKAGE_ASSETS[0]);
  const msi = path.join(directory, PACKAGE_ASSETS[1]);
  const script = `$ErrorActionPreference='Stop'; $exeVersion=(Get-Item -LiteralPath ${literal(exe)}).VersionInfo.ProductVersion; $installer=New-Object -ComObject WindowsInstaller.Installer; $database=$installer.OpenDatabase(${literal(msi)},0); $view=$database.OpenView("SELECT Value FROM Property WHERE Property='ProductVersion'"); $view.Execute(); $record=$view.Fetch(); $msiVersion=$record.StringData(1); @{exe=$exeVersion;msi=$msiVersion}|ConvertTo-Json -Compress`;
  return JSON.parse(
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: 60_000,
        stdio: ["ignore", "pipe", "pipe"],
      },
    ),
  );
}

export async function validateLocalAssets(
  directory,
  {
    version,
    assets,
    installerInspector = inspectInstallerVersions,
    runtimeInspector = validateWindowsArchiveRuntime,
  } = {},
) {
  version = parseVersion(version);
  const names = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
  assert(
    expectedAssetNames().every((name) => names.includes(name)) &&
      names.every((name) => expectedAssetNames().includes(name)),
    "资产目录必须恰好包含六个发布文件",
  );
  if (assets) validateReleaseAssets(assets);
  const checksums = validateChecksumCoverage(
    await readFile(path.join(directory, "SHA256SUMS-windows.txt"), "utf8"),
    await readFile(path.join(directory, "SHA256SUMS-linux.txt"), "utf8"),
  );
  const hashes = {};
  for (const name of expectedAssetNames()) {
    const file = path.join(directory, name);
    assert((await lstat(file)).isFile(), "发布文件不可为链接");
    const digest = await sha256(file);
    if (checksums.has(name))
      assert(digest === checksums.get(name), `SHA-256 不符：${name}`);
    if (assets) {
      const asset = assets.find((asset) => asset.name === name);
      assert(
        asset.digest === "sha256:" + digest &&
          asset.size === (await stat(file)).size,
        `GitHub asset digest/大小不符：${name}`,
      );
    }
    hashes[name] = digest;
  }
  const windowsEntries = readZipEntries(
    await readFile(path.join(directory, PACKAGE_ASSETS[2])),
  );
  const windows = validateWebArchive(windowsEntries, version);
  const linux = validateWebArchive(
    readTarEntries(await readFile(path.join(directory, PACKAGE_ASSETS[3]))),
    version,
    true,
  );
  assert(
    windows.frontendContractVersion === linux.frontendContractVersion,
    "Windows/Linux WebGUI 合约版本不一致",
  );
  const installers = await installerInspector(directory);
  for (const value of [installers.exe, installers.msi])
    assert(
      typeof value === "string" &&
        value.replace(/\.0$/, value.split(".").length === 4 ? "" : ".0") ===
          version,
      "安装器 ProductVersion 不符",
    );
  await runtimeInspector(windowsEntries, { version, directory });
  return { version, hashes, sourceHash: windows.sourceHash };
}

export async function installLocalRelease(
  stage,
  {
    root,
    tag,
    publicSha,
    releaseUrl,
    assets,
    installerInspector,
    runtimeInspector,
  } = {},
) {
  const version = parseVersion(tag);
  const verified = await validateLocalAssets(stage, {
    version,
    assets,
    installerInspector,
    runtimeInspector,
  });
  const releaseRoot = path.join(root, "release");
  const versionRoot = path.join(releaseRoot, "v" + version);
  await ensureOwnedDirectory(root, versionRoot);
  const archive = path.join(
    releaseRoot,
    "archive",
    "replaced-" +
      new Date().toISOString().replaceAll(/[:.]/g, "-") +
      "-" +
      randomUUID().slice(0, 8),
  );
  // All six files have passed every gate before any current asset changes.
  for (const [label, directory] of [
    ["root", releaseRoot],
    ["version", versionRoot],
  ]) {
    for (const name of expectedAssetNames()) {
      const target = path.join(directory, name);
      const previous = await exists(target);
      if (previous) {
        assert(
          previous.isFile() && !previous.isSymbolicLink(),
          "拒绝替换链接或非文件资产",
        );
        if ((await sha256(target)) === verified.hashes[name]) continue;
        const historical = path.join(archive, label, name);
        await ensureOwnedDirectory(releaseRoot, path.dirname(historical));
        await copyFile(target, historical);
      }
      const incoming = path.join(
        directory,
        ".incoming-" + randomUUID() + "-" + name,
      );
      await copyFile(path.join(stage, name), incoming);
      assert(
        (await sha256(incoming)) === verified.hashes[name],
        "落地副本 SHA-256 不符",
      );
      await rename(incoming, target);
    }
  }
  const readme = `# PortViewer 本地发行包\n\n当前正式版本：**v${version}**。\n\n来源：${releaseUrl}\n\n公开源码提交：${publicSha}\n\n根目录与 v${version}/ 的六个文件已核对四包 SHA-256、GitHub API digest、Windows 安装器及 WebGUI 内置版本。被替换文件保存在 archive/。\n`;
  const oldReadme = await exists(path.join(releaseRoot, "README.md"));
  assert(
    !oldReadme || (oldReadme.isFile() && !oldReadme.isSymbolicLink()),
    "本地发行 README 不可为链接",
  );
  await writeFile(path.join(releaseRoot, "README.md"), readme);
  for (const directory of [releaseRoot, versionRoot])
    for (const name of expectedAssetNames())
      assert(
        (await sha256(path.join(directory, name))) === verified.hashes[name],
        "最终本地副本 SHA-256 不符",
      );
  return verified;
}
