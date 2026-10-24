import { invoke } from "@tauri-apps/api/core";
import type { PreviewNative } from "./treehouse_state";
import { fromBase64 } from "./treehouse_workflow";
export const native: PreviewNative = {
  open: () => invoke("treehouse_open"),
  initialize: () => invoke("treehouse_initialize_identity"),
  threadIdentity: (nonce) => invoke("treehouse_thread_identity", { nonce }),
  initializeThread: (nonce) => invoke("treehouse_initialize_thread", { nonce }),
  signThread: async (nonce, bytes) => fromBase64(await invoke<string>("treehouse_sign_thread", {
    nonce, bytes: btoa(String.fromCharCode(...bytes)),
  })),
  commit: (expectedRevision, next) =>
    invoke("treehouse_commit", { expectedRevision, next }),
  loadDraft: (replica) => invoke("treehouse_load_draft", { replica }),
  saveDraft: (replica, expectedRevision, text) =>
    invoke("treehouse_save_draft", { replica, expectedRevision, text }),
  sign: async (bytes) =>
    fromBase64(
      await invoke<string>("treehouse_sign_carrier", {
        bytes: btoa(String.fromCharCode(...bytes)),
      }),
    ),
  exportSpaceFrames: (fileName, contents) =>
    invoke("treehouse_export_space_frames", { fileName, contents }),
};
