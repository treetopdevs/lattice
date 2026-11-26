import React, { memo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { ArrivedLateCaption } from "./ArrivedLateCaption";
import { DeliveryMark } from "./DeliveryMark";
import { actions, message as messageCopy, removedPlaceholder } from "./strings";
import type { Palette } from "./theme";
import type { TimelineItem } from "./thread_view";

// One message (04 Thread screen, M1b.2). Mine sit on the right with their delivery mark; the author's name
// heads a run of consecutive messages. Edited and arrived later are words, never colour alone. A message of
// mine the judge does not count is drawn by NotCountedBubble instead (M1b.5).
// M1b.4: arrived later is its own caption (ArrivedLateCaption) and comes from the item, which holds it for as
// long as the screen is open, not from the message, whose flag clears once the read marker is written.
// No fixed heights, so dynamic type grows the bubble instead of clipping it.
// M1b.3: when the sheet has items for this message, a long-press opens it; a screen reader gets the same as
// a named action (double-tap on iOS, where VoiceOver has no long-press action; long-press on Android).

type MessageItem = Extract<TimelineItem, { kind: "message" }>;

interface Props {
  item: MessageItem;
  colors: Palette;
  /** Set only when the long-press sheet has something for this message. */
  onOpenSheet?: (id: string) => void;
}

const SHEET_ACTIONS = [
  { name: "activate", label: actions.openSheet },
  { name: "longpress", label: actions.openSheet },
];

export const Bubble = memo(function Bubble({ item, colors: c, onOpenSheet }: Props): React.JSX.Element {
  const m = item.message;
  const captions: string[] = [];
  if (m.edited) captions.push(messageCopy.edited);
  return (
    <Pressable
      testID={`bubble-${m.id}`}
      accessible
      accessibilityLabel={item.accessibilityLabel}
      accessibilityHint={onOpenSheet ? actions.openSheetHint : undefined}
      accessibilityActions={onOpenSheet ? SHEET_ACTIONS : undefined}
      onAccessibilityAction={onOpenSheet ? () => onOpenSheet(m.id) : undefined}
      onLongPress={onOpenSheet ? () => onOpenSheet(m.id) : undefined}
      style={[styles.wrap, m.mine ? styles.mine : styles.theirs, item.showAuthor ? styles.runStart : null]}
    >
      {item.showAuthor ? <Text style={[styles.author, { color: c.muted }]}>{item.authorName}</Text> : null}
      <View
        style={[
          styles.bubble,
          { backgroundColor: m.mine ? c.surfaceAlt : c.surface, borderColor: c.border },
        ]}
      >
        {m.removed ? (
          <Text style={[styles.placeholder, { color: c.muted }]}>{removedPlaceholder[m.removed]}</Text>
        ) : (
          // Selectable only when a long-press does not open the sheet: on iOS both would fire, and the text
          // selection's Copy callout would float over the sheet. Since M1b.5 the sheet offers Copy for every
          // message with text, so in practice no bubble is selectable.
          <Text style={[styles.text, { color: c.text }]} selectable={!onOpenSheet}>
            {m.text}
          </Text>
        )}
        {item.arrivedLate ? <ArrivedLateCaption colors={c} /> : null}
        {captions.length > 0 ? <Text style={[styles.caption, { color: c.muted }]}>{captions.join(" · ")}</Text> : null}
      </View>
      {m.delivery ? <DeliveryMark delivery={m.delivery} colors={c} /> : null}
    </Pressable>
  );
});

const styles = StyleSheet.create({
  wrap: { maxWidth: "85%", marginTop: 2 },
  runStart: { marginTop: 10 },
  mine: { alignSelf: "flex-end", alignItems: "flex-end" },
  theirs: { alignSelf: "flex-start", alignItems: "flex-start" },
  author: { fontSize: 13, fontWeight: "600", marginBottom: 2, marginHorizontal: 4 },
  bubble: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 8, gap: 2 },
  text: { fontSize: 16 },
  placeholder: { fontSize: 15, fontStyle: "italic" },
  caption: { fontSize: 12 },
});
