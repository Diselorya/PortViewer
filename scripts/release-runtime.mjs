import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

export async function validatePackagedRuntime(directory, { version } = {}) {
  directory = path.resolve(directory);
  const identity = JSON.parse(
    await readFile(
      path.join(directory, "web-assets/portviewer-build-identity.json"),
      "utf8",
    ),
  );
  assert(identity.productVersion === version, "运行包静态版本不符");
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const port = probe.address().port;
  await new Promise((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
  const base = `http://127.0.0.1:${port}`;
  const linux = process.platform === "linux";
  const executable = path.join(
    directory,
    linux ? "start.sh" : "portviewer-web.exe",
  );
  const args = linux
    ? ["--listen", `127.0.0.1:${port}`]
    : [
        "serve",
        "--listen",
        `127.0.0.1:${port}`,
        "--assets",
        path.join(directory, "web-assets"),
      ];
  const env = { ...process.env, RUST_LOG: "warn" };
  for (const name of Object.keys(env))
    if (name.startsWith("PORTVIEWER_")) delete env[name];
  const child = spawn(executable, args, {
    cwd: path.dirname(directory),
    env,
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let failure;
  child.once("error", (error) => {
    failure = error;
  });
  child.stderr.resume();
  const exited = new Promise((resolve) => child.once("close", resolve));
  const get = (endpoint) =>
    fetch(base + endpoint, { signal: AbortSignal.timeout(30_000) });
  try {
    let healthy = false;
    const deadline = Date.now() + 30_000;
    while (!healthy && Date.now() < deadline) {
      assert(!failure && child.exitCode === null, "打包 WebGUI 无法启动");
      try {
        const response = await fetch(base + "/api/health", {
          signal: AbortSignal.timeout(1000),
        });
        healthy = response.ok && (await response.json()).status === "ok";
      } catch {}
      if (!healthy) await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert(healthy, "打包 WebGUI health 检查失败");
    const response = await get("/api/v1/build-identity");
    assert(response.status === 200, "运行包身份接口失败");
    const build = await response.json();
    for (const key of [
      "productId",
      "productVersion",
      "frontendContractVersion",
    ])
      assert(build[key] === identity[key], "运行包前后端版本不一致");
    assert(
      build.frontendSourceHash === identity.sourceHash,
      "运行包前后端 sourceHash 不一致",
    );
    const page = await get("/");
    assert(page.status === 200, "打包页面不可访问");
    let assets = 0;
    for (const match of (await page.text()).matchAll(
      /(?:src|href)="([^"]+)"/g,
    )) {
      const url = new URL(match[1], base + "/");
      assert(
        url.origin === base &&
          (await get(url.pathname + url.search)).status === 200,
        "打包页面静态资源不可访问",
      );
      assets++;
    }
    assert(assets > 0, "打包页面没有资源引用");
    const scan = await get("/api/v1/scan");
    assert(
      scan.status === 200 && Array.isArray((await scan.json()).entries),
      "打包 WebGUI scan 检查失败",
    );
    return {
      version,
      sourceHash: identity.sourceHash,
      health: "ok",
      scan: "ok",
      assets,
    };
  } finally {
    if (child.exitCode === null) child.kill();
    await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
    if (child.exitCode === null && !failure) {
      child.kill("SIGKILL");
      await exited;
    }
  }
}

export async function validateWindowsArchiveRuntime(
  entries,
  { version, directory },
) {
  assert(process.platform === "win32", "Windows 部署包运行验收需要 Windows");
  const temporary = await mkdtemp(path.join(directory, ".runtime-check-"));
  for (const [name, entry] of entries) {
    if (entry.directory) continue;
    const target = path.join(temporary, ...name.split("/"));
    assert(
      !path.relative(temporary, target).startsWith(".."),
      "运行验收解包路径越界",
    );
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, entry.contents, { flag: "wx" });
  }
  return validatePackagedRuntime(temporary, { version });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const [, , directory, version] = process.argv;
  assert(
    directory && version,
    "用法：node scripts/release-runtime.mjs <部署目录> <版本>",
  );
  validatePackagedRuntime(directory, { version }).then(
    (result) => console.log(JSON.stringify(result)),
    (error) => {
      console.error(error.message);
      process.exitCode = 1;
    },
  );
}
