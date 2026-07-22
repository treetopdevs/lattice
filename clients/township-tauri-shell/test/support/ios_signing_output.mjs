export function redactIosSigningOutput(
  output,
  { developmentTeam = "", deviceUdid = "", home = "" } = {},
) {
  let redacted = output;
  if (deviceUdid) {
    redacted = redacted.replaceAll(deviceUdid, "<physical-device>");
  }
  if (developmentTeam) {
    redacted = redacted.replaceAll(developmentTeam, "<apple-team>");
  }
  if (home) redacted = redacted.replaceAll(home, "~");
  return redacted
    .replace(
      /\b[A-Z0-9._+-]+%40[A-Z0-9.-]+(?:\.[A-Z]{2,})?\b/gi,
      "<apple-account>",
    )
    .replace(
      /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
      "<apple-account>",
    )
    .replace(
      /(?:\/private)?\/var\/folders\/[^\s"'`)\]}]+/g,
      (path) => {
        const locator = path.match(
          /\/(township-ios-(?:device-build|provision-log)-)([A-Za-z0-9_-]+)(\/(?:archive|xcodebuild)\.log)$/,
        );
        return locator
          ? `$TMPDIR/${locator[1]}${locator[2]}${locator[3]}`
          : "<private-temp>";
      },
    )
    .replace(
      /(<key>\s*TeamName\s*<\/key>\s*<string\b[^>]*>)[\s\S]*?(<\/string>)/gi,
      "$1<redacted>$2",
    )
    .replace(/("TeamName"\s*=>\s*")[^"\r\n]*(")/g, "$1<redacted>$2")
    .replace(/("TeamName"\s*:\s*")[^"\r\n]*(")/g, "$1<redacted>$2")
    .replace(
      /(<data\b[^>]*>)[\s\S]*?(<\/data>)/gi,
      "$1<redacted>$2",
    )
    .replace(/(^|[,/\s])O=[^,/\r\n<]+/gm, "$1O=<redacted>")
    .replace(
      /\b(?:Apple Development|Apple Distribution|iPhone Developer|Developer ID(?: Application| Installer)?):[^\r\n"]+/g,
      "Apple signing identity: <redacted>",
    )
    .replace(
      /\b(signing (?:certificate|identity))\s*[:=][^\r\n]+/gi,
      "$1: <redacted>",
    )
    .replace(
      /\b(provisioning profile(?: name)?)\s*[:=][^\r\n]+/gi,
      "$1: <redacted>",
    )
    .replace(
      /\b(provisioning profile(?: name)?)\s+(["'])[^\r\n"']+\2/gi,
      '$1 "<redacted>"',
    )
    .replace(/\b[0-9A-F]{8}-[0-9A-F]{16}\b/gi, "<physical-device>")
    .replace(/\b[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}\b/gi, "<uuid>")
    .replace(/\b[0-9A-F]{40}\b/gi, "<certificate>")
    .replace(/\b[A-Z0-9]{10}\b/g, "<apple-team>");
}
