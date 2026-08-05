// Scheduled watcher (runs via GitHub Actions, not the local PC): alerts by
// email when a real-world bet's "note" (the same 1-10 blended score
// positions.html computes for every Value Trade card — volume
// concentration, total volume, trader count, agreement, and agreement
// among the curated RELIABLE_TRADERS list) is strictly greater than
// NOTE_THRESHOLD. Used to be a flat "at least 4 of our 4 watched traders on
// the same side, $1000+ each" rule — that only worked because WATCHED
// happened to equal RELIABLE_TRADERS in size; the note is the real signal
// the site itself surfaces, so WATCHED now mirrors positions.html's full
// TRADERS roster and the same scoring formula runs here, verbatim.
// State is persisted to state.json (committed back to the repo each run) so
// an already-notified bet doesn't re-trigger every 15 minutes — only bets
// that newly cross the note threshold send an email.
"use strict";

const fs = require("fs");
const path = require("path");
const nodemailer = require("nodemailer");

const API_KEY = process.env.PREDICT_API_KEY;
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
const NOTIFY_TO = process.env.NOTIFY_TO || GMAIL_USER;

const NOTE_THRESHOLD = 6; // alert when a trade's note is strictly greater than this
// Dust floor — a position staking less than this is dropped from a side's
// counts/totalStake entirely before scoring, mirroring positions.html's
// own MIN_TRADER_STAKE so a handful of $10 positions can't inflate a note.
const MIN_TRADER_STAKE = 300;
// On the site, the note is only ever computed for markets that already
// cleared the "Value Trade" bar (positions.html's fixed vtMinTraders — see
// its own comment: ">=4 traders is the lowest selectable floor", default
// left on 5). Skipping that pre-filter here scored every incidental 1-3
// trader overlap across the full 26-trader roster too — those get
// volumeConcentration=1.0 for free (single-sided, no opposing tracked
// activity, which is the overwhelming common case) and can clear
// NOTE_THRESHOLD on stake alone, which is how one run turned into a flood
// of alerts instead of the handful of genuine ones the site itself shows.
const MIN_UNIT_TRADERS = 5;
const STATE_FILE = path.join(__dirname, "state.json");

// Same roster as positions.html's TRADERS — the note formula's traderCount/
// agreement factors are normalized against ranges tuned for this full list
// (see SCORE_RANGES below), so watching a narrower set would systematically
// under-score every trade relative to what the site itself shows for it.
const WATCHED = [
  { name: "predict847", platform: "predict", address: "0x21f861D43B2E2E05F9974D1a27d0c8959e59a1F8" },
  { name: "JJJJ", platform: "predict", address: "0x8Ad2C531324567a4008D9e2BCcC59CC5C8fcFC25" },
  { name: "WsCz", platform: "predict", address: "0x51925155f83E155592825b96AC5887505Af0aCD8" },
  { name: "deliveries_0nly", platform: "predict", address: "0xa635c0DFB1c5c9D8929250a8b1449C7D465F5496" },
  { name: "jinwen818", platform: "predict", address: "0xDF3C3AD54B9506228f527dAd2413EF3f51A3A7CE" },
  { name: "meister", platform: "polymarket", address: "0xdc4f58a48ed4467743609fdce11eea483c759804" },
  { name: "aaaaaaa9", platform: "predict", address: "0x1faa0851074eCd1Baa4744Dbb43F9b10E2EFd636" },
  { name: "mean-slippage-run", platform: "predict", address: "0x10F75A07837E4Af8B77182383443895cA7520747" },
  { name: "sbimbg", platform: "polymarket", address: "0xf5198df69e13937a40d1c76d6f72d9aa067d906b" },
  { name: "CandleHammerDrums", platform: "polymarket", address: "0x7c1ee865a785de4c00ee90ed86a38489fb8bbab3" },
  { name: "Boned", platform: "polymarket", address: "0x335d3dedf02b9884db93dc4c1a90cf578e598c00" },
  { name: "juanitooo12358", platform: "polymarket", address: "0xecdb673d790f2469f1bd9b87841ff17e6b18c4c7" },
  { name: "swisstony", platform: "polymarket", address: "0x204f72f35326db932158cba6adff0b9a1da95e14" },
  { name: "wapol", platform: "polymarket", address: "0xf7f0b0b1e9c0fe02ccad926916ee31aef74b912c" },
  { name: "8a7sh2", platform: "polymarket", address: "0xbdb0e406400033ada6ffe03f8915b5e23873f8ba" },
  { name: "0x2c33", platform: "polymarket", address: "0x2c335066fe58fe9237c3d3dc7b275c2a034a0563" },
  { name: "VeryLucky888", platform: "polymarket", address: "0x6d3c5bd13984b2de47c3a88ddc455309aab3d294" },
  { name: "RN1", platform: "polymarket", address: "0x2005d16a84ceefa912d4e380cd32e7ff827875ea" },
  { name: "zaizoibele", platform: "polymarket", address: "0xc23dc0eca9e1c2e293de8911b9ac254f0bcd82c8" },
  { name: "GC-P", platform: "polymarket", address: "0x2d6ac4f70307102ac46e9e6ded67f3838ddf8add" },
  { name: "0xdbdd", platform: "polymarket", address: "0xdbdd45150249e229eb4ca8aa48a30dca21faa5de" },
  { name: "newbie", platform: "polymarket", address: "0x43011bc04df353c8092662d13b4aaacb4b62ac39" },
  { name: "snakeball", platform: "polymarket", address: "0xc29198ad764bd6adaf7bb971a3757a689ece5d74" },
  { name: "NM-P", platform: "polymarket", address: "0xcf7379b4b891c06d88807f6f70efa75378120215" },
  { name: "ena", platform: "predict", address: "0x26b820772574b9EcC86cC632dE03f1bE346577c6" },
  { name: "newteam", platform: "polymarket", address: "0xc46368a3374e87566eff1ffae7e6ec0163509a2f" }
];

// Curated "trusted" subset — same list and same purpose as positions.html's
// RELIABLE_TRADERS, feeding the note's reliableAgreement factor.
const RELIABLE_TRADERS = ["JJJJ", "WsCz", "predict847", "swisstony", "RN1", "zaizoibele", "VeryLucky888"];

// ---------- note / score (ported verbatim from positions.html's unitScoreInfo) ----------
const SCORE_WEIGHTS = {
  volumeConcentration: 0.35,
  reliableAgreement: 0.25,
  volume: 0.15,
  agreement: 0.15,
  traderCount: 0.10
};
const SCORE_RANGES = {
  volumeConcentration: [0.5, 1],
  volume: [3000, 50000],
  traderCount: [4, 9],
  agreement: [1, 9],
  reliableAgreement: [0, RELIABLE_TRADERS.length]
};
function normLinear(value, range) {
  const lo = range[0], hi = range[1];
  if (hi <= lo) return 0;
  return Math.max(0, Math.min(1, (value - lo) / (hi - lo)));
}
function normLog(value, range) {
  const lo = Math.max(1, range[0]), hi = Math.max(lo + 1, range[1]);
  const v = Math.max(1, value);
  return Math.max(0, Math.min(1, (Math.log10(v) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo))));
}
// Merges a linked unit's sides by outcome name (mirrors positions.html's
// mergeUnitSides), scores the leading side's concentration/agreement, and
// blends the same five weighted factors into a 1-10 note.
function computeUnit(members) {
  const totalStake = members.reduce((s, m) => s + m.totalStake, 0);
  const traderCount = members.reduce((s, m) => s + m.traderSet.size, 0);

  const byName = {};
  const order = [];
  members.forEach((m) => {
    Object.values(m.bySide).forEach((side) => {
      const key = side.name.trim().toLowerCase();
      if (!byName[key]) { byName[key] = { name: side.name, traderCount: 0, stake: 0, entries: [] }; order.push(key); }
      const slot = byName[key];
      const uniqTraders = new Set(side.entries.map((e) => e.trader));
      slot.traderCount += uniqTraders.size;
      slot.stake += side.entries.reduce((s, e) => s + e.valueUsd, 0);
      slot.entries.push(...side.entries);
    });
  });
  const mergedSides = order.map((k) => byName[k]).sort((a, b) => b.traderCount - a.traderCount || b.stake - a.stake);
  const leader = mergedSides[0] || null;
  if (!leader) return { note: 1, leader: null, mergedSides: [] };

  const leaderTraderNames = new Set(leader.entries.map((e) => e.trader));
  const reliableAgreeing = RELIABLE_TRADERS.reduce((n, name) => n + (leaderTraderNames.has(name) ? 1 : 0), 0);
  const volumeConcentration = totalStake > 0 ? leader.stake / totalStake : 0;

  const factors = {
    volumeConcentration: normLinear(volumeConcentration, SCORE_RANGES.volumeConcentration),
    volume: normLog(totalStake, SCORE_RANGES.volume),
    traderCount: normLinear(traderCount, SCORE_RANGES.traderCount),
    agreement: normLinear(leader.traderCount, SCORE_RANGES.agreement),
    reliableAgreement: normLinear(reliableAgreeing, SCORE_RANGES.reliableAgreement)
  };
  const raw = factors.volumeConcentration * SCORE_WEIGHTS.volumeConcentration +
    factors.volume * SCORE_WEIGHTS.volume + factors.traderCount * SCORE_WEIGHTS.traderCount +
    factors.agreement * SCORE_WEIGHTS.agreement + factors.reliableAgreement * SCORE_WEIGHTS.reliableAgreement;
  const note = Math.round((1 + raw * 9) * 10) / 10;

  return { note, leader, mergedSides };
}

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

// ---------- group positions by market, link across platforms, score, evaluate the rule ----------
function findAlerts(positions) {
  const groups = {};
  positions.forEach((p) => {
    if (!groups[p.marketKey]) {
      groups[p.marketKey] = {
        key: p.marketKey, platform: p.platform, question: p.question, slug: p.slug, marketUrl: p.marketUrl,
        bySide: {}, traderSet: new Set(), totalStake: 0
      };
    }
    const g = groups[p.marketKey];
    if (p.valueUsd < MIN_TRADER_STAKE) return; // dust — dropped from scoring, mirrors positions.html
    g.traderSet.add(p.trader);
    g.totalStake += p.valueUsd;
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
    const traderCount = members.reduce((s, m) => s + m.traderSet.size, 0);
    if (traderCount < MIN_UNIT_TRADERS) return;

    const unit = computeUnit(members);
    if (!unit.leader || unit.note <= NOTE_THRESHOLD) return;

    const key = members.map((m) => m.key).sort().join("+");
    const leaderStakeByTrader = {};
    unit.leader.entries.forEach((e) => { leaderStakeByTrader[e.trader] = (leaderStakeByTrader[e.trader] || 0) + e.valueUsd; });
    const traders = Object.keys(leaderStakeByTrader)
      .map((trader) => ({ trader, stake: leaderStakeByTrader[trader] }))
      .sort((a, b) => b.stake - a.stake);
    const opposingSides = unit.mergedSides.filter((s) => s !== unit.leader && s.traderCount > 0);

    alerts.push({
      key, question: members[0].question, side: unit.leader.name, note: unit.note,
      traders, stake: unit.leader.stake,
      opposingSides: opposingSides.map((s) => s.name + " (" + s.traderCount + ")"),
      urls: members.map((m) => m.marketUrl)
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
  const sorted = alerts.slice().sort((a, b) => b.note - a.note);
  // The note goes in the subject itself (not just the body) so it's visible
  // from a notification banner / inbox list without opening the email.
  const subject = sorted.length === 1
    ? `Corrélation Whales [Note ${sorted[0].note.toFixed(1)}] : ${sorted[0].question}`
    : `Corrélation Whales : ${sorted.length} trades notés > ${NOTE_THRESHOLD} (meilleure note ${sorted[0].note.toFixed(1)})`;
  const lines = sorted.map((a) => {
    const traderLines = a.traders.map((t) => `    - ${t.trader} : ${fmtUSD(t.stake)}`).join("\n");
    const oppLine = a.opposingSides.length ? `\n  Camp d'en face : ${a.opposingSides.join(", ")}` : "";
    return `• [Note ${a.note.toFixed(1)}] ${a.question}\n  Camp : ${a.side} (${a.traders.length} traders)\n${traderLines}${oppLine}\n  Mise combinée (camp leader) : ${fmtUSD(a.stake)}\n  ${a.urls.filter(Boolean).join("\n  ")}`;
  });
  const text = `Nouvelle(s) proposition(s) : note > ${NOTE_THRESHOLD}/10 (même formule que le site).\n\n` + lines.join("\n\n");
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
    console.log(fresh.length + " nouvelle(s) alerte(s) :", fresh.map((a) => "[" + a.note.toFixed(1) + "] " + a.question + " / " + a.side));
    if (GMAIL_USER && GMAIL_APP_PASSWORD) {
      await sendEmail(fresh);
      console.log("Email envoyé à " + NOTIFY_TO);
    } else {
      console.log("GMAIL_USER / GMAIL_APP_PASSWORD absents — email non envoyé (secrets manquants).");
    }
  } else {
    console.log("Aucune nouvelle alerte (" + alerts.length + " active(s) au total, note > " + NOTE_THRESHOLD + ").");
  }

  // Rebuild state from scratch each run, keyed only by currently-qualifying
  // bets — a bet that drops below threshold (closed, resolved, reduced, or
  // its note simply drops back to <= NOTE_THRESHOLD) is forgotten, so it can
  // notify again if it re-qualifies later.
  const newState = {};
  alerts.forEach((a) => {
    newState[a.key] = state[a.key] || { firstSeen: new Date().toISOString(), question: a.question, side: a.side, note: a.note };
  });
  saveState(newState);
}

main().catch((err) => {
  console.error(err);
  // Surface the real error as a GitHub Actions annotation — readable from
  // the run's "Annotations" panel (and the public API) without needing to
  // sign in to view the raw job logs.
  const msg = (err && err.message ? err.message : String(err)).replace(/\n/g, " ");
  console.log("::error::" + msg);
  process.exit(1);
});
