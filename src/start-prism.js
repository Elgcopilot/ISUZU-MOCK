/**
 * start-prism.js
 * Reads openapi.yaml, strips the global `security:` requirement (so Prism
 * serves mock data without requiring a real bearer token in local dev), writes
 * a temp spec, then spawns Prism on it.
 *
 * Usage:  node src/start-prism.js [--port 4000] [--host 0.0.0.0] [--cors]
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

// Parse CLI args forwarded to Prism
const extraArgs = process.argv.slice(2); // e.g. ['--port','4000','--cors']

// ── Load + patch spec ─────────────────────────────────────────────────────────
const jsYaml = require("js-yaml");

function resolveSpecPath() {
  const candidatePaths = [
    process.env.OPENAPI_SPEC_PATH,
    path.resolve(process.cwd(), "openapi.yaml"),
    path.resolve(__dirname, "../../racing-platform-app/openapi.yaml"),
  ].filter(Boolean);

  const resolved = candidatePaths.find((candidate) => fs.existsSync(candidate));
  if (!resolved) {
    console.error("[Prism] Could not find an OpenAPI spec.");
    console.error(
      "[Prism] Provide OPENAPI_SPEC_PATH or add openapi.yaml to the repository root.",
    );
    process.exit(1);
  }

  return resolved;
}

const specPath = resolveSpecPath();

const tmpFile = path.join(os.tmpdir(), "openapi.local.yaml");

function writePatchedSpec() {
  const spec = jsYaml.load(fs.readFileSync(specPath, "utf8"));
  delete spec.security;
  fs.writeFileSync(tmpFile, jsYaml.dump(spec, { lineWidth: -1 }), "utf8");
}

writePatchedSpec();

// ── Spawn Prism ───────────────────────────────────────────────────────────────
// Use 'node' directly to avoid Windows .cmd shim issues with spawn()
const prismEntry = path.resolve(
  __dirname,
  "../node_modules/@stoplight/prism-cli/dist/index.js",
);
const prismArgs = ["mock", tmpFile, ...extraArgs];

console.log(`[Prism] Using source spec ${specPath}`);
console.log(`[Prism] Serving ${tmpFile} (security stripped for local dev)`);
console.log(`[Prism] node ${prismEntry} ${prismArgs.join(" ")}\n`);

let child = spawnPrism();

function spawnPrism() {
  const proc = spawn(process.execPath, [prismEntry, ...prismArgs], {
    stdio: "inherit",
    shell: false,
  });
  proc.on("exit", (code) => {
    if (!restarting) process.exit(code ?? 0);
  });
  return proc;
}

// ── Watch openapi.yaml for changes and restart Prism ─────────────────────────
let restarting = false;
let debounceTimer = null;
fs.watch(specPath, () => {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    console.log("\n[Prism] openapi.yaml changed — restarting...");
    restarting = true;
    child.kill("SIGTERM");
    writePatchedSpec();
    restarting = false;
    child = spawnPrism();
    console.log("[Prism] Restarted with updated spec\n");
  }, 300);
});

process.on("SIGINT", () => {
  restarting = true;
  child.kill("SIGINT");
  process.exit(0);
});
process.on("SIGTERM", () => {
  restarting = true;
  child.kill("SIGTERM");
  process.exit(0);
});
