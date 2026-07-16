import assert from "node:assert/strict";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as edSign,
} from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { extname, normalize, resolve } from "node:path";
import type { Page } from "@playwright/test";
import { TOWNSHIP_NATIVE_KEY_ID } from "../../../clients/township-tauri-shell/src/native_workflow";

export interface NativeIdentity {
  publicKey: Uint8Array;
  publicKeyBase64: string;
  privateSeedBase64: string;
  privateSeedBytesJson: string;
  privateSeedHex: string;
  sign(bytes: Uint8Array): Uint8Array;
}

export interface InvokeCall {
  command: string;
  args: Record<string, unknown>;
}

export interface StaticAppServer {
  server: Server;
  url: string;
}

export async function installTauriIpc(
  page: Page,
  kv: Map<string, string>,
  calls: InvokeCall[],
  signer: NativeIdentity,
): Promise<void> {
  await page.exposeFunction(
    "__townshipTestInvoke",
    async (command: string, args: Record<string, unknown> = {}): Promise<unknown> => {
      calls.push({ command, args });

      switch (command) {
        case "lattice_kv_get":
          return kv.get(requiredString(args, "key")) ?? null;
        case "lattice_kv_set":
          kv.set(requiredString(args, "key"), requiredString(args, "value"));
          return null;
        case "lattice_ensure_carrier_key":
          assert.equal(requiredString(args, "keyId"), TOWNSHIP_NATIVE_KEY_ID);
          return signer.publicKeyBase64;
        case "lattice_sign_carrier":
          assert.equal(requiredString(args, "keyId"), TOWNSHIP_NATIVE_KEY_ID);
          return Buffer.from(signer.sign(Buffer.from(requiredString(args, "bytes"), "base64"))).toString("base64");
        case "lattice_android_current_pairing_handoff_b64":
        case "plugin:deep-link|get_current":
          return null;
        case "plugin:event|listen":
          return args.handler;
        case "plugin:event|unlisten":
        case "lattice_log_probe":
        case "lattice_trace_dev_event":
          return null;
        default:
          throw new Error(`unhandled Tauri test command ${command}`);
      }
    },
  );

  await page.addInitScript(() => {
    const scope = globalThis as typeof globalThis & Record<string, any>;
    const callbacks = new Map<number, (data: unknown) => unknown>();
    const BrowserWebSocket = scope.WebSocket;

    scope.__townshipTestSocketCount = 0;
    scope.WebSocket = new Proxy(BrowserWebSocket, {
      construct(target, args) {
        scope.__townshipTestSocketCount += 1;
        return Reflect.construct(target, args, target);
      },
    });
    scope.isTauri = true;
    scope.__TAURI_INTERNALS__ = {
      callbacks,
      invoke(command: string, args: Record<string, unknown> = {}) {
        return scope.__townshipTestInvoke(command, args);
      },
      transformCallback(callback: (data: unknown) => unknown, once = false) {
        const id = crypto.getRandomValues(new Uint32Array(1))[0];
        callbacks.set(id, (data) => {
          if (once) callbacks.delete(id);
          return callback?.(data);
        });
        return id;
      },
      unregisterCallback(id: number) {
        callbacks.delete(id);
      },
      runCallback(id: number, data: unknown) {
        callbacks.get(id)?.(data);
      },
    };
    scope.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
      unregisterListener(_event: string, id: number) {
        callbacks.delete(id);
      },
    };
  });
}

export async function deliverTauriDeepLink(page: Page, calls: InvokeCall[], url: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (deepLinkHandlerIds(calls).length > 0) break;
    await delay(25);
  }

  const handlerIds = deepLinkHandlerIds(calls);
  assert.ok(handlerIds.length > 0, "expected the shared participant deep-link subscription");

  await page.evaluate(
    ({ ids, deepLink }) => {
      const scope = globalThis as typeof globalThis & Record<string, any>;
      for (const id of ids) {
        scope.__TAURI_INTERNALS__.runCallback(id, {
          event: "deep-link://new-url",
          id,
          payload: [deepLink],
        });
      }
    },
    { ids: handlerIds, deepLink: url },
  );
}

export async function socketCount(page: Page): Promise<number> {
  return page.evaluate(() => Number((globalThis as typeof globalThis & Record<string, unknown>).__townshipTestSocketCount));
}

export async function startStaticAppServer(root: string): Promise<StaticAppServer> {
  const server = createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
    const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const filePath = resolve(root, normalize(relativePath));
    if (!filePath.startsWith(`${resolve(root)}/`) || !statIsFile(filePath)) {
      response.writeHead(404).end("not found");
      return;
    }

    response.setHeader("content-type", contentType(filePath));
    createReadStream(filePath).pipe(response);
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("static app server did not expose a TCP port");
  return { server, url: `http://127.0.0.1:${address.port}` };
}

export function seededEd25519Identity(seed: string): NativeIdentity {
  const privateSeed = createHash("sha256").update(seed).digest();
  const privateKey = createPrivateKey({
    key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), privateSeed]),
    format: "der",
    type: "pkcs8",
  });
  const publicKeyDer = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  const publicKey = new Uint8Array(Buffer.from(publicKeyDer).subarray(12));

  return {
    publicKey,
    publicKeyBase64: Buffer.from(publicKey).toString("base64"),
    privateSeedBase64: privateSeed.toString("base64"),
    privateSeedBytesJson: JSON.stringify([...privateSeed]),
    privateSeedHex: privateSeed.toString("hex"),
    sign(bytes: Uint8Array): Uint8Array {
      return new Uint8Array(edSign(null, Buffer.from(bytes), privateKey));
    },
  };
}

export function requiredValue(values: Map<string, string>, key: string): string {
  const value = values.get(key);
  assert.notEqual(value, undefined, `missing native KV value ${key}`);
  return value as string;
}

function deepLinkHandlerIds(calls: InvokeCall[]): number[] {
  return calls
    .filter(({ command, args }) => command === "plugin:event|listen" && args.event === "deep-link://new-url")
    .map(({ args }) => Number(args.handler));
}

function statIsFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function contentType(path: string): string {
  switch (extname(path)) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    default:
      return "text/html; charset=utf-8";
  }
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error(`missing string argument ${key}`);
  return value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
