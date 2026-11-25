import {
  carrierOpsToSemanticOps,
  memberCapability,
  observeTreehouse,
  treehouseCommandDecoders,
} from "@treetopdevs/lattice-client";
import type { HeldProfile, RouteConnection } from "@treetopdevs/lattice-shell-kit/sync";

// The ThreadTimeline read model, M1a.1 cut (03): ordered messages and whether this key can post. Order,
// text and quarantine come from lattice-client's observation; the app never re-sorts or re-judges.
// The rest of the fields (standing, edits, first-seen, arrived-late) arrive in M1a.4.

/** Applies only to my own messages (03). */
export type Delivery = "saved" | "sending" | "on_relay";

export interface MessageView {
  id: string;
  /** The author's public key (base64). */
  author: string;
  text: string;
  mine: boolean;
  /** Null for other people's messages. */
  delivery: Delivery | null;
}

export interface ThreadTimeline {
  replica: string;
  title: string;
  archived: boolean;
  messages: MessageView[];
  canPost: boolean;
}

export interface ThreadTimelineInputs {
  replica: string;
  profile: HeldProfile | undefined;
  /** This device's public key, or null when custody holds none or is unavailable. */
  myKey: string | null;
  /** The thread route's link state, or null when no route is configured for it. */
  connection: RouteConnection | null;
}

export function projectThreadTimeline(inputs: ThreadTimelineInputs): ThreadTimeline {
  const frames = inputs.profile?.frames ?? [];
  const ops = carrierOpsToSemanticOps([...frames], {}, treehouseCommandDecoders("Treehouse.Thread"));
  const observed = observeTreehouse("Treehouse.Thread", ops);
  const outbox = new Set(inputs.profile?.outbox ?? []);
  const acked = new Set(inputs.profile?.acked ?? []);
  const live = inputs.connection === "live";
  const archived = observed.state.archived === true;

  const messages = observed.posts.map((post): MessageView => {
    const mine = inputs.myKey !== null && post.author === inputs.myKey;
    let delivery: Delivery | null = null;
    if (mine) {
      // A post of mine not in this phone's outbox was pulled, so the relay held it.
      if (acked.has(post.id) || !outbox.has(post.id)) delivery = "on_relay";
      else delivery = live ? "sending" : "saved";
    }
    return { id: post.id, author: post.author, text: String(post.text ?? ""), mine, delivery };
  });

  const canPost =
    inputs.myKey !== null &&
    !archived &&
    memberCapability(frames, inputs.myKey, inputs.replica, { product: "Treehouse.Thread", command: "post" }) !== null;

  return {
    replica: inputs.replica,
    title: String(observed.state.title ?? ""),
    archived,
    messages,
    canPost,
  };
}
