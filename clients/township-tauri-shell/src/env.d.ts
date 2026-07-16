/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_TOWNSHIP_AUTOSYNC_ON_MOUNT?: string;
  readonly VITE_TOWNSHIP_PACKAGED_ONBOARDING_HANDOFF?: string;
  readonly VITE_TOWNSHIP_PACKAGED_ONBOARDING_LOCAL_REALM?: string;
  readonly VITE_TOWNSHIP_PACKAGED_ONBOARDING_POST_TEXT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
