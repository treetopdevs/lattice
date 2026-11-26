import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text } from "react-native";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { useHeaderHeight } from "expo-router/react-navigation";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ArchivedBanner } from "../../ui/ArchivedBanner";
import { CannotPostBar } from "../../ui/CannotPostBar";
import { copyText } from "../../ui/clipboard";
import { Composer } from "../../ui/Composer";
import { MessageList } from "../../ui/MessageList";
import { MessageSheet } from "../../ui/MessageSheet";
import { sheetFor, sheetItems } from "../../ui/message_sheet";
import { createOpenMarks } from "../../ui/thread_view";
import type { ConfirmedItem } from "../../ui/message_sheet";
import { threadFooter } from "../../ui/refusal_view";
import type { MessageLineage, MessageView } from "../../session/projections/thread_timeline";
import { SessionBanner } from "../../ui/SessionBanner";
import { useSession } from "../../ui/SessionProvider";
import { message as messageCopy, refusalCopy, thread as threadCopy, threadInfo as infoCopy } from "../../ui/strings";
import { usePalette } from "../../ui/theme";
import { useReadModel } from "../../ui/useReadModel";

// Thread screen (04, M1b.2): the ThreadTimeline as a bottom-anchored list of bubbles with my delivery marks,
// and a composer whose draft is saved on every pause. The keyboard offset is the stack header's real height.
// M1b.3: a long-press opens the message sheet (Edit, Delete, Remove as moderator, as the Abilities read model
// allows); Edit puts the composer in edit mode and Delete and Remove confirm first. M1b.4: an unread divider
// above the first unread id on open and an "Arrived later" caption, both held for as long as the screen is
// open. M1b.5: when this key cannot post, the CannotPostBar replaces the composer with the judge's reason
// and who can fix it; a not-counted message of mine shows its reason and Copy text; the sheet offers Copy for
// every message with text. M1b.6: an archived thread shows the ArchivedBanner in place of the composer, for the
// moderator too; the header's Info button opens Thread info (counts, size, Archive for the moderator).

export default function ThreadScreen(): React.JSX.Element {
  const c = usePalette();
  const headerHeight = useHeaderHeight();
  // The bar pads itself above the home indicator. KeyboardAvoidingView adds its offset to the keyboard overlap
  // it measures from this view's top (below the header), so the offset is the header height less that inset:
  // with the keyboard up, the bar then sits flush on the keyboard instead of an inset above it.
  const bottomInset = useSafeAreaInsets().bottom;
  const { replica: param } = useLocalSearchParams<{ replica: string }>();
  const replica = typeof param === "string" ? param : "";
  const { session, displayName, setError } = useSession();
  const timeline = useReadModel((m) => m.timelines[replica] ?? null, [replica]);
  const stored = useReadModel((m) => m.drafts[replica]?.text ?? null, [replica]);
  const members = useReadModel((m) => m.roster.members, []);
  const abilities = useReadModel((m) => m.abilities.replicas[replica], [replica]) ?? undefined;
  // Null before the session opens; only "removed" changes the line.
  const phase = useReadModel((m) => m.status.phase, []) ?? "member";

  // The sheet holds a message id and is re-read from the current timeline, so it closes when the message is
  // deleted elsewhere or the thread is archived while it is open. The same goes for an edit in progress.
  const [sheetId, setSheetId] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; ref: MessageLineage; text: string } | null>(null);
  const sheet = useMemo(() => (sheetId ? sheetFor(timeline, abilities, sheetId) : null), [timeline, abilities, sheetId]);
  useEffect(() => {
    if (sheetId && !sheet) setSheetId(null);
  }, [sheetId, sheet]);
  const editable = useMemo(() => {
    const now = editing ? sheetFor(timeline, abilities, editing.id) : null;
    return now?.items.includes("edit") ? now.message : null;
  }, [timeline, abilities, editing]);
  useEffect(() => {
    if (editing && !editable) setEditing(null);
  }, [editing, editable]);
  const canOpenSheet = useCallback((m: MessageView) => sheetItems(m, abilities).length > 0, [abilities]);

  // M1b.4: the divider and the arrived-later ids are taken during render, from the timeline as it was before
  // the read marker below is written (after commit), and held while the screen is open.
  const openMarks = useRef(createOpenMarks()).current;
  const marks = openMarks.take(timeline);

  // M1b.1: what this screen shows is marked as shown (03 read marker), so the Threads tab's unread count
  // clears on open and stays clear for messages that arrive while it is open. M1b.4: my own messages are
  // marked too (the timeline's `unmarked`), so a post that arrives later above them is captioned.
  // Known gap (review): this marks the whole counted timeline, including rows the list never put on screen.
  // Marking only viewable rows was tried and withdrawn: the positional "Arrived later" rule then captions
  // older backlog rows that were simply not yet scrolled to. It needs an arrival-based rule first (PROGRESS).
  const unmarked = timeline?.unmarked ?? [];
  const unmarkedKey = unmarked.join(",");
  useEffect(() => {
    if (session && unmarked.length > 0) void session.markRead(replica, unmarked);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, replica, unmarkedKey]);

  // Names come from this phone's petnames on the roster; a key with none shows its key check.
  const nameOf = useCallback(
    (pubkey: string) => displayName(pubkey, members?.find((m) => m.pubkey === pubkey)?.petname ?? null),
    [displayName, members],
  );

  const saveDraft = useCallback(
    async (text: string | null) => {
      if (!session) return false;
      return (await session.saveDraft(replica, text === null ? null : { text })).ok;
    },
    [session, replica],
  );
  const post = useCallback(
    async (text: string) => {
      if (!session) return false;
      setError(null);
      const outcome = await session.postMessage(replica, text);
      if (!outcome.ok) setError(refusalCopy[outcome.reason]);
      return outcome.ok;
    },
    [session, replica, setError],
  );

  const saveEdit = useCallback(
    async (_ref: MessageLineage, text: string) => {
      if (!session || !editable) return false;
      setError(null);
      // The current lineage, not the one captured when the edit began; the command re-reads its target too.
      const outcome = await session.editMessage(replica, editable.ref, text);
      if (!outcome.ok) setError(refusalCopy[outcome.reason]);
      return outcome.ok;
    },
    [session, replica, editable, setError],
  );
  const confirmed = useCallback(
    async (item: ConfirmedItem, message: MessageView) => {
      if (!session) return;
      setError(null);
      const outcome =
        item === "delete" ? await session.deleteMessage(replica, message.ref) : await session.removeMessage(replica, message.ref);
      if (!outcome.ok) setError(refusalCopy[outcome.reason]);
    },
    [session, replica, setError],
  );

  const copy = useCallback((text: string) => void copyText(text).catch(() => setError(messageCopy.copyFailed)), [setError]);
  const footer = timeline ? threadFooter({ timeline, phase }) : null;
  const openInfo = useCallback(() => router.push({ pathname: "/thread-info/[replica]", params: { replica } }), [replica]);
  const headerRight = useCallback(
    () =>
      timeline ? (
        <Pressable
          testID="thread-info-button"
          accessibilityRole="button"
          accessibilityLabel={infoCopy.openLabel}
          accessibilityHint={infoCopy.openHint}
          hitSlop={8}
          onPress={openInfo}
        >
          {/* Capped like the system's own bar buttons: at accessibility sizes an uncapped label crowds the title
              out of the header (seen on the simulator); the button's accessibility label is the full name. */}
          <Text maxFontSizeMultiplier={1.5} style={{ color: c.accent, fontSize: 17 }}>
            {infoCopy.open}
          </Text>
        </Pressable>
      ) : null,
    [timeline, openInfo, c.accent],
  );

  return (
    <KeyboardAvoidingView
      style={[styles.root, { backgroundColor: c.bg }]}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={headerHeight - bottomInset}
    >
      <Stack.Screen options={{ title: timeline ? `# ${timeline.title}` : threadCopy.screenTitle, headerRight }} />
      <SessionBanner />
      <MessageList timeline={timeline} nameOf={nameOf} colors={c} canOpenSheet={canOpenSheet} onOpenSheet={setSheetId} onCopy={copy} marks={marks} />
      {footer?.kind === "archived" ? (
        <ArchivedBanner bottomInset={bottomInset} colors={c} />
      ) : timeline && (timeline.canPost || editing) ? (
        <Composer
          key={replica}
          bottomInset={bottomInset}
          stored={stored}
          canPost={timeline.canPost}
          colors={c}
          saveDraft={saveDraft}
          post={post}
          editing={editing}
          saveEdit={saveEdit}
          onEndEdit={() => setEditing(null)}
        />
      ) : (
        <CannotPostBar line={footer?.kind === "cannot_post" ? footer.line : threadCopy.cannotPost} bottomInset={bottomInset} colors={c} />
      )}
      <MessageSheet
        open={sheet}
        colors={c}
        onClose={() => setSheetId(null)}
        onEdit={(m) => setEditing({ id: m.id, ref: m.ref, text: m.text })}
        onCopy={(m) => copy(m.text)}
        onConfirmed={confirmed}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});
