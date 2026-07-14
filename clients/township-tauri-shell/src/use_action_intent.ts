import { ref, shallowRef, type Ref, type ShallowRef } from "vue";
import type { TownshipReviewableActionIntent } from "./township_action_intent";

export type ActionIntentStatus = { ok: boolean; message: string };
export type ActionIntentVersion = TownshipReviewableActionIntent["v"];
export type ActionIntentForVersion<Version extends ActionIntentVersion> = Extract<
  TownshipReviewableActionIntent,
  { v: Version }
>;
export type ActionIntentSlot = "post" | "status" | "field" | "roster" | "grant";
export type ActionIntentDevStep = "use" | "sign";
export type ActionIntentOutcome =
  | "accepted"
  | "blocked"
  | "busy"
  | "dismissed"
  | "failed"
  | "ignored"
  | "mismatch"
  | "missing"
  | "signed"
  | "wrong_version";

export interface ActionIntentSubmission {
  ok: boolean;
  message: string;
}

export interface UseActionIntentOptions<Version extends ActionIntentVersion> {
  version: Version;
  currentReplica: () => string | null | undefined;
  submit: (intent: ActionIntentForVersion<Version>) => Promise<ActionIntentSubmission>;
  acceptMessage: (intent: ActionIntentForVersion<Version>) => string;
  dismissFallback: string;
  allowed?: (intent: ActionIntentForVersion<Version>) => boolean;
  busy?: () => boolean;
  successMessage?: (intent: ActionIntentForVersion<Version>) => string | null;
  onAccept?: (intent: ActionIntentForVersion<Version>) => void;
  onStatus?: (status: ActionIntentStatus | null) => void;
}

export interface ActionIntentController<Version extends ActionIntentVersion> {
  accepted: ShallowRef<ActionIntentForVersion<Version> | null>;
  status: ShallowRef<ActionIntentStatus | null>;
  submitting: Ref<boolean>;
  submittingIntent: ShallowRef<ActionIntentForVersion<Version> | null>;
  accept: (intent: TownshipReviewableActionIntent, event?: Event) => ActionIntentOutcome;
  sign: (event?: Event) => Promise<ActionIntentOutcome>;
  dismiss: (event?: Event) => ActionIntentOutcome;
  clear: () => void;
}

export const ACTION_INTENT_SLOT_VERSIONS = [
  { slot: "post", version: 1 },
  { slot: "status", version: 2 },
  { slot: "field", version: 3 },
  { slot: "roster", version: 4 },
  { slot: "grant", version: 5 },
] as const satisfies ReadonlyArray<{ slot: ActionIntentSlot; version: ActionIntentVersion }>;

type ActionIntentDescriptorIdentity = (typeof ACTION_INTENT_SLOT_VERSIONS)[number];
type ActionIntentSlotForVersion<Version extends ActionIntentVersion> = Extract<
  ActionIntentDescriptorIdentity, { version: Version }
>["slot"];

export interface DefineActionIntentRuntimeOptions<Version extends ActionIntentVersion>
  extends UseActionIntentOptions<Version> {
  slot: ActionIntentSlotForVersion<Version>;
  reviewOrder?: number;
  signing?: (
    intent: ActionIntentForVersion<Version>,
    submittingIntent: ActionIntentForVersion<Version> | null,
  ) => boolean;
}

export function useActionIntent<Version extends ActionIntentVersion>(
  options: UseActionIntentOptions<Version>,
): ActionIntentController<Version> {
  const accepted = shallowRef(null) as ShallowRef<ActionIntentForVersion<Version> | null>;
  const status = shallowRef<ActionIntentStatus | null>(null);
  const submitting = ref(false);
  const submittingIntent = shallowRef(null) as ShallowRef<ActionIntentForVersion<Version> | null>;

  function updateStatus(nextStatus: ActionIntentStatus | null) {
    status.value = nextStatus;
    options.onStatus?.(nextStatus);
  }

  function accept(intent: TownshipReviewableActionIntent, event?: Event): ActionIntentOutcome {
    if (!trustedActionEvent(event)) return "ignored";
    if (intent.v !== options.version) return "wrong_version";

    const matchingIntent = intent as ActionIntentForVersion<Version>;
    if (options.currentReplica() !== matchingIntent.replica) {
      updateStatus({
        ok: false,
        message: `${actionIntentLabel(matchingIntent)} no longer matches the saved Township pairing.`,
      });
      return "mismatch";
    }

    accepted.value = matchingIntent;
    options.onAccept?.(matchingIntent);
    updateStatus({ ok: true, message: options.acceptMessage(matchingIntent) });
    return "accepted";
  }

  async function sign(event?: Event): Promise<ActionIntentOutcome> {
    if (!trustedActionEvent(event)) return "ignored";
    if (submitting.value || options.busy?.()) return "busy";

    const intent = accepted.value;
    if (!intent) return "missing";
    if (options.currentReplica() !== intent.replica) {
      updateStatus({
        ok: false,
        message: `${actionIntentLabel(intent)} no longer matches the saved Township pairing.`,
      });
      return "mismatch";
    }
    if (options.allowed && !options.allowed(intent)) return "blocked";

    submitting.value = true;
    submittingIntent.value = intent;
    try {
      const submission = await options.submit(intent);
      if (!submission.ok) {
        updateStatus({ ok: false, message: submission.message });
        return "failed";
      }

      accepted.value = null;
      const successMessage = options.successMessage?.(intent) ?? null;
      updateStatus(successMessage ? { ok: true, message: successMessage } : null);
      return "signed";
    } finally {
      submittingIntent.value = null;
      submitting.value = false;
    }
  }

  function dismiss(event?: Event): ActionIntentOutcome {
    if (!trustedActionEvent(event)) return "ignored";

    const intent = accepted.value;
    accepted.value = null;
    updateStatus({
      ok: true,
      message: `${intent ? actionIntentLabel(intent) : options.dismissFallback} dismissed.`,
    });
    return "dismissed";
  }

  function clear() {
    accepted.value = null;
    updateStatus(null);
  }

  return { accepted, status, submitting, submittingIntent, accept, sign, dismiss, clear };
}

export function defineActionIntentRuntime<Version extends ActionIntentVersion>(
  options: DefineActionIntentRuntimeOptions<Version>,
) {
  const controller = useActionIntent(options);

  function matchingIntent(intent: TownshipReviewableActionIntent): ActionIntentForVersion<Version> | null {
    return intent.v === options.version ? (intent as ActionIntentForVersion<Version>) : null;
  }

  return {
    slot: options.slot,
    version: options.version,
    reviewOrder: options.reviewOrder ?? null,
    submitting: controller.submitting,
    accepted: () => controller.accepted.value,
    status: () => controller.status.value,
    accept: (intent: TownshipReviewableActionIntent, event?: Event) => controller.accept(intent, event),
    sign: (event?: Event) => controller.sign(event),
    dismiss: (event?: Event) => controller.dismiss(event),
    clear: () => controller.clear(),
    busy: () => controller.submitting.value || (options.busy?.() ?? false),
    signing: (intent: TownshipReviewableActionIntent) => {
      const matching = matchingIntent(intent);
      if (!matching) return false;
      return options.signing?.(matching, controller.submittingIntent.value) ?? controller.submitting.value;
    },
    allowed: (intent: TownshipReviewableActionIntent) => {
      const matching = matchingIntent(intent);
      return matching !== null && (options.allowed?.(matching) ?? true);
    },
  };
}

export function actionIntentLabel(intent: TownshipReviewableActionIntent): string {
  if (intent.v === 1) return "Post request";
  if (intent.v === 2) {
    return intent.command.command === "close_matter" ? "Close matter request" : "Reopen matter request";
  }
  if (intent.v === 3) {
    return intent.command.command === "set_title" ? "Title edit request" : "Summary edit request";
  }
  if (intent.v === 4) {
    return intent.command.command === "admit" ? "Admit member request" : "Remove member request";
  }
  if (intent.v === 5) return "Grant access request";
  return assertNeverActionIntent(intent);
}

export function parseActionIntentDevRoute(
  route: string,
): { slot: ActionIntentSlot; version: ActionIntentVersion; step: ActionIntentDevStep } | null {
  for (const descriptor of ACTION_INTENT_SLOT_VERSIONS) {
    for (const step of ["use", "sign"] as const) {
      if (route === `action-${descriptor.slot}/${step}`) return { ...descriptor, step };
    }
  }
  return null;
}

export function actionIntentDevTraceEvent(slot: ActionIntentSlot, step: string, outcome: string): string {
  return `action-${slot}-dev-${step}:${outcome}`;
}

function trustedActionEvent(event?: Event): boolean {
  return !event || event.isTrusted;
}

function assertNeverActionIntent(_intent: never): never {
  throw new Error("Unsupported staged action intent.");
}
