import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { TOWNSHIP_RELEASE_TRANSPORT_PROBE_FRAME } from "../../src/township_release_transport_probe";

export interface WebSocketProbeServerStats {
  accepts: number;
  upgrades: number;
  framesReceived: number;
  framesEchoed: number;
}

export interface WebSocketProbeServer {
  server: Server;
  stats(): WebSocketProbeServerStats;
}

export async function startWebSocketProbeServer(port: number, host = "127.0.0.1"): Promise<WebSocketProbeServer> {
  const stats: WebSocketProbeServerStats = {
    accepts: 0,
    upgrades: 0,
    framesReceived: 0,
    framesEchoed: 0,
  };
  const server = createServer((socket) => {
    stats.accepts += 1;
    handleWebSocketUpgrade(socket, stats);
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, host, () => {
      server.off("error", rejectListen);
      server.on("error", () => undefined);
      resolveListen();
    });
  });
  return {
    server,
    stats: () => ({ ...stats }),
  };
}

export async function assertHostWebSocketEndpoint(port: number): Promise<void> {
  const response = await rawWebSocketHandshake("127.0.0.1", port);
  assert.match(response, /^HTTP\/1\.1 101 Switching Protocols/im);
}

export async function closeProbeServer(probeServer: WebSocketProbeServer | null): Promise<void> {
  if (!probeServer) return;
  await new Promise<void>((resolveClose) => probeServer.server.close(() => resolveClose()));
}

export function statsDelta(after: WebSocketProbeServerStats, before: WebSocketProbeServerStats): WebSocketProbeServerStats {
  return {
    accepts: after.accepts - before.accepts,
    upgrades: after.upgrades - before.upgrades,
    framesReceived: after.framesReceived - before.framesReceived,
    framesEchoed: after.framesEchoed - before.framesEchoed,
  };
}

async function rawWebSocketHandshake(host: string, port: number): Promise<string> {
  return new Promise<string>((resolveControl, rejectControl) => {
    const socket = createConnection({ host, port });
    let responseBuffer = "";
    let settled = false;
    const timer = setTimeout(() => settle(new Error(`timed out waiting for WebSocket control on ${port}`)), 5_000);
    const settle = (result: string | Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (result instanceof Error) {
        rejectControl(result);
      } else {
        resolveControl(result);
      }
    };

    socket.once("connect", () => {
      socket.write(
        [
          "GET /carrier HTTP/1.1",
          `Host: 127.0.0.1:${port}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          "Sec-WebSocket-Version: 13",
          "Sec-WebSocket-Key: dG93bnNoaXAtY29udHJvbA==",
          "",
          "",
        ].join("\r\n"),
      );
    });
    socket.on("data", (chunk) => {
      responseBuffer += chunk.toString("utf8");
      if (/^HTTP\/1\.1 101 Switching Protocols/im.test(responseBuffer)) settle(responseBuffer);
    });
    socket.once("error", settle);
  });
}

function handleWebSocketUpgrade(socket: Socket, stats: WebSocketProbeServerStats): void {
  socket.on("error", () => undefined);
  let frameBuffer = Buffer.alloc(0);
  const onFrameChunk = (chunk: Buffer): void => {
    frameBuffer = Buffer.concat([frameBuffer, chunk]);
    const parsed = parseTextFrame(frameBuffer);
    if (!parsed) return;
    frameBuffer = frameBuffer.subarray(parsed.consumed);
    stats.framesReceived += 1;
    if (parsed.payload === TOWNSHIP_RELEASE_TRANSPORT_PROBE_FRAME) {
      socket.write(textFrame(parsed.payload));
      stats.framesEchoed += 1;
    }
  };

  let handshakeBuffer = Buffer.alloc(0);
  const onHandshakeChunk = (chunk: Buffer): void => {
    handshakeBuffer = Buffer.concat([handshakeBuffer, chunk]);
    if (handshakeBuffer.length > 8192) {
      socket.destroy();
      return;
    }

    const crlfHeaderEnd = handshakeBuffer.indexOf("\r\n\r\n");
    const lfHeaderEnd = handshakeBuffer.indexOf("\n\n");
    const hasCrlfTerminator = crlfHeaderEnd !== -1 && (lfHeaderEnd === -1 || crlfHeaderEnd <= lfHeaderEnd);
    const headerEnd = hasCrlfTerminator ? crlfHeaderEnd : lfHeaderEnd;
    const headerTerminatorLength = hasCrlfTerminator ? 4 : 2;
    if (headerEnd === -1) {
      return;
    }
    socket.off("data", onHandshakeChunk);

    const request = handshakeBuffer.subarray(0, headerEnd).toString("utf8");
    const key = /^Sec-WebSocket-Key:\s*(.+)$/im.exec(request)?.[1]?.trim();
    if (!key) {
      socket.destroy();
      return;
    }
    const accept = createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "",
        "",
      ].join("\r\n"),
    );
    stats.upgrades += 1;
    socket.on("data", onFrameChunk);
    const remainder = handshakeBuffer.subarray(headerEnd + headerTerminatorLength);
    if (remainder.length > 0) onFrameChunk(remainder);
    setTimeout(() => socket.end(), 1_000);
  };
  socket.on("data", onHandshakeChunk);
}

function parseTextFrame(buffer: Buffer): { consumed: number; payload: string } | null {
  if (buffer.length < 2) return null;
  const opcode = buffer[0] & 0x0f;
  if (opcode !== 0x1) return null;
  const masked = (buffer[1] & 0x80) !== 0;
  const length = buffer[1] & 0x7f;
  if (length > 125) return null;
  const maskOffset = 2;
  const payloadOffset = masked ? maskOffset + 4 : maskOffset;
  const consumed = payloadOffset + length;
  if (buffer.length < consumed) return null;
  const payload = Buffer.from(buffer.subarray(payloadOffset, consumed));
  if (masked) {
    const mask = buffer.subarray(maskOffset, maskOffset + 4);
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] = payload[index] ^ mask[index % 4];
    }
  }
  return { consumed, payload: payload.toString("utf8") };
}

function textFrame(payload: string): Buffer {
  const body = Buffer.from(payload, "utf8");
  assert.ok(body.length <= 125, "probe frame payload must fit in a small WebSocket frame");
  return Buffer.concat([Buffer.from([0x81, body.length]), body]);
}
