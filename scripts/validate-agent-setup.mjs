import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");
const json = (path) => JSON.parse(read(path));
const manifest = json("docs/agents/skills-provenance.json");
assert.equal(manifest.version, 1, "Unsupported provenance version");
const expected = Object.keys(manifest.skills).sort();
const skillRoot = join(root, ".agents/skills");
const actual = readdirSync(skillRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
assert.deepEqual(actual, expected, "Discovered skills differ from provenance");

function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    assert(!lstatSync(path).isSymbolicLink(), `Linked skill artifact: ${path}`);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

function checkReferences(path, text) {
  for (const match of text.matchAll(/\[[^\]\n]+\]\(([^)\n]+)\)/g)) {
    const target = match[1].replace(/^<|>$/g, "").split("#")[0];
    if (!target || /^[a-z]+:/i.test(target)) continue;
    const resolved = resolve(dirname(path), target);
    assert(existsSync(resolved), `Missing reference in ${path}: ${target}`);
  }
}

let explicit = 0;
for (const name of expected) {
  assert(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name), `Invalid skill name: ${name}`);
  const directory = join(skillRoot, name);
  const entry = manifest.skills[name];
  const paths = filesUnder(directory);
  const inventory = paths.map((path) => relative(directory, path).replaceAll("\\", "/")).sort();
  assert.deepEqual(inventory, Object.keys(entry.localFiles).sort(), `Unrecorded artifacts: ${name}`);
  for (const path of paths) {
    const localPath = relative(directory, path).replaceAll("\\", "/");
    const hash = createHash("sha256").update(readFileSync(path)).digest("hex");
    assert.equal(hash, entry.localFiles[localPath], `Content changed: ${name}/${localPath}; update provenance deliberately`);
    if (path.endsWith(".md")) checkReferences(path, readFileSync(path, "utf8"));
  }
  const text = readFileSync(join(directory, "SKILL.md"), "utf8");
  const frontmatter = /^---\r?\nname: ("[^\n]+")\r?\ndescription: ("[^\n]+")\r?\n---\r?\n/.exec(text);
  assert(frontmatter, `Expected quoted name/description frontmatter: ${name}`);
  assert.equal(JSON.parse(frontmatter[1]), name);
  assert(JSON.parse(frontmatter[2]).length < 1024, `Overlong description: ${name}`);
  assert(!/Skill tool|claude --bg|disable-model-invocation|\/clear\b/.test(text), `Stale runtime instruction: ${name}`);
  const metadata = readFileSync(join(directory, "agents/openai.yaml"), "utf8");
  const short = /short_description: ("[^\n]+")/.exec(metadata);
  assert(short, `Missing quoted description: ${name}`);
  const shortLength = JSON.parse(short[1]).length;
  assert(shortLength >= 25 && shortLength <= 64, `UI description length: ${name}`);
  const policy = /allow_implicit_invocation: (true|false)/.exec(metadata);
  assert(policy, `Missing invocation policy: ${name}`);
  assert.equal(policy[1] === "true", entry.allowImplicitInvocation, `Policy differs from provenance: ${name}`);
  if (!entry.allowImplicitInvocation) explicit++;
}

for (const path of ["AGENTS.md", "docs/agents/domain.md", "docs/agents/issue-tracker.md", "docs/agents/typescript-effect.md", "docs/agents/skills.md"]) {
  checkReferences(join(root, path), read(path));
}
assert(!existsSync(join(root, ".claude/skills")), "Retired Claude skill tree is still discoverable");
const lock = json("skills-lock.json");
const sourced = expected.filter((name) => manifest.skills[name].origin.repository === "https://github.com/mattpocock/skills");
assert.deepEqual(Object.keys(lock.skills).sort(), sourced, "Installer lock has retired/missing entries");
const pkg = json("package.json");
assert.equal(pkg.devDependencies.oxlint, pkg.devDependencies["@oxlint/plugins"], "Oxlint/plugin versions must match");
assert(/^\d+\.\d+\.\d+$/.test(pkg.devDependencies.oxlint), "Lint dependencies must be pinned exactly");
for (const path of [".oxlintrc.json", ".oxlintrc.baseline.json"]) {
  const config = json(path);
  for (const plugin of config.jsPlugins) assert(existsSync(resolve(root, plugin.specifier)), `Missing plugin: ${plugin.specifier}`);
}
console.log(`Agent setup valid: ${expected.length} skills (${explicit} explicit, ${expected.length - explicit} implicit), hashes and references checked; lint dependencies matched.`);
