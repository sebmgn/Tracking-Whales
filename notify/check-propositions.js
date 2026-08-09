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

const NOTE_THRESHOLD = 7; // alert when a trade's note is strictly greater than this
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
  { name: "sbimbg", platform: "polymarket", address: "0xf5198df69e13937a40d1c76d6f72d9aa067d906b" },
  { name: "Boned", platform: "polymarket", address: "0x335d3dedf02b9884db93dc4c1a90cf578e598c00" },
  { name: "swisstony", platform: "polymarket", address: "0x204f72f35326db932158cba6adff0b9a1da95e14" },
  { name: "wapol", platform: "polymarket", address: "0xf7f0b0b1e9c0fe02ccad926916ee31aef74b912c" },
  { name: "0x2c33", platform: "polymarket", address: "0x2c335066fe58fe9237c3d3dc7b275c2a034a0563" },
  { name: "VeryLucky888", platform: "polymarket", address: "0x6d3c5bd13984b2de47c3a88ddc455309aab3d294" },
  { name: "RN1", platform: "polymarket", address: "0x2005d16a84ceefa912d4e380cd32e7ff827875ea" },
  { name: "GC-P", platform: "polymarket", address: "0x2d6ac4f70307102ac46e9e6ded67f3838ddf8add" },
  { name: "0xdbdd", platform: "polymarket", address: "0xdbdd45150249e229eb4ca8aa48a30dca21faa5de" },
  { name: "snakeball", platform: "polymarket", address: "0xc29198ad764bd6adaf7bb971a3757a689ece5d74" },
  { name: "NM-P", platform: "polymarket", address: "0xcf7379b4b891c06d88807f6f70efa75378120215" },
  { name: "ena", platform: "predict", address: "0x26b820772574b9EcC86cC632dE03f1bE346577c6" },
  // These 8 were added to positions.html's TRADERS in earlier sessions but
  // never mirrored here — WATCHED had silently drifted out of sync with the
  // site, meaning this alert script wasn't seeing their positions at all.
  { name: "tradecraft", platform: "polymarket", address: "0xde9f7f4e77a1595623ceb58e469f776257ccd43c" },
  { name: "anon", platform: "polymarket", address: "0x076daa87c4fe1a85402a9b6b8e0a866224388d4c" },
  { name: "trmc", platform: "polymarket", address: "0x42c99f38d2b951b0dc8e8bd5371fa80c9dd19623" },
  { name: "flatbarrel", platform: "polymarket", address: "0x6485f47d0344c03eb4340f985159f6eb2dcba265" },
  { name: "homerun", platform: "polymarket", address: "0x5268527977f700f9bf9b6d5cd843859e4e70135d" },
  { name: "malfunction", platform: "polymarket", address: "0xfc25f141ed27bb1787338d2c4e7f51e3a15e1f7f" },
  { name: "herdonia", platform: "polymarket", address: "0xd106952ebf30a3125affd8a23b6c1f30c35fc79c" },
  { name: "billbenter", platform: "polymarket", address: "0x84ad9c5c547a82ec9a08547b94bd922446e5bfb7" },
  { name: "0xa697", platform: "polymarket", address: "0xa697d0b3fff7d285a0f92d6ee03a7f97809e59d5" },
  { name: "0xd9e0", platform: "polymarket", address: "0xd9e0aaca471f489be338fd0f91a26e8669a805f2" },
  { name: "uptheblues", platform: "polymarket", address: "0x2a69660046d7acc4ab204d7cc5ba78b0776cd2f7" }
];

// Curated "trusted" subset — same list and same purpose as positions.html's
// RELIABLE_TRADERS, feeding the note's reliableAgreement factor.
const RELIABLE_TRADERS = ["JJJJ", "WsCz", "predict847", "swisstony", "RN1", "VeryLucky888"];

// ---------- note / score (ported verbatim from positions.html's unitScoreInfo,
// recalibrated 2026-08-08 against 20 hand-scored real-shaped examples — see
// the comment above positions.html's SCORE_WEIGHTS for the full rationale) ----------
const SCORE_WEIGHTS = {
  consensusRatio: 0.26,
  volumeConcentration: 0.24,
  reliableAgreement: 0.24,
  volume: 0.16,
  traderCount: 0.10
};
const SCORE_RANGES = {
  consensusRatio: [0.5, 1],
  volumeConcentration: [0.5, 1],
  volume: [3000, 50000],
  traderCount: [4, 9],
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
function consensusGate(normalized01, rampHi, floor) {
  const t = Math.max(0, Math.min(1, normalized01 / rampHi));
  return floor + (1 - floor) * t;
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
  const consensusRatio = traderCount > 0 ? leader.traderCount / traderCount : 0;

  const factors = {
    consensusRatio: normLinear(consensusRatio, SCORE_RANGES.consensusRatio),
    volumeConcentration: normLinear(volumeConcentration, SCORE_RANGES.volumeConcentration),
    volume: normLog(totalStake, SCORE_RANGES.volume),
    traderCount: normLinear(traderCount, SCORE_RANGES.traderCount),
    reliableAgreement: normLinear(reliableAgreeing, SCORE_RANGES.reliableAgreement)
  };
  const raw = factors.consensusRatio * SCORE_WEIGHTS.consensusRatio +
    factors.volumeConcentration * SCORE_WEIGHTS.volumeConcentration +
    factors.volume * SCORE_WEIGHTS.volume + factors.traderCount * SCORE_WEIGHTS.traderCount +
    factors.reliableAgreement * SCORE_WEIGHTS.reliableAgreement;
  // Weak consensus — by headcount OR by money — sinks the whole trade, not
  // just a handful of additive points (mirrors positions.html's gate).
  const gateHeadcount = consensusGate(factors.consensusRatio, 0.65, 0.45);
  const gateMoney = consensusGate(factors.volumeConcentration, 0.55, 0.24);
  const gate = gateHeadcount * gateMoney;
  const note = Math.round((1 + raw * 9 * gate) * 10) / 10;

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

// Best-effort current price, mirroring positions.html's currentPriceOf —
// simplified to skip the shares-based fallback (needs the raw share amount,
// not worth porting just for an email line) and fall back to the entry
// price instead, close enough for an alert rather than a live quote.
function predictCurrentPrice(p) {
  if (p.outcome && p.outcome.bestAsk && typeof p.outcome.bestAsk.price === "number") return p.outcome.bestAsk.price;
  return parseFloat(p.averageBuyPriceUsd) || 0;
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
    curPrice: predictCurrentPrice(p),
    marketUrl: market.categorySlug ? "https://predict.fun/market/" + market.categorySlug : "https://predict.fun"
  };
}

function normPoly(p, t) {
  const shares = p.size || 0;
  return {
    trader: t.name, platform: "polymarket", marketKey: "polymarket|" + p.conditionId,
    question: p.title || "—", slug: p.slug || p.eventSlug,
    outcomeKey: String(p.outcomeIndex), outcomeName: p.outcome || "—",
    valueUsd: p.currentValue || 0,
    curPrice: typeof p.curPrice === "number" ? p.curPrice : (shares > 0 ? (p.currentValue || 0) / shares : 0),
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

// Ported verbatim from positions.html's isFootball/FOOTBALL_SLUG_PREFIXES/
// NON_FOOTBALL_HINTS/FOOTBALL_KEYWORDS — alerts are football-only on
// request, so this needs to classify a market the same way the site does,
// not a separate looser heuristic that could drift from what the cards show.
const FOOTBALL_SLUG_PREFIXES = {
  fifwc: 1, ucl: 1, uel: 1, mls: 1, chi: 1, kor: 1, swe: 1, rou1: 1, epl: 1,
  laliga: 1, bundesliga: 1, seriea: 1, ligue1: 1, eredivisie: 1, brasileirao: 1,
  concacaf: 1, copa: 1,
  acn: 1, arg: 1, atc: 1, auc: 1, bl2: 1, bra: 1, bra2: 1, bul: 1, bun: 1,
  cde: 1, clf: 1, col: 1, col1: 1, cze1: 1, den: 1, ecu1: 1, efa: 1, egy1: 1,
  elc: 1, ere: 1, es2: 1, fif: 1, fl1: 1, lal: 1, lib: 1, mex: 1, nor: 1,
  per1: 1, por: 1, sclc: 1, scop: 1, sea: 1, spl: 1, srb: 1, sud: 1, tur: 1,
  uzb1: 1,
  aut: 1, bel1: 1, bol1: 1, brco: 1, cdr: 1, chi1: 1, chi2: 1, efl: 1,
  est1: 1, fin1: 1, fr2: 1, fro1: 1, hr1: 1, hun: 1, irl1: 1, isl1: 1,
  j1100: 1, j2100: 1, jap: 1, lec: 1, ltu1: 1, mar1: 1, ned2: 1, nor2: 1,
  pol: 1, rus: 1, slo: 1, svk1: 1, swe2: 1, tur2: 1, ukr1: 1, uru1: 1,
  uef: 1, usc: 1, argpn: 1, asean: 1, cof: 1, gtm: 1, nwsl: 1, ptc: 1
};
const NON_FOOTBALL_HINTS = /\bmlb\b|\bnba\b|\bwnba\b|\batp\b|\bwta\b|\bitf\b|\bnpb\b|\bkbo\b|\blol\b|\bdota ?2\b|\bcs2\b|valorant|\bufc\b|\bmma\b|grand prix|\bf1\b|\bnascar\b|drivers.? champion|open championship|\bgolf\b|world series|nba finals|nhl\b|nfl\b|\bcricket\b/i;
const FOOTBALL_KEYWORDS = /\bfc\b|fifa world cup|world cup golden|world cup winner|champions league|europa league|premier league|\bla liga\b|bundesliga|\bserie a\b|ligue 1|copa america|\buefa\b|\bmls\b/i;
function isFootball(question, slug) {
  const q = (question || "").toLowerCase();
  const s = (slug || "").toLowerCase();
  if (NON_FOOTBALL_HINTS.test(q) || NON_FOOTBALL_HINTS.test(s)) return false;
  const prefix = s.split("-")[0];
  if (FOOTBALL_SLUG_PREFIXES[prefix]) return true;
  if (FOOTBALL_KEYWORDS.test(q) || FOOTBALL_KEYWORDS.test(s)) return true;
  return false;
}
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

// ---------- kickoff time (same gamma-api lookup positions.html uses) ----------
// Predict.fun's market object carries no kickoff field at all — only
// Polymarket's gamma-api has a real one (event.startTime / a market's own
// gameStartTime), keyed by the same slug prefix matchKeyFromSlug already
// computes for cross-platform linking. A Predict.fun-only alert (no
// matching Polymarket event) simply gets no kickoff line rather than a
// fabricated one.
const GAMMA_EVENTS_BASE = "https://gamma-api.polymarket.com/events";
async function fetchKickoff(matchKey) {
  if (!matchKey) return null;
  try {
    const events = await fetchJson(GAMMA_EVENTS_BASE + "?slug=" + encodeURIComponent(matchKey));
    const ev = events && events[0];
    const market0 = ev && ev.markets && ev.markets[0];
    const raw = (ev && ev.startTime) || (market0 && market0.gameStartTime);
    if (!raw) return null;
    const d = new Date(raw);
    return isNaN(d.getTime()) ? null : d;
  } catch (e) {
    return null; // best-effort — a failed lookup just means no kickoff line, not a broken alert
  }
}
// Only alert for bets on events that haven't started yet — a trade whose
// match is already live isn't a "here's a proposition to consider" moment
// the way an upcoming one is. Falls back to the day extracted from the
// matchKey itself (mirrors positions.html's own day-level fallback) when
// gamma-api has no precise kickoff for it; a same-day match with no precise
// time is treated as too uncertain to call "upcoming" and excluded, same as
// anything dated today-or-earlier. A matchKey with no date at all (a
// non-time-bound outright/futures market) isn't "in progress" the way a
// live match is, so it's let through rather than suppressed.
const MATCH_DATE_RE = /(\d{4})-(\d{2})-(\d{2})/;
function isUpcoming(a) {
  if (a.kickoff) return a.kickoff.getTime() > Date.now();
  const m = (a.matchKey || "").match(MATCH_DATE_RE);
  if (!m) return true;
  const day = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  return day.getTime() > todayStart.getTime();
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
    g.bySide[p.outcomeKey].entries.push({ trader: p.trader, valueUsd: p.valueUsd, curPrice: p.curPrice });
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
    if (!isFootball(members[0].question, members[0].slug)) return; // football-only alerts, on request

    const key = members.map((m) => m.key).sort().join("+");
    // One block per camp (leader first, then every side that actually has
    // qualifying traders on it) — same shape for each, so the email can
    // print them identically instead of treating the leader specially and
    // the rest as an afterthought summary.
    const campOf = (side) => {
      const stakeByTrader = {};
      side.entries.forEach((e) => { stakeByTrader[e.trader] = (stakeByTrader[e.trader] || 0) + e.valueUsd; });
      const traders = Object.keys(stakeByTrader)
        .map((trader) => ({ trader, stake: stakeByTrader[trader] }))
        .sort((a, b) => b.stake - a.stake);
      // Stake-weighted current price across this camp's own entries — the
      // same "cote actuelle" concept the site shows on the leader badge,
      // just computed locally here since the notify script keeps its own
      // copy of the scoring/aggregation logic.
      const priced = side.entries.filter((e) => typeof e.curPrice === "number" && e.curPrice > 0);
      const pricedStake = priced.reduce((s, e) => s + e.valueUsd, 0);
      const avgPrice = pricedStake > 0 ? priced.reduce((s, e) => s + e.curPrice * e.valueUsd, 0) / pricedStake : null;
      return { name: side.name, traderCount: traders.length, stake: side.stake, avgPrice, traders };
    };
    const camps = unit.mergedSides.filter((s) => s.traderCount > 0).map(campOf);

    alerts.push({
      key, question: members[0].question, side: unit.leader.name, note: unit.note,
      matchKey: members[0].matchKey,
      camps,
      urls: members.map((m) => ({ platform: m.platform, url: m.marketUrl }))
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
function fmtCents(p) {
  return (p * 100).toFixed(1) + "¢";
}
const PLATFORM_LABELS = { polymarket: "Polymarket", predict: "Predict.fun" };

// One trade per email — main() calls this once per fresh alert rather than
// batching a run's alerts into one digest, so each email's subject/body is
// about exactly one bet.
async function sendEmail(alerts) {
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD }
  });
  const a = alerts[0];
  // The note goes in the subject itself (not just the body) so it's visible
  // from a notification banner / inbox list without opening the email.
  const subject = `Corrélation Whales [Note ${a.note.toFixed(1)}] : ${a.question}`;
  // Best-effort — no line at all when gamma-api has no matching event
  // (Predict.fun-only alert) rather than printing a blank/fabricated time.
  const kickoffLine = a.kickoff
    ? `\nDébut de l'événement : ${a.kickoff.toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" })}`
    : "";
  // One block per camp, same shape each time (name / traders / volume,
  // then one line per trader with their own stake) — leader camp first,
  // a blank line between camps instead of the leader getting the full
  // detail and the rest just a one-line summary.
  const campBlocks = a.camps.map((c, i) => {
    const label = i === 0 ? "Camp 1 (leader)" : (a.camps.length === 2 ? "Camp adverse" : `Camp ${i + 1} (adverse)`);
    const priceText = c.avgPrice != null ? ` — cote actuelle ${fmtCents(c.avgPrice)}` : "";
    const traderLines = c.traders.map((t) => `  - ${t.trader} : ${fmtUSD(t.stake)}`).join("\n");
    return `${label} : ${c.name} ; ${c.traderCount} trader${c.traderCount > 1 ? "s" : ""} ; ${fmtUSD(c.stake)}${priceText}\n${traderLines}`;
  });
  const linkLines = a.urls.filter((u) => u.url).map((u) => `${PLATFORM_LABELS[u.platform] || u.platform} : ${u.url}`).join("\n");
  const text = `Nouvelle proposition : note > ${NOTE_THRESHOLD}/10 (même formule que le site).\n\n` +
    `[Note ${a.note.toFixed(1)}] ${a.question}${kickoffLine}\n\n${campBlocks.join("\n\n")}\n\n${linkLines}`;
  await withRetry(() => transporter.sendMail({ from: GMAIL_USER, to: NOTIFY_TO, subject, text }), { attempts: 3, delayMs: 2000 });
}

// ---------- main ----------
async function main() {
  if (!API_KEY) throw new Error("PREDICT_API_KEY manquant");
  const positions = await fetchAllWatchedPositions();
  const alerts = findAlerts(positions);
  const state = loadState();
  const freshCandidates = alerts.filter((a) => !state[a.key]);
  // Only for the ones that might actually get emailed, not every active
  // alert — no point spending gamma-api calls on bets the recipient's
  // already been notified about.
  await Promise.all(freshCandidates.map(async (a) => { a.kickoff = await fetchKickoff(a.matchKey); }));
  // Candidates whose event already started are deliberately left OUT of
  // `fresh` (and, below, out of newState too) rather than being emailed —
  // a live match never becomes "upcoming" again, so it'll just keep getting
  // silently re-skipped every run until it drops out of the tracked feed
  // entirely, with no email ever sent for it.
  const skippedLive = freshCandidates.filter((a) => !isUpcoming(a));
  const fresh = freshCandidates.filter(isUpcoming);
  if (skippedLive.length) {
    console.log(skippedLive.length + " alerte(s) ignorée(s) (événement déjà en cours) :", skippedLive.map((a) => "[" + a.note.toFixed(1) + "] " + a.question));
  }

  if (fresh.length) {
    console.log(fresh.length + " nouvelle(s) alerte(s) :", fresh.map((a) => "[" + a.note.toFixed(1) + "] " + a.question + " / " + a.side));
    if (GMAIL_USER && GMAIL_APP_PASSWORD) {
      // One email per trade, sent in sequence (not Promise.all — a shared
      // nodemailer transporter over Gmail is safer sent one at a time than
      // fired concurrently) — even if several trades cross the threshold in
      // the same run, each gets its own subject/body instead of being
      // folded into one digest.
      for (const a of fresh) {
        await sendEmail([a]);
        console.log("Email envoyé à " + NOTIFY_TO + " — [" + a.note.toFixed(1) + "] " + a.question);
      }
    } else {
      console.log("GMAIL_USER / GMAIL_APP_PASSWORD absents — email non envoyé (secrets manquants).");
    }
  } else {
    console.log("Aucune nouvelle alerte (" + alerts.length + " active(s) au total, note > " + NOTE_THRESHOLD + ").");
  }

  // Rebuild state from scratch each run, keyed only by currently-qualifying
  // bets — a bet that drops below threshold (closed, resolved, reduced, or
  // its note simply drops back to <= NOTE_THRESHOLD) is forgotten, so it can
  // notify again if it re-qualifies later. skippedLive bets are deliberately
  // left OUT of newState (not just out of the email) — they were never
  // actually notified about, so the next run should check them again rather
  // than silently treating "we decided not to email this" the same as "the
  // recipient already knows about this."
  const newState = {};
  alerts.forEach((a) => {
    if (skippedLive.indexOf(a) !== -1) return;
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
