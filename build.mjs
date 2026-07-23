// build.mjs — regenerate the single-file signaldesk.html from the modular source.
//
// It inlines css/styles.css into a <style> block and concatenates the ES modules
// (imports/exports stripped) into one <script>, appending the namespace "glue"
// (ta / auth / portfolio) at the end so there are no temporal-dead-zone issues.
//
//   node build.mjs
import { readFileSync, writeFileSync } from "node:fs";

const ROOT = new URL("./", import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), "utf8");

// Module concatenation order (dependencies before dependents).
const MODULE_ORDER = [
  "js/indicators.js",
  "js/tiers.js",
  "js/auth.js",
  "js/watchlists.js",
  "js/portfolio.js",
  "js/valuation.js",
  "js/data.js",
  "js/news.js",
  "js/signals.js",
  "js/app.js",
];

// Strip `import ... ;` (single- or multi-line) and the leading `export ` keyword.
function stripModule(src) {
  return src
    .replace(/^import\b[^;]*;/gm, "")   // whole import statement, spans newlines
    .replace(/^export\s+/gm, "")        // `export function/const/...` -> keep the decl
    .replace(/^\n{3,}/gm, "\n\n");      // tidy the blank lines the strips leave behind
}

const glue = [
  "// module glue",
  "var ta = { sma, ema, rsi, macd, bollinger, stochastic, atr, obv, adx, last, prev };",
  "var auth = { signup, login, logout, getUser, setTier, setViewAs, getViewAs, effectiveTierId, isOwnerEmail, OWNER_EMAILS };",
  "var portfolio = { load, save, reset, trade, value, snapshot, STARTING_CASH };",
].join("\n");

const js = MODULE_ORDER.map((m) => stripModule(read(m)).trimEnd()).join("\n\n\n") + "\n\n\n" + glue + "\n";
const css = read("css/styles.css");

let html = read("index.html");
// Use function replacements so `$` sequences in the CSS/JS aren't treated as
// String.replace special patterns ($&, $`, $', $n, ...).
html = html.replace(
  /<link rel="stylesheet" href="css\/styles\.css" \/>/,
  () => `<style>\n${css}\n</style>`
);
html = html.replace(
  /<script type="module" src="js\/app\.js"><\/script>/,
  () => `<script>\n${js}\n</script>`
);

if (html.includes('href="css/styles.css"') || html.includes('src="js/app.js"')) {
  throw new Error("Build failed: link/script placeholder not replaced.");
}

writeFileSync(new URL("signaldesk.html", ROOT), html);
console.log("Built signaldesk.html —", html.length, "bytes");
