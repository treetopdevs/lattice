import { createApp } from "vue";
import App from "./App.vue";
import "./style.css";

// Plan 185: the judge-spike build (VITE_TREEHOUSE_JUDGE_SPIKE=1) opens the Popcorn vector judge
// instead of the app. Vite replaces the flag at build time, so the ordinary build drops this branch.
if (import.meta.env.VITE_TREEHOUSE_JUDGE_SPIKE === "1") {
  void import("./judge_spike").then(({ openJudgeSpike }) => openJudgeSpike());
} else {
  createApp(App).mount("#app");
}
