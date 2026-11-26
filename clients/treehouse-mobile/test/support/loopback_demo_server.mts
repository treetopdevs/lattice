import { startLoopbackDemo } from "./loopback_demo";

// Runs the loopback demo server until stdin closes or SIGINT/SIGTERM. Prints the origin and the relay ids it
// can be asked for; never a seed. Usage, from clients/treehouse-mobile (BEAM built once with
// `MIX_ENV=test ~/.asdf/shims/mix compile` at the repo root):
//
//   node_modules/.bin/tsx --preserve-symlinks test/support/loopback_demo_server.mts [port]
//
// then start Metro with EXPO_PUBLIC_TREEHOUSE_DEMO_ORIGIN=<origin> and --clear. Keep this one process alive
// across app relaunches: its relay logs and demo keys exist only for its lifetime.

const port = Number(process.argv[2] ?? 4100);
const demo = await startLoopbackDemo({ port });
console.log(`LOOPBACK_DEMO_ORIGIN=${demo.origin}`);
console.log(`relay ids: ${demo.origin}/relay-ids/space ${demo.origin}/relay-ids/thread`);
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await demo.stop().catch(() => undefined);
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
