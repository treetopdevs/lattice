import React from "react";
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useColorScheme } from "react-native";
import { bootstrap } from "../composition";
import { SessionProvider } from "../ui/SessionProvider";
import { audit as auditCopy, tabs, thread as threadCopy, threadInfo as infoCopy } from "../ui/strings";
import { DARK, LIGHT } from "../ui/theme";

// Root layout (M1a.7): one SessionProvider over a Stack holding the tabs and the pushed thread screen; M1b.6
// adds Thread info, pushed from the thread screen's header; M1b.7 adds Verify & audit, pushed from the Group tab.

// M1b.1: the navigation theme follows the system scheme with the app palette, so headers and the tab bar are
// dark in dark mode (they stayed light before).
const navTheme = (dark: boolean) => {
  const base = dark ? DarkTheme : DefaultTheme;
  const p = dark ? DARK : LIGHT;
  return { ...base, colors: { ...base.colors, primary: p.accent, background: p.bg, card: p.surface, text: p.text, border: p.border } };
};

export default function RootLayout(): React.JSX.Element {
  const scheme = useColorScheme();
  return (
    <ThemeProvider value={navTheme(scheme === "dark")}>
      <SessionProvider boot={bootstrap}>
        <StatusBar style={scheme === "dark" ? "light" : "dark"} />
        {/* iOS 26: with no header background set, the native stack uses the translucent Liquid Glass bar and lays
            the screen out under it. An explicit opaque header keeps the content below the bar. */}
        <Stack screenOptions={{ headerTransparent: false }}>
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="thread/[replica]" options={{ title: threadCopy.screenTitle, headerBackTitle: tabs.threads }} />
          <Stack.Screen name="thread-info/[replica]" options={{ title: infoCopy.screenTitle, headerBackTitle: threadCopy.screenTitle }} />
          <Stack.Screen name="audit" options={{ title: auditCopy.screenTitle, headerBackTitle: tabs.group }} />
        </Stack>
      </SessionProvider>
    </ThemeProvider>
  );
}
