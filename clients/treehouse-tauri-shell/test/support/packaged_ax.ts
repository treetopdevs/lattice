import { createHash } from "node:crypto";

// Plan 181 S5c1 (with the S5c0 transfer check folded in). The accessibility driver of the packaged
// harness: one instance per app pid. It talks to `packaged_accessibility.swift` through an injected
// `exec`, so its logic is testable without an app or the Accessibility permission.
//
// Transfer method (decision gate G-AX, see the plan): artifacts of several KiB go into a text field by
// `paste`, which puts the text on the pasteboard in the helper process and posts select-all and paste key
// events to the app's pid. Posting the text as bounded runs of UTF-16 key events (the plan's second
// candidate) was tried locally and rejected: the readback differed from the input after a few hundred
// characters. The preflight below runs first in the packaged harness: 20 byte-exact round trips of an 8 KiB
// artifact, or a G-AX diagnostic that names the method and stops the run, so the hosted job proves the
// transfer before anything else.

export interface AxNode {
  role: string;
  title: string;
  description: string;
  value: string;
  enabled: string;
}
/** Run the helper with these arguments (the app pid is already bound). `input` goes to stdin. */
export type AxExec = (args: string[], input?: string) => string;
export type TransferMethod = "paste";

export interface AxDriverOptions {
  exec: AxExec;
  sleep?: (ms: number) => Promise<void>;
  /** Lookup attempts for a missing control and for a visible-state wait. Default 50 (ten seconds). */
  attempts?: number;
  intervalMs?: number;
  transfer?: TransferMethod;
}

export interface AxDriver {
  readonly transfer: TransferMethod;
  dump(): Promise<AxNode[]>;
  waitFor(what: string, predicate: (nodes: AxNode[]) => boolean | Promise<boolean>, attempts?: number): Promise<AxNode[]>;
  press(label: string): Promise<void>;
  /** Replace the contents of a text field and verify the new value in the dump. */
  put(label: string, value: string): Promise<void>;
  /** The current value of a text field. */
  read(label: string): Promise<string>;
  /** Wait for a text field to hold a non-empty value, and return it. */
  readWhenPresent(label: string, attempts?: number): Promise<string>;
  isEnabled(label: string): Promise<boolean>;
  textVisible(text: string): Promise<boolean>;
  /** Twenty byte-exact round trips of an 8 KiB artifact. Throws a `G-AX transfer check failed` diagnostic. */
  transferPreflight(label: string, rounds?: number, bytes?: number): Promise<void>;
}

const FIELD_ROLES = ["AXTextField", "AXTextArea"];
const named = (node: AxNode, label: string) => node.title === label || node.description === label;
/** Any node whose value, title or description contains the text. */
export const nodesInclude = (nodes: AxNode[], text: string) =>
  nodes.some((node) => [node.value, node.title, node.description].some((part) => part.includes(text)));
const missingControl = (error: unknown) => (error as { status?: number }).status === 3;

/** Deterministic printable ASCII with punctuation and base64url characters, like the real artifacts. */
export function preflightArtifact(round: number, bytes: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.:{}",/ ';
  let out = "";
  for (let block = 0; out.length < bytes; block++) {
    const hash = createHash("sha256").update(`g-ax:${round}:${block}`).digest();
    for (const byte of hash) out += alphabet[byte % alphabet.length];
  }
  return out.slice(0, bytes);
}

export function createAxDriver(options: AxDriverOptions): AxDriver {
  const attempts = options.attempts ?? 50;
  const interval = options.intervalMs ?? 200;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const transfer = options.transfer ?? "paste";

  const dump = async (): Promise<AxNode[]> => JSON.parse(options.exec(["dump"]) || "[]") as AxNode[];

  // Only "control not found" (exit 3, nothing issued) is retried. A refused or uncertain action fails now.
  async function retrying<T>(action: () => T): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return action();
      } catch (error) {
        if (!missingControl(error) || attempt >= attempts - 1) throw error;
        await sleep(interval);
      }
    }
  }

  async function waitFor(what: string, predicate: (nodes: AxNode[]) => boolean | Promise<boolean>, tries = attempts) {
    let nodes: AxNode[] = [];
    for (let attempt = 0; attempt < tries; attempt++) {
      nodes = await dump();
      if (await predicate(nodes)) return nodes;
      await sleep(interval);
    }
    throw new Error(`Visible state did not appear: ${what}`);
  }

  const field = (nodes: AxNode[], label: string) =>
    nodes.find((node) => FIELD_ROLES.includes(node.role) && named(node, label));

  async function put(label: string, value: string) {
    await retrying(() => options.exec([transfer, label], value));
    await waitFor(`${label} holds the transferred text`, (nodes) => field(nodes, label)?.value === value);
  }

  async function read(label: string) {
    const found = field(await dump(), label);
    if (!found) throw new Error(`Visible state did not appear: ${label}`);
    return found.value;
  }

  return {
    transfer,
    dump,
    waitFor,
    async press(label) {
      await retrying(() => options.exec(["press", label]));
    },
    put,
    read,
    async readWhenPresent(label, tries = attempts) {
      const nodes = await waitFor(`${label} is filled`, (all) => (field(all, label)?.value ?? "") !== "", tries);
      return field(nodes, label)!.value;
    },
    async isEnabled(label) {
      const found = (await dump()).find((node) => node.role === "AXButton" && named(node, label));
      if (!found) throw new Error(`Visible state did not appear: ${label}`);
      return found.enabled === "true";
    },
    async textVisible(text) {
      return nodesInclude(await dump(), text);
    },
    async transferPreflight(label, rounds = 20, bytes = 8192) {
      for (let round = 1; round <= rounds; round++) {
        const artifact = preflightArtifact(round, bytes);
        const fail = (reason: string): never => {
          throw new Error(
            `G-AX transfer check failed: method=${transfer} round=${round}/${rounds} bytes=${bytes}: ${reason}`,
          );
        };
        try {
          await retrying(() => options.exec([transfer, label], artifact));
        } catch (error) {
          fail(`helper error: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
        }
        let back = "";
        // The webview commits a paste asynchronously, so give the readback the normal visible-state budget.
        for (let attempt = 0; attempt < attempts; attempt++) {
          back = field(await dump(), label)?.value ?? "";
          if (back === artifact) break;
          await sleep(interval);
        }
        if (back !== artifact) {
          let index = 0;
          while (index < back.length && index < artifact.length && back[index] === artifact[index]) index++;
          fail(`readback differs at index ${index} (read ${back.length} of ${artifact.length} characters)`);
        }
      }
    },
  };
}
