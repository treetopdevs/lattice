import { File, Paths } from "expo-file-system";

// Export to a file (M1b.7, 04 Group tab "Export writes a file"): the D-31 JSON text written to the app's
// document directory under lattice-client's suggested file name, replacing an earlier export of the same name.
// expo-file-system's SDK 58 File API (docs.expo.dev/versions/v58.0.0/sdk/filesystem). The caller then shares
// the file's URI, so iOS offers "Save to Files" for the file itself. Nothing here reads or changes held frames.

/** Writes `text` to `<document>/<fileName>` and returns the file's URI. Throws when the write fails. */
export async function writeExportFile(fileName: string, text: string): Promise<{ uri: string; size: number }> {
  const file = new File(Paths.document, fileName);
  file.create({ overwrite: true });
  await file.write(text);
  return { uri: file.uri, size: file.size };
}
