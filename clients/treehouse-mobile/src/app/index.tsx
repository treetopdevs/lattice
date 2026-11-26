import React from "react";
import { Redirect } from "expo-router";

// `/` opens the Threads tab (the tabs are named routes, so there is no tabs index).
export default function Index(): React.JSX.Element {
  return <Redirect href="/threads" />;
}
