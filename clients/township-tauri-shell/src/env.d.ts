/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_TOWNSHIP_AUTOSYNC_ON_MOUNT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
