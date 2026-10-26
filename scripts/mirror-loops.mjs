// Rebuilds loops/shipped.ts from the shipped loop folders under loops/.
// `claude plugin test` gives tests no file system, so the tests read the shipped loops from that mirror.
// Run it from anywhere: node scripts/mirror-loops.mjs
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

const here = import.meta.dirname ?? dirname(decodeURIComponent(new URL(import.meta.url).pathname));
const root = join(here, "..", "loops");
const target = join(root, "shipped.ts");
const marker = "export const SHIPPED_LOOP_FILES";

const old = readFileSync(target, "utf8");
const at = old.indexOf(marker);
if (at < 0) throw new Error(`${target} has no ${marker}`);
const header = old.slice(0, at);

const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function files(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...files(path));
    else out.push(path);
  }
  return out;
}

const folders = readdirSync(root)
  .filter((name) => statSync(join(root, name)).isDirectory())
  .sort(byCodeUnit);

const lines = [];
for (const folder of folders) {
  const paths = files(join(root, folder))
    .map((path) => relative(root, path).split(sep).join("/"))
    .sort(byCodeUnit);
  for (const path of paths) {
    const text = readFileSync(join(root, path), "utf8");
    lines.push(`  ${JSON.stringify(path)}: ${JSON.stringify(text)},`);
  }
}

writeFileSync(target, `${header}${marker}: Record<string, string> = {\n${lines.join("\n")}\n}\n`);
console.log(`${relative(process.cwd(), target) || target}: ${lines.length} files from ${folders.length} loops`);
