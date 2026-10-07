#!/usr/bin/env node
/**
 * scrollcraft static server.
 *
 * A scrollcraft page cannot be verified from file://. The engine fetches each
 * clip as a Blob, and file:// fetches are blocked by CORS in every browser, so
 * the page silently falls back to posters and looks fine while proving nothing.
 * Serve it.
 *
 *   node serve.mjs --root builds/perkform --port 4500
 *   node serve.mjs --root builds/perkform --port 4500 --lan   # real-phone test
 *
 * Binds to 127.0.0.1 by default, so nothing else on the network can read the
 * folder. --lan binds every interface for testing on a phone over Wi-Fi, and
 * makes everything under the root readable by anyone on that network while it
 * runs.
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i > -1 && argv[i + 1] ? argv[i + 1] : d; };

const ROOT = fs.realpathSync(path.resolve(arg("--root", ".")));
const PORT = parseInt(arg("--port", "4500"), 10);
const LAN = argv.includes("--lan");
const HOST = LAN ? "0.0.0.0" : "127.0.0.1";
// With the separator, a root of builds/acme can't also serve builds/acme-v2.
const BASE = ROOT.endsWith(path.sep) ? ROOT : ROOT + path.sep;
const insideRoot = file => file === ROOT || file.startsWith(BASE);

function fileError(res, error) {
  if (res.headersSent) { res.destroy(); return; }
  const status = ["ENOENT", "ENOTDIR", "ELOOP"].includes(error.code) ? 404
    : ["EACCES", "EPERM"].includes(error.code) ? 403 : 500;
  res.writeHead(status).end(status === 404 ? "not found" : status === 403 ? "forbidden" : "server error");
}

const TYPES = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".json": "application/json",
  ".mp4": "video/mp4", ".webm": "video/webm",
  ".webp": "image/webp", ".png": "image/png", ".jpg": "image/jpeg",
  ".svg": "image/svg+xml", ".woff2": "font/woff2",
};

http.createServer((req, res) => {
  // A malformed escape (e.g. /%E0%A4%A) makes decodeURIComponent throw, which
  // would otherwise take the whole server down.
  let url;
  try { url = decodeURIComponent(req.url.split("?")[0]); }
  catch { res.writeHead(400).end("bad request"); return; }
  let file = path.join(ROOT, url === "/" ? "/index.html" : url);

  // Refuse to serve outside the root even if the path walks up.
  if (!insideRoot(file)) { res.writeHead(403).end("forbidden"); return; }
  let stat;
  let ext = path.extname(file).toLowerCase();
  try {
    file = fs.realpathSync(file);
    if (!insideRoot(file)) { res.writeHead(403).end("forbidden"); return; }
    if (fs.statSync(file).isDirectory()) {
      file = fs.realpathSync(path.join(file, "index.html"));
      ext = ".html";
    }
    // Check again: an otherwise safe directory can have a linked index.html.
    if (!insideRoot(file)) { res.writeHead(403).end("forbidden"); return; }
    stat = fs.statSync(file);
    if (!stat.isFile()) { res.writeHead(403).end("forbidden"); return; }
  } catch (error) { fileError(res, error); return; }

  const stream = fs.createReadStream(file);
  stream.on("error", error => fileError(res, error));
  res.on("close", () => stream.destroy());
  stream.on("open", () => {
    res.writeHead(200, {
      "Content-Type": TYPES[ext] || "application/octet-stream",
      "Content-Length": stat.size,
      // No caching: verification loops re-shoot the same URLs after edits, and a
      // cached clip or stylesheet makes you screenshot the previous build.
      "Cache-Control": "no-store",
      "Accept-Ranges": "bytes",
    });
    stream.pipe(res);
  });
}).listen(PORT, HOST, () => {
  console.log(`scrollcraft: ${ROOT}\n  http://localhost:${PORT}`);
  if (!LAN) return;
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === "IPv4" && !a.internal) console.log(`  http://${a.address}:${PORT}  (LAN)`);
    }
  }
  console.log("  --lan: everything under the root is readable by anyone on this network until you stop the server.");
});
