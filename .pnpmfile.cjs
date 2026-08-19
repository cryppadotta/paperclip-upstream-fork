const fs = require("node:fs");
const path = require("node:path");

function isPathInside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function isRunScratchPath(candidate) {
  const configuredScratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR;
  if (configuredScratch && isPathInside(candidate, path.resolve(configuredScratch))) return true;
  return path.resolve(candidate).split(path.sep).some((part) => part.startsWith("paperclip-run-"));
}

function readVirtualStoreDir(modulesYamlPath) {
  if (!fs.existsSync(modulesYamlPath)) return null;
  const match = fs.readFileSync(modulesYamlPath, "utf8").match(/^virtualStoreDir:\s*(.+?)\s*$/m);
  if (!match) return null;
  const value = match[1].trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function assertScratchInstallIsIsolated(workspaceRoot) {
  const lexicalRoot = path.resolve(workspaceRoot);
  if (!isRunScratchPath(lexicalRoot)) return;

  const nodeModulesPath = path.join(lexicalRoot, "node_modules");
  try {
    fs.lstatSync(nodeModulesPath);
  } catch (error) {
    if (error && error.code === "ENOENT") return;
    throw error;
  }

  const resolvedNodeModules = fs.realpathSync(nodeModulesPath);
  const reasons = [];
  if (!isPathInside(resolvedNodeModules, lexicalRoot)) {
    reasons.push(`node_modules resolves outside the scratch workspace (${resolvedNodeModules})`);
  }

  const modulesYamlPath = path.join(resolvedNodeModules, ".modules.yaml");
  if (fs.existsSync(modulesYamlPath)) {
    const modulesYamlStats = fs.statSync(modulesYamlPath);
    if (modulesYamlStats.nlink > 1) {
      reasons.push("node_modules/.modules.yaml is hard-linked to another checkout");
    }
    const virtualStoreDir = readVirtualStoreDir(modulesYamlPath);
    if (virtualStoreDir) {
      const resolvedVirtualStore = path.resolve(resolvedNodeModules, virtualStoreDir);
      if (!isPathInside(resolvedVirtualStore, lexicalRoot)) {
        reasons.push(`virtualStoreDir resolves outside the scratch workspace (${resolvedVirtualStore})`);
      }
    }
  }

  if (reasons.length === 0) return;
  throw new Error(
    `[paperclip] Refusing pnpm install in run scratch: ${reasons.join("; ")}. `
      + "Create the scratch copy without shared or hard-linked node_modules (for example, omit node_modules or copy with dereference), then retry.",
  );
}

assertScratchInstallIsIsolated(process.cwd());

module.exports = { hooks: {} };
