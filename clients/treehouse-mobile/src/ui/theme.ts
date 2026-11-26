import { useColorScheme } from "react-native";

// The M0 palette, moved out of App.tsx (M1a.7). Real theming comes with the M1b screens.

export interface Palette {
  bg: string;
  surface: string;
  surfaceAlt: string;
  border: string;
  text: string;
  muted: string;
  accent: string;
  accentText: string;
  live: string;
  warn: string;
  error: string;
}

export const LIGHT: Palette = {
  bg: "#F6F7F5",
  surface: "#FFFFFF",
  surfaceAlt: "#EEF1ED",
  border: "#DCE2DA",
  text: "#182019",
  muted: "#5B685E",
  accent: "#236B43",
  accentText: "#FFFFFF",
  live: "#1E7F4B",
  warn: "#B4690E",
  error: "#B83232",
};

export const DARK: Palette = {
  bg: "#0F1411",
  surface: "#171E1A",
  surfaceAlt: "#202A24",
  border: "#2B3830",
  text: "#EFF4F0",
  muted: "#9BA99F",
  accent: "#3AA76D",
  accentText: "#09140E",
  live: "#3AA76D",
  warn: "#E2A23B",
  error: "#E06464",
};

export function usePalette(): Palette {
  return useColorScheme() === "dark" ? DARK : LIGHT;
}
