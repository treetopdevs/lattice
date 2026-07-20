const developerRootMarker = ".app/Contents/Developer";

export function classifyDeveloperToolchainReferences(
  contents,
  approvedDeveloperRoot,
) {
  if (!approvedDeveloperRoot.endsWith(developerRootMarker)) {
    throw new TypeError(
      "approved developer root must end in .app/Contents/Developer",
    );
  }

  const text =
    typeof contents === "string"
      ? contents
      : Buffer.from(contents).toString("latin1");
  const approvedReferenceCount = countOccurrences(text, approvedDeveloperRoot);
  const foreignReferenceCount = countOccurrences(
    text.replaceAll(approvedDeveloperRoot, ""),
    developerRootMarker,
  );

  return { approvedReferenceCount, foreignReferenceCount };
}

function countOccurrences(text, needle) {
  let count = 0;
  let offset = 0;
  while (offset < text.length) {
    const match = text.indexOf(needle, offset);
    if (match === -1) break;
    count += 1;
    offset = match + needle.length;
  }
  return count;
}
