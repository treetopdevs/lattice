import React, { memo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { DeliveryMark } from "./DeliveryMark";
import { notCountedLine } from "./refusal_view";
import { actions, message as messageCopy } from "./strings";
import type { Palette } from "./theme";
import type { TimelineItem } from "./thread_view";

// My message the judge does not count (04 Thread screen, M1b.5): a greyed bubble (muted text on the page
// colour with a dashed edge, so contrast holds in both themes), the reason line, and "Copy text" so it can be
// posted again. The bubble is one screen-reader element whose label says the reason; Copy text is both a
// button beside it and a named action on it, so VoiceOver reaches it either way. A long-press opens the sheet,
// which offers Copy only.

type MessageItem = Extract<TimelineItem, { kind: "message" }>;

interface Props {
  item: MessageItem;
  colors: Palette;
  onCopy(text: string): void;
  onOpenSheet?: (id: string) => void;
}

export const NotCountedBubble = memo(function NotCountedBubble({ item, colors: c, onCopy, onOpenSheet }: Props): React.JSX.Element {
  const m = item.message;
  const reason = notCountedLine(m) ?? "";
  const copy = () => onCopy(m.text);
  const accessibilityActions = [
    { name: "copyText", label: messageCopy.copyText },
    // As on Bubble: double-tap on iOS (VoiceOver has no long-press action), long-press on Android.
    ...(onOpenSheet ? [{ name: "activate", label: actions.openSheet }, { name: "longpress", label: actions.openSheet }] : []),
  ];
  return (
    <View style={[styles.wrap, item.showAuthor ? styles.runStart : null]}>
      {item.showAuthor ? <Text style={[styles.author, { color: c.muted }]}>{item.authorName}</Text> : null}
      <Pressable
        testID={`not-counted-${m.id}`}
        accessible
        accessibilityLabel={item.accessibilityLabel}
        accessibilityActions={accessibilityActions}
        onAccessibilityAction={(e) => (e.nativeEvent.actionName === "copyText" ? copy() : onOpenSheet?.(m.id))}
        onLongPress={onOpenSheet ? () => onOpenSheet(m.id) : undefined}
        style={[styles.bubble, { backgroundColor: c.bg, borderColor: c.muted }]}
      >
        <Text style={[styles.text, { color: c.muted }]}>{m.text}</Text>
        <Text style={[styles.caption, { color: c.muted }]}>{messageCopy.notCounted}</Text>
        <Text style={[styles.reason, { color: c.text }]}>{reason}</Text>
      </Pressable>
      <Pressable
        testID={`copy-text-${m.id}`}
        accessibilityRole="button"
        accessibilityLabel={messageCopy.copyText}
        accessibilityHint={messageCopy.copyTextHint}
        onPress={copy}
        hitSlop={8}
        style={({ pressed }) => [styles.copy, { opacity: pressed ? 0.6 : 1 }]}
      >
        <Text style={[styles.copyText, { color: c.accent }]}>{messageCopy.copyText}</Text>
      </Pressable>
      {m.delivery ? <DeliveryMark delivery={m.delivery} colors={c} /> : null}
    </View>
  );
});

const styles = StyleSheet.create({
  wrap: { maxWidth: "85%", marginTop: 2, alignSelf: "flex-end", alignItems: "flex-end" },
  runStart: { marginTop: 10 },
  author: { fontSize: 13, fontWeight: "600", marginBottom: 2, marginHorizontal: 4 },
  bubble: { borderWidth: 1, borderStyle: "dashed", borderRadius: 14, paddingHorizontal: 12, paddingVertical: 8, gap: 2 },
  text: { fontSize: 16 },
  caption: { fontSize: 12, fontWeight: "600" },
  reason: { fontSize: 13 },
  copy: { minHeight: 44, justifyContent: "center", paddingHorizontal: 4 },
  copyText: { fontSize: 15, fontWeight: "600" },
});
