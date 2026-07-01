// C2 runner: load the pinned AtomVM node bundle (CommonJS) and point its
// emscripten loader at the pinned .wasm (the bundle otherwise hardcodes the
// generic "AtomVM.wasm" name). Usage: node run-node.cjs <app.avm>
const path = require("path");
const vendor = path.join(__dirname, "vendor");
const wasm = path.join(vendor, "AtomVM-node-v0.7.0-alpha.1.wasm");

globalThis.Module = {
  locateFile: (p) => (p.endsWith(".wasm") ? wasm : p),
  // emscripten reads process.argv.slice(2); the .avm arg is already there.
  printErr: (s) => console.error(s),
  print: (s) => console.log(s),
};

require(path.join(vendor, "AtomVM-node-v0.7.0-alpha.1.cjs"));
