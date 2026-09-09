// Serve exactly dist, without Vite's preview-time OTP repacking.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, sep, extname } from "node:path";

const root = fileURLToPath(new URL("../dist/", import.meta.url));
const headers = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-eval'; worker-src 'self' blob:; connect-src 'self' ws://127.0.0.1:*; style-src 'self'; object-src 'none'; base-uri 'none'",
  "Cache-Control": "no-store"
};
const mime = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".wasm": "application/wasm" };
const server = http.createServer(async (req, res) => {
  try {
    if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405, headers).end(); return; }
    const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    const path = resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!path.startsWith(root.endsWith(sep) ? root : root + sep)) { res.writeHead(403, headers).end(); return; }
    let bytes, encoding;
    if (path.endsWith(".tar") && req.headers["accept-encoding"]?.includes("gzip")) {
      bytes = await readFile(path + ".gz"); encoding = "gzip";
    } else bytes = await readFile(path);
    res.writeHead(200, { ...headers, "Content-Type": mime[extname(path)] || "application/octet-stream",
      "Content-Length": bytes.length, ...(encoding ? { "Content-Encoding": encoding, "Vary": "Accept-Encoding" } : {}) });
    res.end(req.method === "HEAD" ? undefined : bytes);
  } catch { res.writeHead(404, headers).end(); }
});
server.on("upgrade", (req, socket, head) => {
  if (req.url !== "/ws") { socket.destroy(); return; }
  const upstream = http.request({ host: "127.0.0.1", port: Number(process.env.LATTICE_POPCORN_PORT || 4059),
    path: "/ws", headers: req.headers });
  // Bound the handshake: a Gateway that accepts the socket but never upgrades must not hang forever.
  const handshakeTimeout = setTimeout(() => { upstream.destroy(); socket.destroy(); }, 5000);
  const abortOnClientClose = () => upstream.destroy();
  socket.once("close", abortOnClientClose);
  upstream.on("upgrade", (response, peer, upstreamHead) => {
    clearTimeout(handshakeTimeout);
    socket.off("close", abortOnClientClose);
    socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers).map(([key, value]) => `${key}: ${value}\r\n`).join("")}\r\n`);
    if (head.length) peer.write(head);
    if (upstreamHead.length) socket.write(upstreamHead);
    peer.on("error", () => socket.destroy());
    socket.on("error", () => peer.destroy());
    socket.on("close", () => peer.destroy());
    peer.on("close", () => socket.destroy());
    socket.pipe(peer).pipe(socket);
  });
  upstream.on("response", () => { clearTimeout(handshakeTimeout); socket.destroy(); });
  upstream.on("error", () => { clearTimeout(handshakeTimeout); socket.destroy(); });
  socket.on("error", () => upstream.destroy());
  upstream.end();
});
server.listen(Number(process.env.LATTICE_POPCORN_PREVIEW_PORT || 5179), "127.0.0.1", () => console.log("Built Popcorn proof preview ready"));
