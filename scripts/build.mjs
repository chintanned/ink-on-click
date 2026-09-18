// Builds dist/ink-on-click.html: one file with the effect, the demo
// and DialKit inlined, so it works offline by double clicking it.
// Usage: npm install && npm run build
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dialkitDir = join(root, "node_modules", "dialkit", "dist", "vanilla");

const read = (p) => readFileSync(p, "utf8");
const demo = read(join(root, "demo/index.html"));
const ink = read(join(root, "src/ink.js")).replace(/^export /gm, "");
const dkJs = read(join(dialkitDir, "browser.global.js")).replace(/<\/script/g, "<\\/script");
const dkCss = read(join(dialkitDir, "styles.css"));

let out = demo
  .replace(/<link rel="stylesheet" href="https:\/\/cdn\.jsdelivr\.net\/npm\/dialkit[^>]*>/, () => `<style>${dkCss}</style>`)
  .replace(/<!--DIALKIT-->[\s\S]*?<!--\/DIALKIT-->/, () => `<script>${dkJs}</script>`)
  .replace(/import \{ createInk, defaults \} from "\.\.\/src\/ink\.js";/, () => ink);

if (out.includes("../src/ink.js") || out.includes("cdn.jsdelivr.net/npm/dialkit")) {
  throw new Error("build: a replacement did not match, check demo/index.html");
}
mkdirSync(join(root, "dist"), { recursive: true });
writeFileSync(join(root, "dist/ink-on-click.html"), out);
console.log("wrote dist/ink-on-click.html", (out.length / 1024).toFixed(0) + " KB");
