#!/usr/bin/env node
// buzzboard launcher: serves the bundled SPA on localhost and opens the
// browser. Zero dependencies — the app is static files; your Nostr key
// stays in the browser and requests go only to your relay.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const DIST = fileURLToPath(new URL("../dist", import.meta.url));
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".png": "image/png",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".map": "application/json",
};

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(`buzzboard — kanban for buzz communities

Usage: npx buzzboard [options]

Options:
  --demo       open the built-in demo (fake data, simulated agents)
  --port <n>   listen on a specific port (default 8401)
  --no-open    don't open the browser
  -h, --help   show this help`);
  process.exit(0);
}
const portFlag = args.indexOf("--port");
const port = portFlag !== -1 ? Number(args[portFlag + 1]) : 8401;
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`invalid port: ${args[portFlag + 1]}`);
  process.exit(1);
}

const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname));
  let file = join(DIST, path);
  if (!file.startsWith(DIST)) {
    res.writeHead(403).end();
    return;
  }
  try {
    let body;
    try {
      body = await readFile(file);
    } catch {
      file = join(DIST, "index.html"); // SPA fallback
      body = await readFile(file);
    }
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(500).end();
  }
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `port ${port} is already in use (another buzzboard?). ` +
      `Try: npx buzzboard --port ${port + 1}`,
    );
    process.exit(1);
  }
  throw err;
});

server.listen(port, "127.0.0.1", () => {
  const url = `http://localhost:${port}/${args.includes("--demo") ? "?demo" : ""}`;
  console.log(`buzzboard serving at ${url}  (Ctrl+C to stop)`);
  if (!args.includes("--no-open")) {
    const opener = process.platform === "darwin" ? ["open", [url]]
      : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
      : ["xdg-open", [url]];
    spawn(opener[0], opener[1], { stdio: "ignore", detached: true }).on("error", () => {
      /* no browser opener available — the URL is printed above */
    }).unref();
  }
});
