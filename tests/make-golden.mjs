// Rebuilds tests/golden-notes.json: what the page computes TODAY for a fixed
// sample of real snapshots (note, leader, trader count, total stake).
// Run it only after a deliberate change of the scoring, then read the diff:
//   node tests/make-golden.mjs                      (same sample, new results)
//   node tests/make-golden.mjs <snapshots.json>     (new sample from a backup)
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { loadPage } from "./page.mjs";

const OUT = new URL("./golden-notes.json", import.meta.url);
const SAMPLE = 40;
const input = (s) => ({ question: s.question, leaderPriceAtSnapshot: s.leaderPriceAtSnapshot, sides: s.sides });

let inputs;
if (process.argv[2]) {
  const all = JSON.parse(readFileSync(process.argv[2], "utf8"))
    .filter((s) => s && s.sides && s.sides.length && !s.isManual && s.leaderPriceAtSnapshot != null && s.question)
    .sort((a, b) => String(a.id) < String(b.id) ? -1 : 1);
  const step = Math.max(1, Math.floor(all.length / SAMPLE));
  inputs = all.filter((_, i) => i % step === 0).slice(0, SAMPLE).map(input);
} else if (existsSync(OUT)) {
  inputs = JSON.parse(readFileSync(OUT, "utf8")).map((c) => c.input);
} else {
  throw new Error("donne un fichier de sauvegarde des snapshots en argument");
}

const { T, close } = loadPage();
const cases = inputs.map((inp) => {
  const out = T.normalizeSnapshotNumbers(JSON.parse(JSON.stringify(inp)));
  return { input: inp, expected: { note: out.noteAtSnapshot, leaderName: out.leaderName, traderCount: out.traderCount, totalStake: Math.round(out.totalStake * 100) / 100 } };
});
close();
writeFileSync(OUT, "[\n" + cases.map((c) => JSON.stringify(c)).join(",\n") + "\n]\n");
console.log(cases.length + " cas écrits dans tests/golden-notes.json");
process.exit(0);
