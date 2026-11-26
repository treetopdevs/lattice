const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const projectRoot = __dirname;
const latticeClientRoot = path.resolve(projectRoot, "../lattice-client");
const latticeShellKitRoot = path.resolve(projectRoot, "../lattice-shell-kit");

const config = getDefaultConfig(projectRoot);

config.watchFolders = [latticeClientRoot, latticeShellKitRoot];
config.resolver.nodeModulesPaths = [path.resolve(projectRoot, "node_modules")];
config.resolver.unstable_enableSymlinks = true;
config.resolver.unstable_enablePackageExports = true;

module.exports = config;
