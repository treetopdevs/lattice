import React from "react";
import { StyleSheet, Text } from "react-native";
import type { Delivery } from "../session/projections/thread_timeline";
import type { Palette } from "./theme";
import { deliveryMark } from "./thread_view";

// My message's delivery mark (04, M1b.2): a glyph and its words. The words are always shown, so colour and
// glyph only repeat them; the bubble's own label carries them to the screen reader.

export function DeliveryMark({ delivery, colors: c }: { delivery: Delivery; colors: Palette }): React.JSX.Element {
  const mark = deliveryMark[delivery];
  const color = mark.tone === "error" ? c.error : mark.tone === "warn" ? c.warn : c.muted;
  return (
    <Text
      testID={`delivery-${delivery}`}
      style={[styles.mark, { color }]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {`${mark.glyph} ${mark.label}`}
    </Text>
  );
}

const styles = StyleSheet.create({
  mark: { fontSize: 12, marginTop: 2 },
});
