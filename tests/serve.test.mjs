import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../plugins/nateherk-design/skills/scroll-craft/scripts/serve.mjs", import.meta.url));

async function startServer(root, t) {
  const reservation = net.createServer().listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, [script, "--root", root, "--port", String(port)], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
    assert.equal(stderr, "", "server should not emit uncaught errors");
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server startup timed out")), 5000);
    child.stdout.on("data", () => { clearTimeout(timer); resolve(); });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", code => { clearTimeout(timer); reject(new Error(`server exited during startup: ${code}`)); });
  });
  return url => new Promise((resolve, reject) => {
    const request = http.get({ hostname: "127.0.0.1", port, path: url }, response => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, body, headers: response.headers }));
      response.on("error", reject);
    });
    request.setTimeout(5000, () => request.destroy(new Error("request timed out")));
    request.on("error", reject);
  });
}

test("static server confines files and directory indexes to its root", async t => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "scrollcraft-serve-"));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const root = path.join(fixture, "root");
  const sibling = path.join(fixture, "root-other");
  fs.mkdirSync(path.join(root, "inside"), { recursive: true });
  fs.mkdirSync(path.join(root, "index-link"));
  fs.mkdirSync(path.join(root, "empty"));
  fs.mkdirSync(path.join(root, "directory-index", "index.html"), { recursive: true });
  fs.mkdirSync(sibling);
  fs.writeFileSync(path.join(root, "index.html"), "root page");
  fs.writeFileSync(path.join(root, "inside", "index.html"), "inside page");
  fs.writeFileSync(path.join(root, "asset.txt"), "inside asset");
  fs.writeFileSync(path.join(sibling, "index.html"), "outside fixture");
  const get = await startServer(root, t);

  for (const [url, body] of [["/", "root page"], ["/inside/", "inside page"], ["/asset.txt?fresh=1", "inside asset"]]) {
    await t.test(`serves ${url}`, async () => {
      const response = await get(url);
      assert.equal(response.status, 200);
      assert.equal(response.body, body);
      assert.equal(response.headers["cache-control"], "no-store");
      assert.equal(Number(response.headers["content-length"]), Buffer.byteLength(body));
    });
  }
  for (const [url, status] of [["/missing", 404], ["/empty/", 404], ["/directory-index/", 403], ["/%E0%A4%A", 400], ["/%2e%2e/root-other/index.html", 403]]) {
    await t.test(`rejects ${url}`, async () => assert.equal((await get(url)).status, status));
  }
  await t.test("unreadable files return 403 without stopping the server", {
    skip: process.platform === "win32" || process.getuid?.() === 0 ? "requires POSIX file permissions and a non-root user" : false,
  }, async () => {
    const unreadable = path.join(root, "unreadable.txt");
    fs.writeFileSync(unreadable, "unreadable fixture");
    fs.chmodSync(unreadable, 0);
    try {
      assert.equal((await get("/unreadable.txt")).status, 403);
      assert.equal((await get("/")).body, "root page");
    } finally { fs.chmodSync(unreadable, 0o600); }
  });

  try {
    fs.symlinkSync(path.join(root, "asset.txt"), path.join(root, "safe-file"), "file");
    fs.symlinkSync(path.join(root, "asset.txt"), path.join(root, "alias.js"), "file");
    fs.symlinkSync(path.join(root, "inside"), path.join(root, "safe-dir"), process.platform === "win32" ? "junction" : "dir");
    fs.symlinkSync(path.join(sibling, "index.html"), path.join(root, "outside-file"), "file");
    fs.symlinkSync(sibling, path.join(root, "outside-dir"), process.platform === "win32" ? "junction" : "dir");
    fs.symlinkSync(path.join(sibling, "index.html"), path.join(root, "index-link", "index.html"), "file");
    fs.symlinkSync(path.join(fixture, "absent"), path.join(root, "broken"), "file");
    fs.symlinkSync(path.join(root, "loop"), path.join(root, "loop"), "file");
    fs.symlinkSync(root, path.join(fixture, "linked-root"), process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (!["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) throw error;
    await t.test("symlink cases", { skip: `symlinks unavailable: ${error.code}` }, () => {});
    return;
  }
  await t.test("serves symlinks resolving inside the root", async () => {
    assert.equal((await get("/safe-file")).body, "inside asset");
    assert.equal((await get("/safe-dir/")).body, "inside page");
    const alias = await get("/alias.js");
    assert.equal(alias.status, 200);
    assert.equal(alias.headers["content-type"], "text/javascript; charset=utf-8");
    assert.equal(alias.body, "inside asset");
  });
  for (const url of ["/outside-file", "/outside-dir/", "/outside-dir/index.html", "/index-link/"]) {
    await t.test(`refuses ${url}`, async () => {
      const response = await get(url);
      assert.equal(response.status, 403);
      assert.equal(response.body, "forbidden");
    });
  }
  await t.test("broken symlinks return 404 without stopping the server", async () => {
    assert.equal((await get("/broken")).status, 404);
    assert.equal((await get("/loop")).status, 404);
    assert.equal((await get("/")).body, "root page");
  });
  await t.test("a symlinked root preserves the same boundary", async t => {
    const getLinked = await startServer(path.join(fixture, "linked-root"), t);
    assert.equal((await getLinked("/safe-file")).body, "inside asset");
    assert.equal((await getLinked("/outside-file")).status, 403);
  });
});
