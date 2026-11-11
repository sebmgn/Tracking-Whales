// Safety net on the page's calculations — run before every deploy
// (deploy.sh). Expected values are worked out by hand in the comments,
// except the notes, which are compared to tests/golden-notes.json.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadPage } from "./page.mjs";

const { T, errors, close } = loadPage();
after(close);
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, a + " ≠ " + b);
const plain = (s) => String(s).replace(/[  ]/g, " "); // the page uses non-breaking spaces

test("la page démarre sans erreur de script", () => {
  assert.deepEqual(errors, []);
});

// ---------- formats ----------
test("fmtUSD : centimes sous 100 $, aucun à partir de 100 $", () => {
  assert.equal(plain(T.fmtUSD(12.5)), "12,50 $");
  assert.equal(plain(T.fmtUSD(99.994)), "99,99 $");
  assert.equal(plain(T.fmtUSD(99.996)), "100 $"); // rounds to 100,00 → no cents
  assert.equal(plain(T.fmtUSD(1234.5)), "1 235 $");
  assert.equal(plain(T.fmtUSD(-45.2)), "-45,20 $");
  assert.equal(plain(T.fmtUSDSigned(250)), "+250 $");
  assert.equal(plain(T.fmtUSDSigned(-3)), "-3,00 $");
});
test("fmtCents et fmtPct : virgule française, signe + sur les gains", () => {
  assert.equal(plain(T.fmtCents(0.375)), "37,5 ¢");
  assert.equal(plain(T.fmtCents(0.999)), "99,9 ¢");
  assert.equal(plain(T.fmtPct(12.345)), "+12,35 %");
  assert.equal(plain(T.fmtPct(-4)), "-4,00 %");
  assert.equal(plain(T.fmtPct(0)), "0,00 %");
});
test("isPriceDecided : seulement à 0,05 ¢ des bornes", () => {
  assert.equal(T.isPriceDecided(0.9995), true);
  assert.equal(T.isPriceDecided(0.999), false);
  assert.equal(T.isPriceDecided(0.0005), true);
  assert.equal(T.isPriceDecided(0.5), false);
  assert.equal(T.isPriceDecided(null), false);
});

// ---------- PnL / ROI ----------
const bet = (o) => Object.assign({ question: "A vs B", leaderName: "A", leaderPriceAtSnapshot: 0.4, winningSide: "A" }, o);
test("PnL d'un pari gagné : mise × (1/cote − 1)", () => {
  near(T.hypotheticalFlatPnl(bet(), 100), 150); // 100 × (1/0,40 − 1)
  near(T.hypotheticalFlatPnl(bet({ leaderPriceAtSnapshot: 0.8 }), 50), 12.5); // 50 × 0,25
});
test("PnL d'un pari perdu : −mise, y compris « l'autre camp » inconnu", () => {
  near(T.hypotheticalFlatPnl(bet({ winningSide: "B" }), 100), -100);
  near(T.hypotheticalFlatPnl(bet({ winningSide: T.OTHER_SIDE_SENTINEL }), 100), -100);
});
test("pas de PnL tant que le résultat ou la cote manque", () => {
  assert.equal(T.hypotheticalFlatPnl(bet({ winningSide: null }), 100), null);
  assert.equal(T.hypotheticalFlatPnl(bet({ leaderPriceAtSnapshot: null }), 100), null);
  assert.equal(T.hypotheticalFlatPnl(bet({ leaderPriceAtSnapshot: 0 }), 100), null);
});
test("pari réel de Seb : le PnL réel prime, à l'échelle de la mise demandée", () => {
  const seb = bet({ realPnl: 30, stakeUsd: 200 }); // formula alone would give +300
  near(T.hypotheticalFlatPnl(seb, 200), 30);
  near(T.hypotheticalFlatPnl(seb, 100), 15);
});
test("Saison : mise fixe ; Mes Positions : la mise de chaque pari", () => {
  const list = [bet({ stakeUsd: 20 }), bet({ stakeUsd: 60, winningSide: "B" }), bet({ stakeUsd: 10, winningSide: null })];
  const F = T.HYPOTHETICAL_FLAT_STAKE;
  const s = T.aggregateFlatPnl(list, T.SNAPSHOTS_STORE); // +1,5 F − F over 2 F staked
  assert.equal(s.count, 2);
  near(s.pnl, 0.5 * F); near(s.stakeSum, 2 * F); near(s.roi, 25);
  const p = T.aggregateFlatPnl(list, T.POSITIONS_STORE); // +30 − 60 over 80 staked
  near(p.pnl, -30); near(p.stakeSum, 80); near(p.roi, -37.5);
});
test("ROI nul sans pari décidé", () => {
  const r = T.aggregateFlatPnl([bet({ winningSide: null })], T.SNAPSHOTS_STORE);
  assert.equal(r.count, 0); assert.equal(r.roi, null);
});
test("Comparateur (1 000 $) : gagné, perdu, pas encore joué", () => {
  near(T.crPnl(1, 0.5), 1000);
  near(T.crPnl(1, 0.8), 250);
  assert.equal(T.crPnl(0, 0.5), -1000);
  assert.equal(T.crPnl(null, 0.5), 0);
});

// ---------- cashout ----------
test("cashout : étiquette avec le prix de vente", () => {
  assert.equal(plain(T.snapCashoutTag({ cashout: { price: 0.75 } })), "💸 Cashout à 75,0 ¢ · ");
  assert.equal(plain(T.snapCashoutTag({ cashout: { price: 0.6, part: true } })), "💸 Cashout partiel à 60,0 ¢ · ");
  assert.equal(T.snapCashoutTag({}), "");
});
test("cashout : ce que garder aurait donné, et l'écart", () => {
  // 100 $ at 50 ¢, sold for +40 $; held to a win it was +100 $ → cost 60 $
  const cost = plain(T.snapCashoutFinalHtml(bet({ leaderPriceAtSnapshot: 0.5, stakeUsd: 100, realPnl: 40, cashout: { hold: 100, price: 0.7 } }), T.POSITIONS_STORE));
  assert.match(cost, /A gagnant/); assert.match(cost, /gardé : \+100 \$/); assert.match(cost, /coûté 60,00 \$/);
  // sold for −20 $; held to a loss it was −100 $ → saved 80 $
  const saved = plain(T.snapCashoutFinalHtml(bet({ leaderPriceAtSnapshot: 0.5, stakeUsd: 100, realPnl: -20, winningSide: "B", cashout: { hold: -100, price: 0.4 } }), T.POSITIONS_STORE));
  assert.match(saved, /A perdant/); assert.match(saved, /gardé : -100 \$/); assert.match(saved, /sauvé 80,00 \$/);
  assert.match(T.snapCashoutFinalHtml(bet({ cashout: { hold: null, price: 0.7 } }), T.POSITIONS_STORE), /pas encore connu/);
});

// ---------- note ----------
test("consensusGate : rampe linéaire entre le plancher et 1", () => {
  near(T.consensusGate(0, 0.5, 0.2), 0.2);
  near(T.consensusGate(0.25, 0.5, 0.2), 0.6); // halfway up the ramp
  near(T.consensusGate(0.5, 0.5, 0.2), 1);
  near(T.consensusGate(2, 0.5, 0.2), 1); // capped
});
const golden = JSON.parse(readFileSync(new URL("./golden-notes.json", import.meta.url), "utf8"));
test("notes : " + golden.length + " snapshots réels donnent la même note qu'à la référence", () => {
  const drift = [];
  golden.forEach((c) => {
    const out = T.normalizeSnapshotNumbers(JSON.parse(JSON.stringify(c.input)));
    const got = { note: out.noteAtSnapshot, leaderName: out.leaderName, traderCount: out.traderCount, totalStake: Math.round(out.totalStake * 100) / 100 };
    if (JSON.stringify(got) !== JSON.stringify(c.expected)) drift.push(c.input.question + " : " + JSON.stringify(c.expected) + " → " + JSON.stringify(got));
  });
  assert.deepEqual(drift, [], "notes changées (si c'est voulu : node tests/make-golden.mjs)");
});
test("note : toujours entre 0 et 10, camp majoritaire en tête", () => {
  golden.forEach((c) => {
    assert.ok(c.expected.note >= 0 && c.expected.note <= 10, c.input.question);
    const top = c.input.sides.slice().sort((a, b) => b.traderCount - a.traderCount || b.stake - a.stake)[0];
    if (top.traders.every((t) => t.stake >= 1000)) assert.equal(c.expected.leaderName, top.name, c.input.question);
  });
});

// ---------- type de pari ----------
test("Type : props = événement Polymarket sans date dans le slug", () => {
  assert.equal(T.isLongTermSlug("epl-winner-2026-27"), true);
  assert.equal(T.isLongTermSlug("epl-ars-che-2026-11-08"), false);
  assert.equal(T.isLongTermSlug(""), false);
  assert.equal(T.snapOrigin({ eventSlug: "epl-winner-2026-27", isManual: true }), "props");
  assert.equal(T.snapOrigin({ eventSlug: "epl-ars-che-2026-11-08", isManual: true }), "manual");
  assert.equal(T.snapOrigin({ eventSlug: "epl-ars-che-2026-11-08", cmp: {} }), "cmp");
  assert.equal(T.snapOrigin({ eventSlug: "epl-ars-che-2026-11-08", origin: "fin" }), "fin");
  assert.equal(T.snapOrigin({ eventSlug: "epl-ars-che-2026-11-08" }), "auto");
});

// ---------- synchro / stockage ----------
test("fiche incomplète (sans question ou sans date) écartée", () => {
  assert.equal(T.isCompleteRecord({ id: "a", question: "Q", savedAt: "2026-11-01T10:00:00Z" }), true);
  assert.equal(T.isCompleteRecord({ id: "a", winningSide: "A" }), false);
  assert.equal(T.isCompleteRecord({ id: "a", question: "Q", savedAt: "pas une date" }), false);
});
test("stockage local : le HTML de carte n'est retiré que s'il est reconstructible, le lien est gardé", () => {
  const html = '<a href="https://polymarket.com/fr/event/epl-ars-che-2026-11-08">x</a>';
  const [auto, manual, noSides] = T.compactForStorage([
    { id: 1, cardHtml: html, sides: [{ name: "A" }] },
    { id: 2, cardHtml: html, sides: [{ name: "A" }], isManual: true },
    { id: 3, cardHtml: html },
  ]);
  assert.equal(auto.cardHtml, undefined); assert.equal(auto.eventSlug, "epl-ars-che-2026-11-08");
  assert.equal(manual.cardHtml, html);
  assert.equal(noSides.cardHtml, html);
});
test("opérations de synchro : chacune ne touche que sa fiche", () => {
  const base = [{ id: "a", question: "Q1", savedAt: "2026-11-01T10:00:00Z" }, { id: "b", question: "Q2", savedAt: "2026-11-02T10:00:00Z" }];
  const ap = (op) => T.applyOpToList(JSON.parse(JSON.stringify(base)), op);
  const other = (l) => assert.deepEqual(l.find((s) => s.id === "b"), base[1]);
  let l = ap({ type: "setSide", id: "a", winningSide: "A" }); assert.equal(l[0].winningSide, "A"); other(l);
  l = ap({ type: "setConf", id: "a", confidence: "S" }); assert.equal(l[0].confidence, "S"); other(l);
  l = ap({ type: "editPosition", id: "a", patch: { stakeUsd: 50, comment: "ok" } }); assert.equal(l[0].stakeUsd, 50); assert.equal(l[0].comment, "ok"); assert.equal(l[0].question, "Q1"); other(l);
  l = ap({ type: "setSavedAt", id: "a", savedAt: "2026-11-03T10:00:00Z" }); assert.equal(l[0].savedAt, "2026-11-03T10:00:00Z"); other(l);
  l = ap({ type: "trash", id: "a", deletedAt: "2026-11-04T10:00:00Z" }); assert.equal(l.find((s) => s.id === "a").deletedAt, "2026-11-04T10:00:00Z"); other(l);
  l = T.applyOpToList(l, { type: "restore", id: "a" }); assert.equal(l.find((s) => s.id === "a").deletedAt, undefined);
  l = ap({ type: "delete", id: "a" }); assert.deepEqual(l.map((s) => s.id), ["b"]);
  l = ap({ type: "add", id: "c", snapshot: { id: "c", question: "Q3", savedAt: "2026-11-05T10:00:00Z" } }); assert.equal(l.length, 3);
  assert.deepEqual(ap({ type: "inconnu", id: "a" }), base);
});

test("stockage plein : la liste passe dans le stockage de secours et reste lisible", () => {
  const key = "vtTestBigList", list = [{ id: "a1", question: "Lens – Lille", savedAt: "2026-11-09T20:00:00Z" }];
  const ls = T.__ls;
  const orig = ls.setItem;
  Object.getPrototypeOf(ls).setItem = function (k) { if (k === key) throw new Error("QuotaExceededError"); return orig.apply(this, arguments); };
  try {
    assert.equal(T.storeListSafely(key, list), true);
    assert.equal(typeof T.bigMem[key], "string");
    assert.deepEqual(JSON.parse(JSON.stringify(T.readStoredList(key))), list);
    // a later save of the same list goes straight to the fallback store
    assert.equal(T.storeListSafely(key, list.concat([{ id: "b2", question: "Lyon – OM", savedAt: "2026-11-10T20:00:00Z" }])), true);
    assert.equal(T.readStoredList(key).length, 2);
  } finally { Object.getPrototypeOf(ls).setItem = orig; delete T.bigMem[key]; }
});
