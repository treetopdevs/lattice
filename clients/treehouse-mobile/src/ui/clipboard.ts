import * as Clipboard from "expo-clipboard";
import { AccessibilityInfo } from "react-native";
import { message as messageCopy } from "./strings";

// M1b.5: Copy (message sheet) and Copy text (not-counted bubble). Text only, through expo-clipboard (SDK 58
// docs: setStringAsync resolves true on iOS and Android); the screen reader then hears "Copied". Never loaded
// by Core tests, which import only the pure ui modules.

export async function copyText(text: string): Promise<void> {
  await Clipboard.setStringAsync(text);
  AccessibilityInfo.announceForAccessibility(messageCopy.copied);
}
