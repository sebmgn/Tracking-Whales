// Boots the real positions.html in a headless DOM and hands back some of its
// internal functions, so the tests run against the code that ships — the
// page itself carries no test hook. The page's closing lines (first refresh
// + the 1 s ticker) are swapped, in memory only, for an export of the
// functions named below; the network is cut (fetch never answers).
import { JSDOM, VirtualConsole } from "jsdom";
import { readFileSync } from "node:fs";

// TW_PAGE: another copy of the page to test (used to check the tests themselves).
const PAGE = process.env.TW_PAGE || new URL("../positions.html", import.meta.url);
const TAIL = "refresh(true);\n  setInterval(tick, 1000);";
export const NAMES = [
  "fmtUSD", "fmtUSDSigned", "fmtCents", "fmtPct", "isPriceDecided",
  "consensusGate", "scoreFromSnapshotSides", "normalizeSnapshotNumbers",
  "hypotheticalFlatPnl", "aggregateFlatPnl", "crPnl",
  "snapCashoutTag", "snapCashoutFinalHtml", "snapOrigin", "isLongTermSlug",
  "compactForStorage", "applyOpToList", "isCompleteRecord",
  "storeListSafely", "readStoredList", "bigMem",
  "SNAPSHOTS_STORE", "POSITIONS_STORE", "HYPOTHETICAL_FLAT_STAKE", "OTHER_SIDE_SENTINEL",
];

export function loadPage() {
  let html = readFileSync(PAGE, "utf8");
  if (!html.includes(TAIL)) throw new Error("positions.html : fin de script introuvable (tests/page.mjs à adapter)");
  html = html.replace(TAIL, "window.__T = {__ls: localStorage, " + NAMES.map((n) => n + ": typeof " + n + " === 'undefined' ? undefined : " + n).join(",") + "};");
  const errors = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => errors.push(String((e.detail && e.detail.message) || e.message)));
  const dom = new JSDOM(html, {
    runScripts: "dangerously", url: "https://test.invalid/", pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      w.fetch = () => new Promise(() => {});
      w.matchMedia = w.matchMedia || (() => ({ matches: false, addEventListener() {}, addListener() {} }));
      w.scrollTo = () => {};
    },
  });
  const T = dom.window.__T;
  if (!T) throw new Error("la page n'a pas démarré : " + (errors[0] || "raison inconnue"));
  const missing = NAMES.filter((n) => T[n] === undefined);
  if (missing.length) throw new Error("introuvable dans positions.html : " + missing.join(", "));
  return { T, errors, close: () => dom.window.close() };
}
