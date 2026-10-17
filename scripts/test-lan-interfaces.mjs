import { execFile, spawn } from "node:child_process";
import dgram from "node:dgram";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import os from "node:os";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const binary =
  process.env.PORTVIEWER_TEST_BINARY ??
  path.join(
    root,
    "web-service",
    "target",
    "debug",
    process.platform === "win32" ? "portviewer-web.exe" : "portviewer-web",
  );
const token = randomBytes(32).toString("hex");
const knowledgeDirectory = path.join(
  root,
  ".tmp",
  "knowledge-lan-" + randomUUID(),
);
const serviceEnvironment = {
  ...process.env,
  PORTVIEWER_API_TOKEN: token,
  PORTVIEWER_KNOWLEDGE_DIR: knowledgeDirectory,
  PORTVIEWER_KNOWLEDGE_OFFLINE: "1",
  RUST_LOG: "warn",
};
const children = new Set();

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function listen(server, port = 0) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return server.address().port;
}

async function close(server) {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

async function bindUdp(socket) {
  await new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(0, "127.0.0.1", resolve);
  });
  return socket.address().port;
}

async function closeUdp(socket) {
  await new Promise((resolve) => socket.close(resolve));
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(
      `HTTP ${response.status} returned invalid JSON: ${text.slice(0, 300)}`,
    );
  }
  return { response, body };
}

async function waitForHealth(base) {
  let lastError;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const { response, body } = await fetchJson(`${base}/api/health`);
      if (response.ok && body?.status === "ok") return body;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`API did not become healthy: ${lastError ?? "timeout"}`);
}

async function requestWithHost(base, host) {
  const url = new URL("/api/health", base);
  return await new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        headers: { Host: host },
      },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode));
      },
    );
    request.once("error", reject);
    request.end();
  });
}

async function verifyGuiBinaryVersion(expectedVersion) {
  const expectedIdentity = JSON.parse(
    await readFile(
      path.join(root, "dist", "portviewer-build-identity.json"),
      "utf8",
    ),
  );
  const probe = net.createServer();
  const port = await listen(probe);
  await close(probe);
  const base = "http://127.0.0.1:" + port;
  const child = spawn(
    binary,
    [
      "serve",
      "--listen",
      "127.0.0.1:" + port,
      "--assets",
      path.join(root, "dist"),
    ],
    {
      cwd: root,
      env: serviceEnvironment,
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    },
  );
  children.add(child);
  child.stderr.resume();
  try {
    await waitForHealth(base);
    const identity = await fetchJson(base + "/api/v1/build-identity");
    assert(
      identity.response.ok && identity.body?.productVersion === expectedVersion,
      "integration tests require the current-version binary and assets",
    );
    assert(
      identity.body?.frontendSourceHash === expectedIdentity.sourceHash,
      "integration tests require the same frontend source identity",
    );
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await Promise.race([
        new Promise((resolve) => child.once("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
    children.delete(child);
  }
}

function assignedPrivateAddress() {
  return Object.values(os.networkInterfaces())
    .flat()
    .find((item) => {
      if (!item || item.internal || item.family !== "IPv4") return false;
      const parts = item.address.split(".").map(Number);
      return (
        parts[0] === 10 ||
        (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
        (parts[0] === 192 && parts[1] === 168)
      );
    })?.address;
}
async function privateRequest(base, address, pathname, options = {}) {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const payload =
      options.body === undefined ? undefined : JSON.stringify(options.body);
    const request = http.request(
      {
        hostname: address,
        port: url.port,
        localAddress: address,
        path: pathname,
        method: options.method ?? "GET",
        headers: {
          ...(payload === undefined
            ? {}
            : {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
              }),
          ...options.headers,
        },
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          text += chunk;
        });
        response.on("end", () => {
          try {
            resolve({
              status: response.statusCode,
              body: text ? JSON.parse(text) : null,
            });
          } catch {
            reject(new Error("LAN knowledge route returned invalid JSON"));
          }
        });
      },
    );
    request.setTimeout(30000, () =>
      request.destroy(new Error("LAN knowledge request timed out")),
    );
    request.once("error", reject);
    request.end(payload);
  });
}
async function checkKnowledgeAuthorization(base) {
  const settings = {
    online_enabled: false,
    ai_enabled: false,
    reverse_dns_enabled: false,
  };
  const local = await fetchJson(base + "/api/v1/knowledge/settings");
  assert(
    local.response.ok && local.body.can_configure === true,
    "loopback may inspect knowledge configuration",
  );
  const saved = await fetchJson(base + "/api/v1/knowledge/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings),
  });
  assert(
    saved.response.ok &&
      saved.body.can_configure === true &&
      saved.body.online_enabled === false,
    "loopback may save knowledge settings",
  );
  const invalidBody = await fetchJson(base + "/api/v1/knowledge/profiles", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ entries: [], url: "http://127.0.0.1/" }),
  });
  assert(
    invalidBody.response.status === 400,
    "knowledge API must reject client-supplied local entries and URLs",
  );
  const invalidAddress = await fetchJson(
    base + "/api/v1/knowledge/host?address=example.com",
  );
  assert(
    invalidAddress.response.status === 400,
    "host details only accept numeric IPs",
  );
  const address = assignedPrivateAddress();
  if (!address) return "SKIP (no assigned private IPv4 interface)";
  const routes = [
    { path: "/api/v1/knowledge/settings" },
    { path: "/api/v1/knowledge/host?address=127.0.0.1" },
    {
      path: "/api/v1/knowledge/profiles",
      method: "POST",
      body: { profile_ids: [], refresh: false },
    },
  ];
  for (const route of routes) {
    const missing = await privateRequest(base, address, route.path, route);
    assert(
      missing.status === 401,
      "remote knowledge route must require a Bearer token",
    );
    assert(
      !missing.body?.profiles && !missing.body?.machine_name,
      "unauthorized knowledge response must not contain advanced data",
    );
    const wrong = await privateRequest(base, address, route.path, {
      ...route,
      headers: { Authorization: "Bearer invalid-invalid-invalid-invalid" },
    });
    assert(
      wrong.status === 401,
      "remote knowledge route must reject a wrong token",
    );
    const accepted = await privateRequest(base, address, route.path, {
      ...route,
      headers: { Authorization: "Bearer " + token },
    });
    assert(
      accepted.status === 200,
      "valid token must permit read-only knowledge inspection",
    );
    if (route.path.endsWith("settings"))
      assert(
        accepted.body.can_configure === false,
        "remote settings must advertise read-only configuration",
      );
    const badHost = await privateRequest(base, address, route.path, {
      ...route,
      headers: { Authorization: "Bearer " + token, Host: "evil.example" },
    });
    assert(
      badHost.status === 400 && badHost.body?.code === "invalid_host",
      "knowledge routes must enforce Host validation after authentication",
    );
    const badOrigin = await privateRequest(base, address, route.path, {
      ...route,
      headers: {
        Authorization: "Bearer " + token,
        Origin: "https://evil.example",
      },
    });
    assert(
      badOrigin.status === 403 && badOrigin.body?.code === "invalid_origin",
      "knowledge routes must reject cross-origin callers",
    );
  }
  const write = await privateRequest(
    base,
    address,
    "/api/v1/knowledge/settings",
    {
      method: "PUT",
      headers: { Authorization: "Bearer " + token },
      body: settings,
    },
  );
  assert(
    write.status === 403 && write.body?.code === "local_settings_only",
    "valid remote token must never allow settings writes",
  );
  const scan = await privateRequest(base, address, "/api/v1/scan", {
    headers: { Authorization: "Bearer " + token },
  });
  assert(
    scan.status === 403 && !scan.body?.entries,
    "API-only remote access must not reveal full scans",
  );
  return "PASS";
}

function startMcp(base) {
  const child = spawn(binary, ["mcp", "--server", base], {
    cwd: root,
    env: serviceEnvironment,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  children.add(child);
  const pending = new Map();
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const lines = readline.createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    if (message.id !== undefined && pending.has(String(message.id))) {
      const { resolve } = pending.get(String(message.id));
      pending.delete(String(message.id));
      resolve(message);
    }
  });

  function request(method, params) {
    const id = String(pending.size + 1);
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(
          new Error(`MCP ${method} timed out. stderr: ${stderr.slice(-1000)}`),
        );
      }, 30_000);
      pending.set(id, {
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message);
        },
      });
    });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
    );
    return response;
  }

  function notify(method, params = {}) {
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`,
    );
  }

  async function stop() {
    lines.close();
    child.stdin.end();
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
    if (child.exitCode === null) child.kill();
    children.delete(child);
  }

  return { request, notify, stop };
}

async function main() {
  const expectedVersion = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8"),
  ).version;
  await verifyGuiBinaryVersion(expectedVersion);
  const portProbe = net.createServer();
  const apiPort = await listen(portProbe);
  await close(portProbe);
  const occupiedServer = net.createServer();
  const occupiedPort = await listen(occupiedServer);
  const occupiedUdp = dgram.createSocket("udp4");
  const occupiedUdpPort = await bindUdp(occupiedUdp);
  const base = `http://127.0.0.1:${apiPort}`;
  const service = spawn(
    binary,
    ["serve", "--api-only", "--listen", `0.0.0.0:${apiPort}`],
    {
      cwd: root,
      env: serviceEnvironment,
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    },
  );
  children.add(service);
  let serviceStderr = "";
  service.stderr.setEncoding("utf8");
  service.stderr.on("data", (chunk) => {
    serviceStderr += chunk;
  });

  try {
    const health = await waitForHealth(base);
    assert(health.apiVersion === 1, "health must advertise API v1");
    assert(
      health.tokenDetailsConfigured === true,
      "health must report token support",
    );
    const removedScan = await fetch(`${base}/api/v1/scan`);
    assert(
      removedScan.status === 404,
      "API-only mode must remove full scan route",
    );

    const knowledgeAuthorization = await checkKnowledgeAuthorization(base);

    const basic = await fetchJson(
      `${base}/api/v1/ports/check?ports=${occupiedPort},30001-30002&protocol=tcp`,
    );
    assert(basic.response.ok, "anonymous basic query must succeed");
    const occupied = basic.body.results.find(
      (item) => item.port === occupiedPort,
    );
    assert(occupied?.status === "occupied", "known listener must be occupied");
    assert(
      !("endpoints" in occupied),
      "anonymous result must not leak endpoints",
    );
    assert(
      !("endpointCount" in occupied),
      "anonymous result must not leak endpoint counts",
    );

    const udp = await fetchJson(
      `${base}/api/v1/ports/check?ports=${occupiedUdpPort}&protocol=udp`,
    );
    assert(
      udp.body.results[0].status === "occupied",
      "known UDP binding must be occupied",
    );

    const capacityStarted = performance.now();
    const capacity = await fetchJson(
      `${base}/api/v1/ports/check?ports=30001-31024&protocol=tcp`,
    );
    assert(capacity.response.ok, "1024-port capacity query must succeed");
    const capacityMs = performance.now() - capacityStarted;
    assert(
      capacity.body.results.length === 1024,
      "capacity query must return 1024 results",
    );
    assert(capacityMs < 10_000, "1024-port query exceeded 10 seconds");
    const excessive = await fetchJson(
      `${base}/api/v1/ports/check?ports=30001-31025&protocol=tcp`,
    );
    assert(
      excessive.response.status === 400,
      "1025-port query must be rejected",
    );
    const invalidQuery = await fetchJson(
      `${base}/api/v1/ports/check?ports=30001&protocol=tcp&detail=true`,
    );
    assert(
      invalidQuery.response.status === 400,
      "unknown query fields must fail",
    );
    assert(
      invalidQuery.body.code === "invalid_query",
      "query errors must use stable envelope",
    );

    const unauthorized = await fetchJson(
      `${base}/api/v1/ports/check?ports=${occupiedPort}&protocol=tcp&details=true`,
    );
    assert(
      unauthorized.response.status === 401,
      "details without token must return 401",
    );
    assert(
      unauthorized.response.headers
        .get("www-authenticate")
        ?.startsWith("Bearer"),
      "401 must include Bearer challenge",
    );

    const invalid = await fetchJson(
      `${base}/api/v1/ports/check?ports=${occupiedPort}&protocol=tcp&details=true`,
      { headers: { Authorization: "Bearer invalid-invalid-invalid-invalid" } },
    );
    assert(invalid.response.status === 401, "wrong token must return 401");

    const detailed = await fetchJson(
      `${base}/api/v1/ports/check?ports=${occupiedPort}&protocol=tcp&details=true`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    assert(detailed.response.ok, "token-authenticated details must succeed");
    assert(
      detailed.body.detailLevel === "detailed",
      "detail level must be explicit",
    );
    assert(
      detailed.body.results[0].endpointCount >= 1,
      "details must include endpoint count",
    );
    assert(
      detailed.body.results[0].endpoints[0].pid > 0,
      "details must include PID",
    );

    const concurrent = await Promise.all(
      Array.from({ length: 16 }, () =>
        fetchJson(
          `${base}/api/v1/ports/check?ports=${occupiedPort}&protocol=tcp&details=true`,
          { headers: { Authorization: `Bearer ${token}` } },
        ),
      ),
    );
    assert(
      concurrent.some(({ response }) => response.status === 200),
      "one concurrent scan must pass",
    );
    assert(
      concurrent.some(({ response }) => response.status === 409),
      "overlapping scans must fail fast with 409",
    );

    assert(
      (await requestWithHost(base, "evil.example")) === 400,
      "invalid Host must fail",
    );

    const free = await fetchJson(`${base}/api/v1/ports/free`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ protocol: "tcp", minPort: 30001, maxPort: 30100 }),
    });
    assert(free.response.ok, "free-port request must succeed");
    assert(
      free.body.advisoryOnly === true,
      "free port must be marked advisory",
    );
    const invalidFreeBody = await fetchJson(`${base}/api/v1/ports/free`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ protocol: "tcp", unexpected: true }),
    });
    assert(
      invalidFreeBody.response.status === 400,
      "unknown free-port fields must fail",
    );
    assert(
      invalidFreeBody.body.code === "invalid_json",
      "JSON errors must use stable envelope",
    );
    const bindVerification = net.createServer();
    await listen(bindVerification, free.body.port);
    await close(bindVerification);

    const cli = await execFileAsync(
      binary,
      [
        "check",
        "--server",
        base,
        "--ports",
        String(occupiedPort),
        "--protocol",
        "tcp",
        "--details",
        "--output",
        "json",
      ],
      {
        cwd: root,
        env: serviceEnvironment,
        timeout: 30_000,
        windowsHide: true,
      },
    );
    const cliBody = JSON.parse(cli.stdout);
    assert(
      cliBody.results[0].status === "occupied",
      "CLI must return API occupancy",
    );
    assert(
      cliBody.results[0].endpoints.length >= 1,
      "CLI details must use token",
    );
    const cliFree = await execFileAsync(
      binary,
      [
        "free",
        "--server",
        base,
        "--protocol",
        "tcp",
        "--min",
        "30001",
        "--max",
        "30100",
        "--output",
        "json",
      ],
      {
        cwd: root,
        env: { ...process.env, RUST_LOG: "warn" },
        timeout: 30_000,
        windowsHide: true,
      },
    );
    assert(
      JSON.parse(cliFree.stdout).advisoryOnly === true,
      "CLI free must return advisory result",
    );

    let publicClientRejected = false;
    try {
      await execFileAsync(
        binary,
        ["check", "--server", "http://8.8.8.8", "--ports", "80"],
        {
          cwd: root,
          timeout: 10_000,
          windowsHide: true,
        },
      );
    } catch (error) {
      publicClientRejected = /非局域网地址/.test(error.stderr ?? "");
    }
    assert(
      publicClientRejected,
      "CLI must reject a public API target before connecting",
    );

    const mcp = startMcp(base);
    try {
      const initialized = await mcp.request("initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "portviewer-ci", version: "1.0.0" },
      });
      assert(
        initialized.result?.serverInfo,
        "MCP initialize must return serverInfo",
      );
      mcp.notify("notifications/initialized");
      const listed = await mcp.request("tools/list", {});
      const names = listed.result.tools.map((tool) => tool.name).sort();
      assert(
        names.join(",") === "portviewer_check_ports,portviewer_find_free_port",
        `unexpected MCP tools: ${names.join(",")}`,
      );
      const checkTool = listed.result.tools.find(
        (tool) => tool.name === "portviewer_check_ports",
      );
      const freeTool = listed.result.tools.find(
        (tool) => tool.name === "portviewer_find_free_port",
      );
      assert(
        checkTool.annotations.readOnlyHint === true,
        "check tool must be read-only",
      );
      assert(
        checkTool.annotations.idempotentHint === true,
        "check tool must be idempotent",
      );
      assert(
        freeTool.annotations.readOnlyHint === true,
        "free tool must be read-only",
      );
      assert(
        freeTool.annotations.idempotentHint === false,
        "random free tool is not idempotent",
      );
      const called = await mcp.request("tools/call", {
        name: "portviewer_check_ports",
        arguments: {
          ports: String(occupiedPort),
          protocol: "tcp",
          details: true,
          response_format: "json",
        },
      });
      assert(called.result?.isError !== true, "MCP port query must succeed");
      const mcpBody = JSON.parse(called.result.content[0].text);
      assert(
        mcpBody.results[0].status === "occupied",
        "MCP must return occupied listener",
      );
      assert(
        mcpBody.results[0].endpoints.length >= 1,
        "MCP details must include endpoints",
      );

      const mcpFree = await mcp.request("tools/call", {
        name: "portviewer_find_free_port",
        arguments: {
          protocol: "tcp",
          min_port: 30001,
          max_port: 30100,
          response_format: "json",
        },
      });
      assert(
        mcpFree.result?.isError !== true,
        "MCP free-port tool must succeed",
      );
      assert(
        JSON.parse(mcpFree.result.content[0].text).advisoryOnly === true,
        "MCP free-port result must be advisory",
      );

      const invalidMcp = await mcp.request("tools/call", {
        name: "portviewer_check_ports",
        arguments: { ports: "80", protocol: "icmp" },
      });
      assert(
        invalidMcp.result?.isError === true,
        "MCP domain errors must set isError",
      );
      assert(
        invalidMcp.result.content[0].text.includes("tcp、udp 或 both"),
        "MCP domain errors must be actionable",
      );
    } finally {
      await mcp.stop();
    }

    console.log(
      JSON.stringify(
        {
          api: "PASS",
          cli: "PASS",
          mcp: "PASS",
          knowledgeAuthorization,
          capacityMs: Number(capacityMs.toFixed(1)),
          occupiedPort,
          suggestedPort: free.body.port,
        },
        null,
        2,
      ),
    );
  } finally {
    await close(occupiedServer);
    await closeUdp(occupiedUdp);
    service.kill();
    children.delete(service);
    await Promise.race([
      new Promise((resolve) => service.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
    if (service.exitCode === null) service.kill();
    if (service.exitCode && service.exitCode !== 1) {
      console.error(serviceStderr.slice(-2000));
    }
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    for (const child of children) child.kill();
    process.exit(1);
  });
}

main().catch((error) => {
  for (const child of children) child.kill();
  console.error(error.stack ?? error);
  process.exit(1);
});
