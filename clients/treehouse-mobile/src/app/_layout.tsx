import React from "react";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useColorScheme } from "react-native";
import { bootstrap } from "../composition";
import { SessionProvider } from "../ui/SessionProvider";
import { tabs, thread as threadCopy } from "../ui/strings";

// Root layout (M1a.7): one SessionProvider over a Stack holding the tabs and the pushed thread screen.

export default function RootLayout(): React.JSX.Element {
  const scheme = useColorScheme();
  return (
    <SessionProvider boot={bootstrap}>
      <StatusBar style={scheme === "dark" ? "light" : "dark"} />
      {/* iOS 26: with no header background set, the native stack uses the translucent Liquid Glass bar and lays
          the screen out under it. An explicit opaque header keeps the content below the bar. */}
      <Stack screenOptions={{ headerTransparent: false }}>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="thread/[replica]" options={{ title: threadCopy.screenTitle, headerBackTitle: tabs.threads }} />
      </Stack>
    </SessionProvider>
  );
}
