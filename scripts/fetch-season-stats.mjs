#!/usr/bin/env node
/**
 * Builds per-champion games/wins for the tracked season from Match-V5, and picks
 * each summoner's top 3.
 *
 * Riot has no per-champion winrate endpoint, so this is a fan-out: one request
 * per match. That is expensive enough that the run MUST be incremental — the
 * aggregate is committed to the repo and later runs only fetch matches they
 * haven't seen. First run backfills the season; patch-day runs cost a handful
 * of requests.
 *
 * Two Riot quirks are worked around here rather than trusted:
 *   1. /ids caps at 1000 results (start=1000 returns []). Fine incrementally,
 *      but a first-run backfill on a heavy season will truncate — we detect and
 *      report it instead of silently under-counting.
 *   2. startTime is documented but currently unreliable (dev-relations #1134),
 *      returning matches outside the window. Every match is re-checked against
 *      SEASON_START using gameStartTimestamp from the match body.
 */

import { readFile, writeFile } from "node:fs/promises";
import { QUEUES, SEASON_START_EPOCH, MIN_GAMES } from "./roster.config.mjs";

// Only the secret comes from the environment. Everything else is committed
// config, so a change to the season window shows up in a diff and in review
// rather than living in a workflow's env block where nobody sees it change.
const KEY = process.env.RIOT_API_KEY;
const STATE_PATH = process.env.STATE_PATH || "data/season-stats.json";

const SEASON_START = SEASON_START_EPOCH; // epoch SECONDS
const CONFIDENCE_Z = 1.96;

if (!KEY) { console.error("RIOT_API_KEY is not set."); process.exit(1); }
if (!SEASON_START) { console.error("SEASON_START_EPOCH is not set in roster.config.mjs."); process.exit(1); }

const REGIONAL = {
  na1: "americas", br1: "americas", la1: "americas", la2: "americas",
  euw1: "europe", eun1: "europe", tr1: "europe", ru: "europe",
  kr: "asia", jp1: "asia",
  oc1: "sea", ph2: "sea", sg2: "sea", th2: "sea", tw2: "sea", vn2: "sea",
};

// --- transport -------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let spent = 0;

async function riot(url, { tolerate404 = false } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { "X-Riot-Token": KEY } });
    spent++;

    if (res.ok) return res.json();

    if (res.status === 401 || res.status === 403) {
      // Dev keys expire every 24h — in a scheduled job this is the usual failure.
      console.error(`Riot rejected the key (HTTP ${res.status}). Use a personal or production key.`);
      process.exit(1);
    }
    if (res.status === 404 && tolerate404) return null; // match aged out of retention
    if (res.status === 429) {
      const wait = Number(res.headers.get("retry-after") || 1);
      await sleep((wait + 1) * 1000);
      continue;
    }
    if (res.status >= 500 && attempt < 3) { await sleep(2 ** attempt * 1000); continue; }

    throw new Error(`${res.status} on ${url.replace(/\/[\w-]{60,}/g, "/<puuid>")}`);
  }
}

// --- ranking ---------------------------------------------------------------

/**
 * Wilson score lower bound.
 *
 * Ranking by raw winrate is wrong here: a 1-for-1 champion shows 100% and beats
 * a 62%-over-40-games main. Wilson penalises small samples by asking "what is
 * the lowest winrate consistent with this record?", so volume and rate are
 * traded off in one number instead of needing an arbitrary tiebreak.
 */
function wilsonLower(wins, games) {
  if (!games) return 0;
  const p = wins / games;
  const z = CONFIDENCE_Z, z2 = z * z;
  const denom = 1 + z2 / games;
  const centre = p + z2 / (2 * games);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * games)) / games);
  return (centre - margin) / denom;
}

function topThree(champions, byKey) {
  return Object.entries(champions)
    .filter(([, s]) => s.games >= MIN_GAMES)
    .map(([championId, s]) => ({
      id: byKey[championId]?.id ?? null,       // "Jayce" — joins to the roster row
      name: byKey[championId]?.name ?? `#${championId}`,
      games: s.games,
      wins: s.wins,
      winrate: s.wins / s.games,
      score: wilsonLower(s.wins, s.games),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
}

// --- aggregation -----------------------------------------------------------

async function loadState() {
  try { return JSON.parse(await readFile(STATE_PATH, "utf8")); }
  catch { return { seasonStart: SEASON_START, summoners: {} }; }
}

async function resolvePuuid(riotId, regional) {
  const hash = riotId.lastIndexOf("#");
  if (hash < 1) throw new Error(`Malformed Riot ID "${riotId}" — expected Name#TAG`);
  const account = await riot(
    `https://${regional}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/` +
    `${encodeURIComponent(riotId.slice(0, hash))}/${encodeURIComponent(riotId.slice(hash + 1))}`
  );
  return account?.puuid ?? null;
}

async function collectMatchIds(puuid, regional, seen) {
  const ids = [];
  let truncated = false;

  for (const queue of QUEUES) {
    for (let start = 0; start < 1000; start += 100) {
      const page = await riot(
        `https://${regional}.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids` +
        `?queue=${queue}&startTime=${SEASON_START}&start=${start}&count=100`
      );
      if (!page?.length) break;

      const fresh = page.filter((id) => !seen.has(id));
      ids.push(...fresh);

      // Every id on this page is already aggregated — older pages will be too.
      if (!fresh.length) break;
      if (page.length < 100) break;
      if (start === 900) truncated = true; // hit the 1000 ceiling with more to come
    }
  }
  return { ids, truncated };
}

export async function fetchSeasonStats(summoners, byKey) {
  const state = await loadState();

  // A new season invalidates everything. Explicit reset beats a stale carry-over.
  if (state.seasonStart !== SEASON_START) {
    console.log(`Season boundary changed — discarding prior aggregate.`);
    state.seasonStart = SEASON_START;
    state.summoners = {};
  }

  const out = [];

  for (const { riotId, platform } of summoners) {
    const regional = REGIONAL[platform];
    if (!regional) throw new Error(`Unknown platform "${platform}" for ${riotId}`);

    const prior = state.summoners[riotId] ?? { champions: {}, processed: [] };
    const puuid = prior.puuid ?? (await resolvePuuid(riotId, regional));
    if (!puuid) {
      console.warn(`skip: ${riotId} did not resolve on ${regional}`);
      out.push({ riotId, platform, top: null });
      continue;
    }

    const seen = new Set(prior.processed);
    const { ids, truncated } = await collectMatchIds(puuid, regional, seen);
    if (truncated) console.warn(`${riotId}: hit the 1000-match ceiling — season totals are a floor.`);

    let added = 0;
    for (const matchId of ids) {
      const match = await riot(
        `https://${regional}.api.riotgames.com/lol/match/v5/matches/${matchId}`,
        { tolerate404: true }
      );
      seen.add(matchId);
      if (!match) continue; // aged out of retention; id lists outlive the data

      const info = match.info;
      // startTime is unreliable upstream — enforce the window ourselves.
      if (Math.floor(info.gameStartTimestamp / 1000) < SEASON_START) continue;

      const me = info.participants.find((p) => p.puuid === puuid);
      if (!me) continue;

      // Remakes are not games. Both signals appear; check each.
      if (me.gameEndedInEarlySurrender || info.gameDuration < 300) continue;

      const bucket = (prior.champions[me.championId] ??= { games: 0, wins: 0 });
      bucket.games++;
      if (me.win) bucket.wins++;
      added++;
    }

    // The processed list is bounded by Riot's own 1000-id ceiling, so it can't grow without limit.
    state.summoners[riotId] = {
      puuid,
      champions: prior.champions,
      processed: [...seen],
      updatedAt: new Date().toISOString(),
    };

    console.log(`${riotId}: +${added} new matches (${spent} requests so far)`);

    out.push({
      riotId,
      platform,
      truncated,
      // PUUID stays in the state file, never in the artifact — it's a stable
      // player identifier and the artifact is publicly shareable.
      top: topThree(prior.champions, byKey),
    });
  }

  await writeFile(STATE_PATH, JSON.stringify(state, null, 2));
  console.log(`Done — ${spent} Riot requests this run.`);
  return out;
}

export function indexByKey(championJson) {
  const byKey = {};
  for (const c of Object.values(championJson.data)) byKey[c.key] = { id: c.id, name: c.name };
  return byKey;
}
