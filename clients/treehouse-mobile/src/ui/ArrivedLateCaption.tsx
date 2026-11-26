import React from "react";
import { StyleSheet, Text } from "react-native";
import { message as messageCopy } from "./strings";
import type { Palette } from "./theme";

// "Arrived later" (04 Thread screen, M1b.4): a small caption on a message that this phone first held after it
// had shown messages that sort below it. Words, not colour alone; the accent only draws the eye. The bubble's
// own label carries the words to the screen reader, so this text is hidden from it. No fixed height, so
// dynamic type grows it.

export function ArrivedLateCaption({ colors: c }: { colors: Palette }): React.JSX.Element {
  return (
    <Text
      testID="arrived-late"
      style={[styles.caption, { color: c.accent }]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {`↑ ${messageCopy.arrivedLate}`}
    </Text>
  );
}

const styles = StyleSheet.create({
  caption: { fontSize: 12, fontWeight: "600" },
});
