/**
 * One-file ESM bundle per app (spec 2026-08-27, D6).
 *
 * Both apps run under `tsx` today, which transpiles the whole workspace on every boot — in the
 * server once, and in the voice worker **once per job process**, because a job process imports the
 * agent module and everything under it before it can speak. Measured on this box: **2 659 ms** to
 * import `apps/voice-worker/src/agent.ts` under tsx, which is 95 % of the audit's 2 800 ms cold
 * start, and it is paid inside the call rather than at dispatch.
 *
 * Two rules decide what goes in the bundle:
 *
 * - **Workspace packages are inlined.** `@feather-lite/domain` and `@feather-lite/contracts`
 *   publish raw TypeScript (`exports.default: ./src/index.ts`), so Node cannot load them at all
 *   without a transpiling loader. Inlining them is what removes the loader from the runtime.
 * - **Everything from node_modules stays external.** Native addons (`@livekit/local-inference`,
 *   `@livekit/rtc-node`) cannot be bundled, `@livekit/agents` resolves job and
 *   inference entry points by URL at runtime, and Effect's module identity matters for its
 *   `Context.Tag`s. `--packages=external` would also externalise the workspace ones, so the split
 *   is done by a plugin instead.
 *
 * Usage: `node scripts/bundle.mjs <entry> <outfile>` (paths relative to the repo root).
 */
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [entry, outfile] = process.argv.slice(2);
if (!entry || !outfile) {
  console.error("usage: node scripts/bundle.mjs <entry> <outfile>");
  process.exit(1);
}

const root = fileURLToPath(new URL("..", import.meta.url));
/** Both paths are read as repo-relative, so the script behaves the same from any working directory. */
const outAbs = resolve(root, outfile);

/** Externalise every bare import except this workspace's own packages. */
const externalNodeModules = {
  name: "external-node-modules",
  setup(b) {
    b.onResolve({ filter: /.*/ }, (args) => {
      // Relative and absolute paths are this repo's own files — including the entry point, which
      // on Windows arrives as `D:\...` and would otherwise look like a bare specifier.
      if (args.path.startsWith(".") || isAbsolute(args.path)) return null;
      if (args.path.startsWith("@feather-lite/")) return null;
      return { path: args.path, external: true };
    });
  },
};

const t0 = performance.now();
const result = await build({
  entryPoints: [resolve(root, entry)],
  outfile: outAbs,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // Separate file: a 3 MB inline source map is loaded into memory by every job process.
  sourcemap: "linked",
  // Deliberately not minified. The saving is a few hundred KB on disk against a stack trace an
  // operator can read, and nothing here is shipped over a network to a browser.
  minify: false,
  metafile: true,
  absWorkingDir: root,
  plugins: [externalNodeModules],
  logLevel: "warning",
});

/**
 * Every bare import the bundle kept must resolve **from the bundle's own directory**.
 *
 * Inlining the workspace packages moves their imports into the app: `@feather-lite/contracts` pulls
 * `@effect/platform`, `@feather-lite/control-plane` pulls `pg`, `openai` and the Langfuse SDKs, and
 * under pnpm's strict layout none of those resolve from `apps/*` unless the app declares them. That
 * is not a workaround — the bundle genuinely depends on them, and `pnpm deploy --prod` builds the
 * image's `node_modules` from exactly this list.
 *
 * Checked here so a dependency added to a workspace package six months from now fails the build
 * rather than the first job process that tries to start.
 */
const source = readFileSync(outAbs, "utf8");
const externals = [...new Set([...source.matchAll(/^(?:import|export)[^;]*?from\s*"([^"]+)"/gm)].map((m) => m[1]))]
  .filter((spec) => !spec.startsWith("node:") && !spec.startsWith(".") && !spec.startsWith("/"));
const requireFromBundle = createRequire(outAbs);
const unresolved = externals.filter((spec) => {
  try {
    requireFromBundle.resolve(spec);
    return false;
  } catch {
    return true;
  }
});
if (unresolved.length > 0) {
  const app = dirname(dirname(outfile));
  console.error(`
${outfile} imports ${String(unresolved.length)} package(s) that do not resolve from ${app}:`);
  for (const spec of unresolved) console.error(`  ${spec}`);
  console.error(`
Add them to ${app}/package.json — the bundle inlines the workspace packages, so their
dependencies are the app's dependencies now, and the production image installs from that list.
`);
  process.exit(1);
}

const bytes = readFileSync(outAbs).length;
// Two outputs (the bundle and its source map); the bundle is the one with inputs.
const moduleCount = Math.max(...Object.values(result.metafile.outputs).map((o) => Object.keys(o.inputs ?? {}).length));
console.log(`${outfile}  ${(bytes / 1024).toFixed(0)} KB from ${String(moduleCount)} module(s) in ${(performance.now() - t0).toFixed(0)} ms`);
