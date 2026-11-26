import { buildSpaceFramesExport, suggestExportFileName, verifyCarrierOp } from "@treetopdevs/lattice-client";
import { ok, refuse } from "../outcomes";
import type { ExportRefusal, Outcome } from "../outcomes";
import type { ReplicaStore } from "../ports";
import { committedRootAuthor, strictOpVerifier } from "../verify_held";

// Export (04, Group tab and Problem screens): the held Space frames in the D-31 shape
// (lattice-space-frames-export-v1), built by lattice-client exactly as the Tauri shell builds it. It reads the
// store directly, not the read models, because it is the recovery offer for history_invalid and
// identity_mismatch, where every replica-derived model is empty. Only the Space is exported: Thread frames and
// this phone's unsent outbox are not part of the D-31 shape. Nothing is signed or written.

export interface SpaceExport {
  fileName: string;
  text: string;
}

export async function exportSpaceFrames(store: ReplicaStore): Promise<Outcome<SpaceExport, ExportRefusal>> {
  const space = store.replicas().find((r) => r.product === "Treehouse.Space");
  const frames = space ? (store.profile(space.replica)?.frames ?? []) : [];
  if (!space || frames.length === 0) return refuse("no_space");
  try {
    // Inside the try: a malformed retained frame (a genesis without deps) is export_failed, not a throw.
    const root = await committedRootAuthor(space.replica, frames);
    if (root === null) return refuse("export_failed");
    const text = await buildSpaceFramesExport({
      space: space.replica,
      rootPublicKey: root,
      frames,
      verify: async (frame) => (await verifyCarrierOp(frame, strictOpVerifier)).valid,
    });
    return ok({ fileName: suggestExportFileName(space.replica), text });
  } catch {
    // A Space frame that fails its own check, or a Space past the export limits: nothing partial is offered.
    return refuse("export_failed");
  }
}
