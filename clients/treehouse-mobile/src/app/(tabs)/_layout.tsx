import React from "react";
import { Tabs } from "expo-router";
import { tabs } from "../../ui/strings";
import { usePalette } from "../../ui/theme";

// The three tabs (04): Threads, People, Group.

export default function TabLayout(): React.JSX.Element {
  const c = usePalette();
  return (
    <Tabs screenOptions={{ tabBarActiveTintColor: c.accent, tabBarIcon: () => null }}>
      {/* M1b.1: the Threads tab draws its own header (Group name and the pill, 04), which grows with dynamic type. */}
      <Tabs.Screen name="threads" options={{ title: tabs.threads, headerShown: false }} />
      <Tabs.Screen name="people" options={{ title: tabs.people }} />
      <Tabs.Screen name="group" options={{ title: tabs.group }} />
    </Tabs>
  );
}
