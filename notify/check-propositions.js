// Scheduled watcher (runs via GitHub Actions, not the local PC): alerts by
// email when at least MIN_TRADERS of the 4 watched traders hold the same
// side of the same real-world bet (matched across Predict.fun and
// Polymarket the same way positions.html links them) with a combined
// position value of at least MIN_STAKE. State is persisted to state.json
// (committed back to the repo each run) so an already-notified bet doesn't
// re-trigger every 15 minutes — only new qualifying bets send an email.
"use strict";

const fs = require("fs");
const path = require("path");
const nodemailer = require("nodemailer");

const API_KEY = process.env.PREDICT_API_KEY;
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
const NOTIFY_TO = process.env.NOTIFY_TO || GMAIL_USER;

const MIN_TRADERS = 3;
const MIN_STAKE = 1000;
const STATE_FILE = path.join(__dirname, "state.json");

const WATCHED = [
  { name: "predict847", platform: "predict", address: "0x21f861D43B2E2E05F9974D1a27d0c8959e59a1F8" },
  { name: "JJJJ", platform: "predict", address: "0x8Ad2C531324567a4008D9e2BCcC59CC5C8fcFC25" },
  { name: "swisstony", platform: "polymarket", address: "0x204f72f35326db932158cba6adff0b9a1da95e14" },
  { name: "VeryLucky888", platform: "polymarket", address: "0x6d3c5bd13984b2de47c3a88ddc455309aab3d294" }
];

const PREDICT_POSITIONS_BASE = "https://api.predict.fun/v1/positions/";
const POLY_POSITIONS_BASE = "https://data-api.polymarket.com/positions";

// ---------- resilience helpers ----------
// A single transient hiccup (network blip, 5xx, rate-limit) on any one of
// these upstream APIs used to throw straight out of main() and kill the
// whole cycle in a few seconds — see the 2026-07-20 22:59/00:04 failures.
// Retry transient errors, and never let one bad source block the others.
const FETCH_TIMEOUT_MS = 15000;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function withRetry(fn, { attempts = 3, delayMs = 800, isRetryable = () => true } = {}) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i === attempts || !isRetryable(e)) throw e;
      await sleep(delayMs * i);
    }
  }
  throw lastErr;
}

async function fetchJson(url, options) {
  return withRetry(
    async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        const res = await fetch(url, { ...options, signal: controller.signal });
        if (!res.ok) {
          const err = new Error("HTTP " + res.status + " on " + url);
          err.status = res.status;
          throw err;
        }
        return await res.json();
      } finally {
        clearTimeout(timer);
      }
    },
    { attempts: 3, delayMs: 800, isRetryable: (e) => !e.status || e.status >= 500 || e.status === 429 }
  );
}

// ---------- fetch + normalize (same shape/conventions as positions.html) ----------
async function fetchAllPredict(address) {
  const all = [];
  let after = null;
  for (let i = 0; i < 20; i++) {
    const url = PREDICT_POSITIONS_BASE + encodeURIComponent(address) +
      "?first=100&isResolved=false&sort=SHARES_VALUE_DESC" + (after ? "&after=" + encodeURIComponent(after) : "");
    const json = await fetchJson(url, { headers: { "x-api-key": API_KEY } });
    all.push(...(json.data || []));
    if (!json.cursor || !json.data || json.data.length === 0) break;
    after = json.cursor;
  }
  return all;
}

async function fetchAllPoly(address) {
  const all = [];
  let offset = 0;
  const pageSize = 500;
  for (let i = 0; i < 10; i++) {
    const url = POLY_POSITIONS_BASE + "?user=" + encodeURIComponent(address) +
      "&limit=" + pageSize + "&offset=" + offset + "&sizeThreshold=0.01";
    const page = await fetchJson(url);
    all.push(...(page || []));
    if (!page || page.length < pageSize) break;
    offset += pageSize;
  }
  return all.filter((p) => p.redeemable !== true);
}

function normPredict(p, t) {
  const market = p.market || {};
  const outcome = p.outcome || {};
  return {
    trader: t.name, platform: "predict", marketKey: "predict|" + market.id,
    question: market.question || market.title || "—",
    slug: market.categorySlug,
    outcomeKey: String(outcome.indexSet),
    outcomeName: outcome.name || "—",
    valueUsd: parseFloat(p.valueUsd) || 0,
    marketUrl: market.categorySlug ? "https://predict.fun/market/" + market.categorySlug : "https://predict.fun"
  };
}

function normPoly(p, t) {
  return {
    trader: t.name, platform: "polymarket", marketKey: "polymarket|" + p.conditionId,
    question: p.title || "—", slug: p.slug || p.eventSlug,
    outcomeKey: String(p.outcomeIndex), outcomeName: p.outcome || "—",
    valueUsd: p.currentValue || 0,
    marketUrl: (p.eventSlug || p.slug) ? "https://polymarket.com/event/" + (p.eventSlug || p.slug) : "https://polymarket.com"
  };
}

// One trader/platform failing (bad data, exhausted retries) no longer aborts
// the whole cycle — it's skipped and logged, the rest still gets checked.
async function fetchAllWatchedPositions() {
  const positions = [];
  for (const t of WATCHED) {
    try {
      const raw = t.platform === "polymarket" ? await fetchAllPoly(t.address) : await fetchAllPredict(t.address);
      const norm = t.platform === "polymarket" ? normPoly : normPredict;
      raw.forEach((p) => {
        try {
          positions.push(norm(p, t));
        } catch (e) {
          console.error("Position ignorée pour " + t.name + " (" + t.platform + ") : " + e.message);
        }
      });
    } catch (e) {
      console.error("Source ignorée pour ce cycle — " + t.name + " (" + t.platform + ") : " + e.message);
    }
  }
  return positions;
}

// ---------- cross-platform market linking (ported verbatim from positions.html) ----------
const LINK_STOPWORDS = { will: 1, the: 1, win: 1, wins: 1, on: 1, to: 1, in: 1, of: 1, and: 1, or: 1, is: 1, be: 1, at: 1, by: 1, for: 1, than: 1 };
function normalizeMatchText(s) { return (s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean); }
function significantTokens(s) { return normalizeMatchText(s).filter((w) => w.length >= 3 && !LINK_STOPWORDS[w]); }
function jaccard(a, b) {
  const A = {}, B = {}; a.forEach((w) => (A[w] = 1)); b.forEach((w) => (B[w] = 1));
  const u = {}; let inter = 0;
  Object.keys(A).forEach((w) => { u[w] = 1; if (B[w]) inter++; });
  Object.keys(B).forEach((w) => (u[w] = 1));
  const uc = Object.keys(u).length;
  return uc > 0 ? inter / uc : 0;
}
function numericFingerprint(s) { const m = (s || "").match(/\d+(\.\d+)?/g); return m ? m.join(",") : ""; }
function sharedTokenCount(a, b) { const B = {}; b.forEach((w) => (B[w] = 1)); let n = 0; a.forEach((w) => { if (B[w]) n++; }); return n; }
function matchKeyFromSlug(slug) { if (!slug) return null; const m = slug.match(/^(.*?-\d{4}-\d{2}-\d{2})/); return m ? m[1] : null; }
function linkScore(pg, mg) {
  const sameConfrontation = pg.matchKey && mg.matchKey && pg.matchKey === mg.matchKey;
  const bothOutright = !pg.matchKey && !mg.matchKey;
  if (!sameConfrontation && !bothOutright) return 0;
  const pNum = numericFingerprint(pg.question), mNum = numericFingerprint(mg.question);
  if ((pNum || mNum) && pNum !== mNum) return 0;
  if (sharedTokenCount(pg.tokens, mg.tokens) < 2) return 0;
  const j = jaccard(pg.tokens, mg.tokens);
  const threshold = sameConfrontation ? 0.7 : 0.5;
  return j >= threshold ? j : 0;
}

// ---------- group positions by market, link across platforms, evaluate the rule ----------
function findAlerts(positions) {
  const groups = {};
  positions.forEach((p) => {
    if (!groups[p.marketKey]) groups[p.marketKey] = { key: p.marketKey, platform: p.platform, question: p.question, slug: p.slug, marketUrl: p.marketUrl, bySide: {} };
    const g = groups[p.marketKey];
    if (!g.bySide[p.outcomeKey]) g.bySide[p.outcomeKey] = { name: p.outcomeName, entries: [] };
    g.bySide[p.outcomeKey].entries.push({ trader: p.trader, valueUsd: p.valueUsd });
  });
  const groupList = Object.values(groups);

  groupList.forEach((g) => { g.tokens = significantTokens(g.question); g.matchKey = matchKeyFromSlug(g.slug); g.linkedGroup = null; });
  const predictGroups = groupList.filter((g) => g.platform === "predict");
  const polyGroups = groupList.filter((g) => g.platform === "polymarket");
  polyGroups.forEach((mg) => {
    let best = null, bestScore = 0;
    predictGroups.forEach((pg) => {
      if (pg.linkedGroup) return;
      const score = linkScore(pg, mg);
      if (score > bestScore) { bestScore = score; best = pg; }
    });
    if (best) { mg.linkedGroup = best; best.linkedGroup = mg; }
  });

  const consumed = {};
  const alerts = [];
  groupList.forEach((g) => {
    if (consumed[g.key]) return;
    const partner = g.linkedGroup;
    consumed[g.key] = true;
    if (partner) consumed[partner.key] = true;
    const members = partner ? [g, partner] : [g];

    const bySideName = {};
    members.forEach((m) => {
      Object.values(m.bySide).forEach((side) => {
        const nk = side.name.trim().toLowerCase();
        if (!bySideName[nk]) bySideName[nk] = { name: side.name, entries: [] };
        bySideName[nk].entries.push(...side.entries);
      });
    });

    Object.values(bySideName).forEach((side) => {
      const uniqTraders = {};
      let stake = 0;
      side.entries.forEach((e) => { uniqTraders[e.trader] = true; stake += e.valueUsd; });
      const traderCount = Object.keys(uniqTraders).length;
      if (traderCount >= MIN_TRADERS && stake >= MIN_STAKE) {
        const key = members.map((m) => m.key).sort().join("+") + "|" + side.name.trim().toLowerCase();
        alerts.push({
          key, question: members[0].question, side: side.name,
          traders: Object.keys(uniqTraders).sort(), stake,
          urls: members.map((m) => m.marketUrl)
        });
      }
    });
  });
  return alerts;
}

// ---------- state (persisted to notify/state.json, committed back by the workflow) ----------
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch (e) { return {}; }
}
function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
}

// ---------- email ----------
function fmtUSD(n) {
  return new Intl.NumberFormat("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n) + " $";
}

async function sendEmail(alerts) {
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD }
  });
  const subject = alerts.length === 1
    ? "Corrélation Whales : " + alerts[0].question
    : "Corrélation Whales : " + alerts.length + " nouveaux trades suivis";
  const lines = alerts.map((a) =>
    `• ${a.question}\n  Camp : ${a.side}\n  Traders (${a.traders.length}) : ${a.traders.join(", ")}\n  Mise combinée : ${fmtUSD(a.stake)}\n  ${a.urls.filter(Boolean).join("\n  ")}`
  );
  const text = "Nouvelle(s) proposition(s) : au moins " + MIN_TRADERS + " traders sur le même camp, " + fmtUSD(MIN_STAKE) + "+ engagés.\n\n" + lines.join("\n\n");
  await withRetry(() => transporter.sendMail({ from: GMAIL_USER, to: NOTIFY_TO, subject, text }), { attempts: 3, delayMs: 2000 });
}

// ---------- main ----------
async function main() {
  if (!API_KEY) throw new Error("PREDICT_API_KEY manquant");
  const positions = await fetchAllWatchedPositions();
  const alerts = findAlerts(positions);
  const state = loadState();
  const fresh = alerts.filter((a) => !state[a.key]);

  if (fresh.length) {
    console.log(fresh.length + " nouvelle(s) alerte(s) :", fresh.map((a) => a.question + " / " + a.side));
    if (GMAIL_USER && GMAIL_APP_PASSWORD) {
      await sendEmail(fresh);
      console.log("Email envoyé à " + NOTIFY_TO);
    } else {
      console.log("GMAIL_USER / GMAIL_APP_PASSWORD absents — email non envoyé (secrets manquants).");
    }
  } else {
    console.log("Aucune nouvelle alerte (" + alerts.length + " active(s) au total).");
  }

  // Rebuild state from scratch each run, keyed only by currently-qualifying
  // bets — a bet that drops below threshold (closed, resolved, reduced) is
  // forgotten, so it can notify again if it re-qualifies later.
  const newState = {};
  alerts.forEach((a) => {
    newState[a.key] = state[a.key] || { firstSeen: new Date().toISOString(), question: a.question, side: a.side };
  });
  saveState(newState);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
