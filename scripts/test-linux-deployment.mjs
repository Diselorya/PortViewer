import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baseUnit = serviceSettings(
  await readFile(
    path.join(root, "deploy/linux/portviewer-web.service"),
    "utf8",
  ),
);
const fullDropIn = serviceSettings(
  await readFile(
    path.join(root, "deploy/linux/portviewer-web-full-attribution.conf"),
    "utf8",
  ),
);
const units = new Set();
const elevatedPrefix = process.getuid?.() === 0 ? [] : ["sudo", "-n"];

function serviceSettings(source) {
  let section = "";
  const settings = new Map();
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) section = trimmed;
    else if (section === "[Service]" && /^[A-Za-z]+=/.test(trimmed)) {
      const separator = trimmed.indexOf("=");
      settings.set(trimmed.slice(0, separator), trimmed.slice(separator + 1));
    }
  }
  return settings;
}

function staticChecks() {
  const families = baseUnit.get("RestrictAddressFamilies")?.split(/\s+/);
  for (const family of ["AF_UNIX", "AF_INET", "AF_INET6", "AF_NETLINK"]) {
    assert(families?.includes(family), `systemd must allow ${family}`);
  }
  assert(baseUnit.get("User"), "the default service must select a user");
  assert.notEqual(baseUnit.get("User"), "root", "root attribution is opt-in");
  assert.match(baseUnit.get("ExecStart"), /--listen 127\.0\.0\.1:/);
  assert.equal(fullDropIn.get("User"), "root");
  assert.equal(fullDropIn.get("Group"), "root");
  const hardened = new Map([...baseUnit, ...fullDropIn]);
  for (const [key, value] of [
    ["NoNewPrivileges", "true"],
    ["PrivateTmp", "true"],
    ["ProtectSystem", "strict"],
    ["ProtectHome", "read-only"],
    ["ProtectKernelTunables", "true"],
    ["ProtectKernelModules", "true"],
    ["ProtectControlGroups", "true"],
    ["LockPersonality", "true"],
    ["RestrictRealtime", "true"],
    ["RestrictSUIDSGID", "true"],
    ["SystemCallArchitectures", "native"],
    ["UMask", "0077"],
  ]) {
    assert.equal(baseUnit.get(key), value, `default hardening ${key}`);
    assert.equal(hardened.get(key), value, `root drop-in must preserve ${key}`);
  }
  assert.equal(
    hardened.get("RestrictAddressFamilies"),
    baseUnit.get("RestrictAddressFamilies"),
    "root attribution must retain the address-family sandbox",
  );
  console.log(
    "PASS: Linux deployment keeps AF_NETLINK and opt-in root hardening",
  );
}

async function privileged(command, args, timeout = 20_000) {
  const [program, ...prefix] = elevatedPrefix.length
    ? [...elevatedPrefix, command]
    : [command];
  return execute(program, [...prefix, ...args], {
    cwd: root,
    timeout,
    maxBuffer: 1024 * 1024,
  });
}

async function stopOwnedUnit(unit) {
  try {
    await privileged("systemctl", ["stop", unit]);
  } catch (error) {
    // --collect may already have unloaded a fixture which failed to start.
    const state = await privileged("systemctl", [
      "show",
      unit,
      "--property=LoadState",
      "--value",
    ]).catch((failure) => ({ stdout: failure.stdout ?? "" }));
    if (state.stdout.trim() !== "not-found") throw error;
  }
  units.delete(unit);
}

async function fixtureDiagnostics(unit) {
  const state = await privileged(
    "systemctl",
    [
      "show",
      unit,
      "--property=ActiveState",
      "--property=SubState",
      "--property=MainPID",
      "--property=ExecMainCode",
      "--property=ExecMainStatus",
      "--no-pager",
    ],
    5000,
  );
  const mainPid = /^MainPID=(\d+)$/m.exec(state.stdout)?.[1];
  if (!mainPid || mainPid === "0") return state.stdout;
  const children = await readFile(
    `/proc/${mainPid}/task/${mainPid}/children`,
    "utf8",
  ).catch(() => "");
  const pids = [
    mainPid,
    ...children.trim().split(/\s+/).filter(Boolean).slice(0, 8),
  ];
  const processes = await Promise.all(
    pids.map(async (pid) => {
      const name = await readFile(`/proc/${pid}/comm`, "utf8").catch(
        () => "exited",
      );
      const wait = await readFile(`/proc/${pid}/wchan`, "utf8").catch(
        () => "unavailable",
      );
      return `PID ${pid}: ${name.trim()} (wait ${wait.trim()})`;
    }),
  );
  return `${state.stdout}${processes.join("\n")}`;
}

async function freePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function fetchJson(url, timeout = 30_000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  return { response, body: await response.json() };
}

async function waitForHealth(base, unit) {
  const deadline = performance.now() + 15_000;
  let lastError;
  while (performance.now() < deadline) {
    try {
      const { response, body } = await fetchJson(`${base}/api/health`, 1000);
      if (response.ok && body.status === "ok") return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const journal = await privileged("journalctl", [
    "--unit",
    unit,
    "--no-pager",
    "--lines=20",
  ]);
  throw new Error(`${unit} did not start: ${lastError}\n${journal.stdout}`);
}

async function startUnit(mode, overrides = new Map()) {
  const binary =
    process.env.PORTVIEWER_TEST_BINARY ??
    path.join(root, "web-service/target/debug/portviewer-web");
  const port = await freePort();
  const unit = `portviewer-regression-${process.pid}-${mode}.service`;
  const description = `PortViewer deployment regression ${mode}`;
  const settings = new Map([...baseUnit, ...overrides]);
  settings.set("WorkingDirectory", root);
  const properties = [...settings]
    .filter(
      ([key]) => !["Type", "ExecStart", "Restart", "RestartSec"].includes(key),
    )
    .map(([key, value]) => `--property=${key}=${value}`);
  units.add(unit);
  await privileged("systemd-run", [
    "--quiet",
    "--collect",
    "--service-type=simple",
    `--unit=${unit}`,
    `--description=${description}`,
    ...properties,
    "--",
    binary,
    "serve",
    "--listen",
    `127.0.0.1:${port}`,
    "--assets",
    path.join(root, "dist"),
  ]);
  const base = `http://127.0.0.1:${port}`;
  await waitForHealth(base, unit);
  return { base, port, unit, description };
}

async function listenerFixture() {
  await mkdir(path.join(root, ".tmp"), { recursive: true });
  const directory = await mkdtemp(path.join(root, ".tmp", "linux-deployment-"));
  await chmod(directory, 0o755);
  const script = path.join(directory, "listener.mjs");
  const manifest = path.join(directory, "package.json");
  await writeFile(
    manifest,
    JSON.stringify({
      name: "portviewer-deployment-fixture",
      description: "Cross-user listener for Linux deployment regression",
      type: "module",
    }),
  );
  await writeFile(
    script,
    'import net from "node:net"; const server = net.createServer((socket) => socket.end()); server.listen(0, "127.0.0.1", () => process.send({ port: server.address().port }));',
  );
  const child = spawn(process.execPath, [script], {
    cwd: directory,
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  let timer;
  try {
    const message = await Promise.race([
      once(child, "message").then(([message]) => message),
      once(child, "exit").then(([code]) => {
        throw new Error(`listener exited ${code}: ${stderr}`);
      }),
      new Promise((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("listener timed out")),
          10_000,
        );
      }),
    ]);
    return {
      port: message.port,
      pid: child.pid,
      directory,
      script,
      metadata: manifest,
      async close() {
        if (child.exitCode === null) {
          const exited = once(child, "exit");
          child.kill("SIGKILL");
          let exitTimer;
          try {
            await Promise.race([
              exited,
              new Promise((_resolve, reject) => {
                exitTimer = setTimeout(
                  () =>
                    reject(new Error("listener did not exit within 5 seconds")),
                  5000,
                );
              }),
            ]);
          } finally {
            clearTimeout(exitTimer);
          }
        }
        await unlink(script);
        await unlink(manifest);
        await rmdir(directory);
      },
    };
  } catch (error) {
    child.kill("SIGKILL");
    await unlink(script);
    await unlink(manifest);
    await rmdir(directory);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function listenerEntries(scan, port) {
  return scan.entries.filter(
    (entry) => entry.local_port === port && entry.state === "Listen",
  );
}

function fixtureAttributionDiagnostics(fixture, entry) {
  const safeText = (value, limit = 1024) =>
    typeof value === "string" ? value.slice(0, limit) : value;
  const attributions = (entry?.attributions ?? []).slice(0, 16).map((item) => ({
    kind: item.kind,
    name: safeText(item.name),
    description: safeText(item.description),
    confidence: item.confidence,
    // Report only path/mode evidence for our own fixture, never raw argv or env.
    facts: (item.facts ?? [])
      .filter(
        (fact) =>
          /路径|目录|入口|文件|模式|元数据|状态|path|directory|entry|file|mode|metadata|state/i.test(
            fact.label,
          ) && !/命令|参数|环境|command|argument|env/i.test(fact.label),
      )
      .slice(0, 32)
      .map((fact) => ({
        label: safeText(fact.label, 128),
        value: safeText(fact.value),
      })),
  }));
  return JSON.stringify(
    {
      fixture: {
        pid: fixture.pid,
        port: fixture.port,
        directory: fixture.directory,
        script: fixture.script,
        metadata: fixture.metadata,
      },
      attributions,
    },
    null,
    2,
  );
}

async function runtimeFixture(kind) {
  // Native Linux temp storage avoids npm's repeated metadata reads on WSL /mnt/c.
  // The scanner has PrivateTmp; project evidence must use the target's /proc root.
  const directory = await mkdtemp(
    path.join(tmpdir(), `portviewer-${kind}-deployment-`),
  );
  await chmod(directory, 0o755);
  const unit = `portviewer-regression-${process.pid}-${kind}-fixture.service`;
  const name = `portviewer-${kind}-fixture`;
  const description =
    kind === "npm"
      ? "Development listener started through an actual npm parent"
      : "Python deployment listener\nwith a multiline project description.";
  const script = path.join(
    directory,
    kind === "npm" ? "listener.mjs" : "listener.py",
  );
  const metadata = path.join(
    directory,
    kind === "npm" ? "package.json" : "pyproject.toml",
  );
  const files = new Map(
    kind === "npm"
      ? [
          [
            metadata,
            JSON.stringify({
              name,
              description,
              type: "module",
              scripts: { dev: "node listener.mjs" },
            }),
          ],
          [
            script,
            'import net from "node:net"; const server = net.createServer((socket) => socket.end()); server.listen(0, "127.0.0.1", () => console.log(JSON.stringify({ pid: process.pid, port: server.address().port })));',
          ],
        ]
      : [
          [
            metadata,
            `[project]\nname = "${name}"\ndescription = """${description}"""\n`,
          ],
          [
            script,
            'import json, os, socket\nlistener = socket.socket()\nlistener.bind(("127.0.0.1", 0))\nlistener.listen()\nprint(json.dumps({"pid": os.getpid(), "port": listener.getsockname()[1]}), flush=True)\nwhile True:\n    connection, _ = listener.accept()\n    connection.close()\n',
          ],
        ],
  );
  async function removeFiles() {
    for (const filename of files.keys()) {
      await unlink(filename).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
    await rmdir(directory);
  }
  try {
    for (const [filename, contents] of files)
      await writeFile(filename, contents);
    const command = kind === "npm" ? "npm" : "python3";
    const executable = await realpath(
      (await execute("which", [command], { timeout: 5000 })).stdout.trim(),
    );
    const argumentsToRun =
      kind === "npm"
        ? [process.execPath, executable, "--silent", "run", "dev"]
        : [executable, "-B", "-u", script];
    units.add(unit);
    // control-group termination includes npm's shell and Node children.
    await privileged("systemd-run", [
      "--quiet",
      "--collect",
      "--service-type=simple",
      `--unit=${unit}`,
      `--description=PortViewer owned ${kind} integration fixture`,
      `--property=WorkingDirectory=${directory}`,
      "--property=User=root",
      "--property=Group=root",
      "--property=NoNewPrivileges=true",
      "--property=KillMode=control-group",
      "--property=TimeoutStopSec=5s",
      "--property=StandardOutput=journal",
      "--property=StandardError=journal",
      `--property=Environment=PATH=${path.dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_AUDIT=false NPM_CONFIG_FUND=false NPM_CONFIG_LOGS_MAX=0`,
      "--",
      ...argumentsToRun,
    ]);
    const deadline = performance.now() + 60_000;
    let journal = "";
    let journalFailures = 0;
    let lastJournalError = null;
    while (performance.now() < deadline) {
      try {
        journal = (
          await privileged(
            "journalctl",
            [`--unit=${unit}`, "--output=cat", "--no-pager", "--lines=10"],
            Math.max(
              1,
              Math.min(20_000, Math.ceil(deadline - performance.now())),
            ),
          )
        ).stdout;
      } catch (error) {
        // A cold WSL journal read can time out before the fixture is observable.
        // Keep the last successful log and retry within the overall ready budget.
        journalFailures += 1;
        lastJournalError = String(error.message).slice(0, 1000);
      }
      for (const line of journal.split(/\r?\n/)) {
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (
          !Number.isInteger(message?.pid) ||
          message.pid <= 0 ||
          !Number.isInteger(message?.port) ||
          message.port < 1 ||
          message.port > 65535
        )
          continue;
        return {
          ...message,
          name,
          description,
          directory,
          script,
          metadata,
          async close() {
            await stopOwnedUnit(unit);
            await removeFiles();
          },
        };
      }
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Math.min(250, Math.max(0, deadline - performance.now())),
        ),
      );
    }
    const diagnostics = await fixtureDiagnostics(unit).catch(
      (error) => error.message,
    );
    throw new Error(
      `${kind} fixture did not report its listener within 60 seconds:\n${diagnostics}\nJournal read failures: ${journalFailures}; last failure: ${lastJournalError ?? "none"}\n${journal}`,
    );
  } catch (error) {
    if (units.has(unit)) {
      await stopOwnedUnit(unit);
    }
    await removeFiles();
    throw error;
  }
}

function assertRuntime(scan, fixture, kind) {
  const listener = listenerEntries(scan, fixture.port).find(
    (entry) => entry.pid === fixture.pid,
  );
  assert(listener, `${kind} fixture must map to its real listener PID`);
  const project = listener.attributions.find(
    (item) => item.name === fixture.name,
  );
  assert(
    project,
    `${kind} fixture must expose the actual project name\n${fixtureAttributionDiagnostics(fixture, listener)}`,
  );
  assert.equal(
    project.description,
    fixture.description,
    `${kind} static project description`,
  );
  for (const expected of [
    fixture.directory,
    fixture.script,
    fixture.metadata,
  ]) {
    assert(
      project.facts.some((fact) => fact.value === expected),
      `${kind} must expose path ${expected}`,
    );
  }
  const mode = project.facts.find((fact) => fact.label === "运行模式")?.value;
  assert.match(
    mode ?? "",
    kind === "npm" ? /\bdev\b/ : /script|脚本/i,
    `${kind} must explain the actual runtime mode`,
  );
}

async function integrationChecks() {
  assert.equal(process.platform, "linux", "integration requires Linux/systemd");
  await privileged("systemctl", ["show", "--property=Version"]);
  const { stdout } = await execute("id", ["-gn", "nobody"], { timeout: 5000 });
  const limitedUser = new Map([
    ["User", "nobody"],
    ["Group", stdout.trim()],
  ]);
  const fixture = await listenerFixture();
  const runtimeFixtures = [];
  try {
    const npmFixture = await runtimeFixture("npm");
    runtimeFixtures.push(npmFixture);
    const pythonFixture = await runtimeFixture("python");
    runtimeFixtures.push(pythonFixture);
    const limited = await startUnit("limited", limitedUser);
    const limitedScan = await fetchJson(`${limited.base}/api/v1/scan`);
    assert.equal(
      limitedScan.response.status,
      200,
      "AF_NETLINK must allow scans",
    );
    assert(
      listenerEntries(limitedScan.body, limited.port).some(
        (entry) => entry.pid > 0,
      ),
    );
    const restricted = listenerEntries(limitedScan.body, fixture.port);
    assert(
      restricted.length > 0,
      "limited mode still enumerates other users' ports",
    );
    assert(
      restricted.every((entry) => entry.pid === 0),
      "limited mode must not invent a PID",
    );
    assert(
      restricted.every((entry) => entry.process_status !== "System"),
      "a hidden user process must not be labeled System",
    );
    assert(
      limitedScan.body.warnings.some(
        (warning) => warning.code === "attribution_limited",
      ),
    );
    assert(
      limitedScan.body.attribution_reports.some(
        (report) => report.elevation_may_help,
      ),
    );

    const full = await startUnit("root", fullDropIn);
    const fullScan = await fetchJson(`${full.base}/api/v1/scan`);
    assert.equal(fullScan.response.status, 200);
    const attributed = listenerEntries(fullScan.body, fixture.port).find(
      (entry) => entry.pid === fixture.pid,
    );
    assert(attributed, "root drop-in must identify the cross-user listener");
    assert.match(attributed.process_name, /node/i);
    assert(
      attributed.process_path,
      "root attribution must report executable path",
    );
    assertRuntime(fullScan.body, npmFixture, "npm");
    assertRuntime(fullScan.body, pythonFixture, "Python");
    console.log(
      "PASS: actual /tmp npm/Python project metadata and runtime modes",
    );
    assert(
      attributed.attributions.some((item) =>
        item.name.includes("portviewer-deployment-fixture"),
      ),
      `the real Node project manifest must be reported\n${fixtureAttributionDiagnostics(fixture, attributed)}`,
    );
    const ownService = listenerEntries(fullScan.body, full.port);
    const ownServiceEntry = ownService.find((entry) =>
      entry.attributions.some(
        (item) => item.kind === "SystemdService" && item.name === full.unit,
      ),
    );
    assert(
      ownServiceEntry,
      "systemd attribution must name the real transient service",
    );
    const ownAttribution = ownServiceEntry.attributions.find(
      (item) => item.kind === "SystemdService" && item.name === full.unit,
    );
    assert.equal(
      ownAttribution.description,
      full.description,
      "systemd attribution must report the actual fixture Unit Description",
    );
    const fragment = await privileged("systemctl", [
      "show",
      full.unit,
      "--property=FragmentPath",
      "--value",
    ]);
    const configPath = fragment.stdout.trim();
    assert(
      path.isAbsolute(configPath) && path.basename(configPath) === full.unit,
      "the real transient service must have its own absolute config path",
    );
    assert.equal(
      ownAttribution.facts.find((fact) => fact.label === "配置路径")?.value,
      configPath,
      "systemd attribution config path must equal the manager's FragmentPath",
    );
    assert.match(
      ownAttribution.facts.find((fact) => fact.label === "运行模式")?.value ??
        "",
      /^systemd (?:服务|service)$/i,
      "systemd attribution must identify the actual system service runtime mode",
    );

    // Removing only AF_NETLINK reproduces the reported healthy-but-unscannable service.
    const withoutNetlink = await startUnit(
      "no-netlink",
      new Map([
        ...limitedUser,
        ["RestrictAddressFamilies", "AF_UNIX AF_INET AF_INET6"],
      ]),
    );
    const blocked = await fetchJson(`${withoutNetlink.base}/api/v1/scan`);
    assert.equal(
      blocked.response.status,
      500,
      "missing AF_NETLINK must block enumeration",
    );
    assert.match(
      blocked.body.error,
      /AF_NETLINK/,
      "the failure must explain the sandbox requirement",
    );
    console.log(
      "PASS: systemd sandbox, limited attribution, actual npm/Python project metadata and runtime modes, root service attribution and AF_NETLINK failure control",
    );
  } finally {
    const fixtureCleanup = await Promise.allSettled(
      runtimeFixtures.map((runtime) => runtime.close()),
    );
    const stopped = await Promise.allSettled(
      [...units].map((unit) => stopOwnedUnit(unit)),
    );
    await fixture.close();
    for (const result of [...fixtureCleanup, ...stopped]) {
      if (result.status === "rejected") console.error(result.reason.message);
    }
    const failedCleanup = [...fixtureCleanup, ...stopped].find(
      (result) => result.status === "rejected",
    );
    if (failedCleanup) throw failedCleanup.reason;
  }
}

try {
  staticChecks();
  if (process.argv.includes("--integration")) await integrationChecks();
  else console.log("SKIP: live systemd checks require Linux and --integration");
} catch (error) {
  console.error(error.stack ?? error);
  process.exitCode = 1;
}
