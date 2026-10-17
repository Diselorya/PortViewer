import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { PACKAGE_ASSETS } from "../release-lib.mjs";

export const digest = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
export async function temporary(t) {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "portviewer-release-test-"),
  );
  t.after(async () => {
    assert(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert(path.basename(root).startsWith("portviewer-release-test-"));
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

export function webFiles(version = "1.2.0", linux = false) {
  const files = new Map(
    [
      ["README.md", "PortViewer"],
      ["README.zh-CN.md", "端口查看器"],
      ["LICENSE", "MIT"],
      ["SECURITY.md", "Security"],
      ["docs/webgui-deployment.md", "Deploy"],
      ["docs/lan-port-api.md", "API"],
      ["docs/service-knowledge.md", "Service knowledge and optional AI"],
      ["docs/api/portviewer-lan.openapi.yaml", "openapi: 3.0.3"],
      ["web-assets/index.html", "<!doctype html><title>PortViewer</title>"],
      ["web-assets/assets/main.js", "console.log('fixture');"],
      [
        linux ? "portviewer-web" : "portviewer-web.exe",
        linux ? "\x7fELFfixture" : "MZfixture",
      ],
    ].map(([name, text]) => [
      name,
      {
        contents: Buffer.from(text),
        mode: name === "portviewer-web" ? 0o755 : 0o644,
        directory: false,
      },
    ]),
  );
  const hash = createHash("sha256");
  for (const [name, entry] of [...files]
    .filter(([name]) => name.startsWith("web-assets/"))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    hash.update(name.slice("web-assets/".length));
    hash.update(Buffer.from([0]));
    hash.update(entry.contents);
    hash.update(Buffer.from([255]));
  }
  files.set("web-assets/portviewer-build-identity.json", {
    contents: Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        productId: "com.portviewer.desktop",
        productVersion: version,
        frontendContractVersion: 1,
        sourceHash: "a".repeat(64),
        distHash: hash.digest("hex"),
      }),
    ),
    mode: 0o644,
    directory: false,
  });
  if (linux) {
    files.set("start.sh", {
      contents: Buffer.from("#!/bin/sh\nexec ./portviewer-web\n"),
      mode: 0o755,
      directory: false,
    });
    files.set("deploy/linux/portviewer-web.service", {
      contents: Buffer.from(
        "RestrictAddressFamilies=AF_INET AF_INET6 AF_NETLINK\n",
      ),
      mode: 0o644,
      directory: false,
    });
    files.set("deploy/linux/portviewer-web-full-attribution.conf", {
      contents: Buffer.from("[Service]\nUser=root\n"),
      mode: 0o644,
      directory: false,
    });
  }
  return files;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function zip(files) {
  const locals = [],
    centrals = [];
  let offset = 0;
  for (const [name, { contents, mode }] of files) {
    const filename = Buffer.from(name),
      crc = crc32(contents);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(contents.length, 18);
    header.writeUInt32LE(contents.length, 22);
    header.writeUInt16LE(filename.length, 26);
    locals.push(header, filename, contents);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(contents.length, 20);
    central.writeUInt32LE(contents.length, 24);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE(((0o100000 | mode) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, filename);
    offset += header.length + filename.length + contents.length;
  }
  const directory = Buffer.concat(centrals),
    footer = Buffer.alloc(22);
  footer.writeUInt32LE(0x06054b50);
  footer.writeUInt16LE(files.size, 8);
  footer.writeUInt16LE(files.size, 10);
  footer.writeUInt32LE(directory.length, 12);
  footer.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, footer]);
}

export function tar(files) {
  const output = [];
  for (const [name, { contents, mode }] of files) {
    const header = Buffer.alloc(512);
    header.write(name, 0, 100);
    header.write(mode.toString(8).padStart(7, "0") + "\0", 100, 8);
    header.write("0000000\0", 108, 8);
    header.write("0000000\0", 116, 8);
    header.write(contents.length.toString(8).padStart(11, "0") + "\0", 124, 12);
    header.write("00000000000\0", 136, 12);
    header.fill(32, 148, 156);
    header[156] = 48;
    header.write("ustar\0", 257, 6);
    header.write("00", 263, 2);
    const sum = [...header].reduce((a, b) => a + b, 0);
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
    output.push(
      header,
      contents,
      Buffer.alloc((512 - (contents.length % 512)) % 512),
    );
  }
  return gzipSync(Buffer.concat([...output, Buffer.alloc(1024)]));
}

export async function assetDirectory(t, { version = "1.2.0" } = {}) {
  const root = await temporary(t),
    directory = path.join(root, "stage");
  await mkdir(directory);
  const files = new Map([
    [PACKAGE_ASSETS[0], Buffer.from("MZinstaller")],
    [PACKAGE_ASSETS[1], Buffer.from("MSIfixture")],
    [PACKAGE_ASSETS[2], zip(webFiles(version))],
    [PACKAGE_ASSETS[3], tar(webFiles(version, true))],
  ]);
  files.set(
    "SHA256SUMS-windows.txt",
    Buffer.from(
      PACKAGE_ASSETS.slice(0, 3)
        .map((name) => `${digest(files.get(name))}  ${name}`)
        .join("\n"),
    ),
  );
  files.set(
    "SHA256SUMS-linux.txt",
    Buffer.from(
      `${digest(files.get(PACKAGE_ASSETS[3]))}  ${PACKAGE_ASSETS[3]}\n`,
    ),
  );
  for (const [name, bytes] of files)
    await writeFile(path.join(directory, name), bytes);
  const assets = [...files].map(([name, bytes], index) => ({
    id: index + 1,
    name,
    size: bytes.length,
    digest: "sha256:" + digest(bytes),
    browser_download_url: `https://github.com/fixture/repo/releases/download/v${version}/${name}`,
  }));
  return { root, directory, files, assets };
}

export const inspectInstallers = async () => ({ exe: "1.2.0.0", msi: "1.2.0" });
