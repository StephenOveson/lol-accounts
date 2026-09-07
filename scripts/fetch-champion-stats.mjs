#!/usr/bin/env node
/**
 * Fetches each account's top 3 most-played champions and most probable
 * role for the current season, and writes data/champion-stats.json.
 *
 * Per account:
 *   1. account-v1 by-riot-id           -> puuid (same lookup fetch-ranked.mjs
 *      does; kept separate here so this script can run standalone/on its
 *      own schedule without depending on fetch-ranked.mjs's output).
 *   2. match-v5 matches/by-puuid/ids   -> up to MATCH_COUNT ranked match ids
 *      played since SEASON_START (type=ranked covers both Solo/Duo and Flex).
 *   3. match-v5 matches/{id}           -> one call per match id, to read
 *      this account's participant entry out of the match.
 *
 * "Top champions" = most games played this season (ties broken by win rate).
 * "Most probable role" = the teamPosition Riot recorded most often across
 * those matches (TOP/JUNGLE/MIDDLE/BOTTOM/UTILITY -> Top/Jungle/Mid/Bottom/
 * Support). A handful of very old matches can have an empty teamPosition;
 * those are just excluded from the role count rather than guessed at.
 *
 * This is a much heavier fetch than fetch-ranked.mjs (1 + MATCH_COUNT calls
 * per account instead of 2), so it runs on its own, less frequent, workflow
 * schedule rather than piggybacking on the 6-hourly rank sync.
 *
 *   RIOT_API_KEY=RGAPI-... node scripts/fetch-champion-stats.mjs
 */

import { mkdir, writeFile } from "node:fs/promises";
import { ACCOUNTS } from "./ranked-accounts.config.mjs";

const KEY = process.env.RIOT_API_KEY;
const OUT_PATH = process.env.OUT_PATH || "data/champion-stats.json";
const MATCH_COUNT = Number(process.env.MATCHES_PER_ACCOUNT || 50); // Riot caps a single request at 100
const SLEEP_MS = Number(process.env.RIOT_SLEEP_MS || 1300); // ~46 req/min, comfortably under the dev key's 100/2min cap

if (!KEY) {
  console.error("RIOT_API_KEY is not set.");
  process.exit(1);
}

// Jan 1 00:00 UTC of the current year — a simple, transparent definition of
// "this season." Override with SEASON_START_ISO if a mid-year ranked split
// boundary is ever wanted instead.
const SEASON_START = process.env.SEASON_START_ISO
  ? new Date(process.env.SEASON_START_ISO)
  : new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1));
const SEASON_START_SEC = Math.floor(SEASON_START.getTime() / 1000);

const REGIONAL = {
  na1: "americas", br1: "americas", la1: "americas", la2: "americas", oc1: "americas",
  euw1: "europe", eun1: "europe", tr1: "europe", ru: "europe",
  kr: "asia", jp1: "asia",
};

const ROLE_LABELS = {
  TOP: "Top",
  JUNGLE: "Jungle",
  MIDDLE: "Mid",
  BOTTOM: "Bottom",
  UTILITY: "Support",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function riot(url) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { "X-Riot-Token": KEY } });

    if (res.ok) return { ok: true, data: await res.json() };

    if (res.status === 401 || res.status === 403) {
      console.error(`Riot rejected the key (HTTP ${res.status}) on ${url.split("?")[0]}.`);
      console.error("Dev keys expire every 24h — refresh RIOT_API_KEY in repo secrets.");
      process.exit(1);
    }
    if (res.status === 404) return { ok: false, status: 404 };
    if (res.status === 429) {
      const wait = Number(res.headers.get("retry-after") || 1);
      await sleep((wait + 1) * 1000);
      continue;
    }
    if (res.status >= 500 && attempt < 3) {
      await sleep(2 ** attempt * 1000);
      continue;
    }
    return { ok: false, status: res.status };
  }
}

async function analyzeAccount({ docId, gameName, tagLine, platform }) {
  const regional = REGIONAL[platform];
  if (!regional) {
    return { docId, gameName, tagLine, error: `unknown platform "${platform}"` };
  }

  const acct = await riot(
    `https://${regional}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/` +
    `${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`
  );
  await sleep(SLEEP_MS);
  if (!acct.ok) {
    return { docId, gameName, tagLine, error: `account lookup ${acct.status}` };
  }
  const { puuid } = acct.data;

  const idsResp = await riot(
    `https://${regional}.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids` +
    `?type=ranked&startTime=${SEASON_START_SEC}&count=${MATCH_COUNT}`
  );
  await sleep(SLEEP_MS);
  if (!idsResp.ok) {
    return { docId, gameName, tagLine, error: `match id lookup ${idsResp.status}` };
  }
  const matchIds = idsResp.data;

  const champCounts = {}; // championName -> { games, wins }
  const roleCounts = {}; // teamPosition -> games
  let matchesRead = 0;

  for (const matchId of matchIds) {
    const match = await riot(`https://${regional}.api.riotgames.com/lol/match/v5/matches/${matchId}`);
    await sleep(SLEEP_MS);
    if (!match.ok) continue; // skip one bad match rather than failing the whole account

    const participant = match.data.info.participants.find((p) => p.puuid === puuid);
    if (!participant) continue;
    matchesRead++;

    const champ = participant.championName;
    champCounts[champ] = champCounts[champ] || { games: 0, wins: 0 };
    champCounts[champ].games++;
    if (participant.win) champCounts[champ].wins++;

    if (participant.teamPosition) {
      roleCounts[participant.teamPosition] = (roleCounts[participant.teamPosition] || 0) + 1;
    }
  }

  const topChampions = Object.entries(champCounts)
    .map(([championName, s]) => ({
      championName,
      games: s.games,
      wins: s.wins,
      winRate: Math.round((s.wins / s.games) * 100),
    }))
    .sort((a, b) => (b.games - a.games) || (b.winRate - a.winRate))
    .slice(0, 3);

  const topRole = Object.entries(roleCounts).sort((a, b) => b[1] - a[1])[0];
  const mainRole = topRole ? (ROLE_LABELS[topRole[0]] || topRole[0]) : null;

  return { docId, gameName, tagLine, matchesAnalyzed: matchesRead, topChampions, mainRole };
}

async function main() {
  const results = [];
  for (const account of ACCOUNTS) {
    const r = await analyzeAccount(account);
    if (r.error) console.warn(`${account.docId}: ${r.error}`);
    else console.log(`${account.docId}: ${r.matchesAnalyzed} matches, top ${r.topChampions.map((c) => c.championName).join(", ") || "(none)"}, role ${r.mainRole || "?"}`);
    results.push(r);
  }

  await mkdir("data", { recursive: true });
  await writeFile(
    OUT_PATH,
    JSON.stringify({ fetchedAt: new Date().toISOString(), seasonStart: SEASON_START.toISOString(), accounts: results }, null, 2)
  );
  console.log(`Wrote ${results.length} accounts to ${OUT_PATH}.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
