#!/usr/bin/env node
/**
 * Fetches current ranked solo/duo tier, division, LP, and win rate for each
 * account in ranked-accounts.config.mjs and writes data/ranked.json.
 *
 * Two Riot API calls per account:
 *   1. account-v1 by-riot-id  -> puuid
 *   2. league-v4 entries/by-puuid -> ranked entries (filtered to queue 420)
 *
 * league-v4's older entries/by-summoner/{summonerId} route came back 403 on
 * this key even with a valid summonerId (a known rough edge — see Riot
 * developer-relations issue #1029). by-puuid is the route that actually
 * works, and Riot's own guidance is to prefer puuid-based lookups anyway, so
 * summoner-v4 is skipped entirely — one fewer call, one fewer thing to break.
 *
 *   RIOT_API_KEY=RGAPI-... node scripts/fetch-ranked.mjs
 */

import { mkdir, writeFile } from "node:fs/promises";
import { ACCOUNTS } from "./ranked-accounts.config.mjs";

const KEY = process.env.RIOT_API_KEY;
const OUT_PATH = process.env.OUT_PATH || "data/ranked.json";

if (!KEY) {
  console.error("RIOT_API_KEY is not set.");
  process.exit(1);
}

const REGIONAL = {
  na1: "americas", br1: "americas", la1: "americas", la2: "americas", oc1: "americas",
  euw1: "europe", eun1: "europe", tr1: "europe", ru: "europe",
  kr: "asia", jp1: "asia",
};

// Display names for league-v4 queueTypes. An unrecognized queueType (Riot
// adding a new one) falls back to its raw string rather than being dropped,
// so a new queue shows up labeled oddly instead of silently vanishing.
const QUEUE_LABELS = {
  RANKED_SOLO_5x5: "Solo/Duo",
  RANKED_FLEX_SR: "Flex",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function riot(url) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { "X-Riot-Token": KEY } });

    if (res.ok) return { ok: true, data: await res.json() };

    if (res.status === 401 || res.status === 403) {
      // Dev keys expire every 24h — in a scheduled job this IS the usual
      // failure mode, not an edge case. Fail the whole run loudly rather
      // than silently writing a partial/stale file: a red Action is the
      // signal that the RIOT_API_KEY secret needs a fresh key.
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

async function lookup({ docId, gameName, tagLine, platform }) {
  const regional = REGIONAL[platform];
  if (!regional) {
    return { docId, gameName, tagLine, error: `unknown platform "${platform}"` };
  }

  const acct = await riot(
    `https://${regional}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/` +
    `${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`
  );
  if (!acct.ok) {
    return { docId, gameName, tagLine, error: `account lookup ${acct.status}` };
  }
  const { puuid } = acct.data;

  const league = await riot(
    `https://${platform}.api.riotgames.com/lol/league/v4/entries/by-puuid/${puuid}`
  );
  if (!league.ok) {
    return { docId, gameName, tagLine, error: `league lookup ${league.status}` };
  }

  // "ranks" carries every queue Riot actually returned an entry for — a
  // queue the account has never queued into (usually Flex) just isn't in
  // league.data, so it isn't in this array either. The top-level
  // tier/division/leaguePoints/winRate mirror Solo/Duo specifically, kept
  // for sorting and the summary stats, which only ever cared about the
  // primary queue.
  const toRank = (e) => ({
    queueType: e.queueType,
    label: QUEUE_LABELS[e.queueType] || e.queueType,
    tier: e.tier,
    division: e.rank,
    leaguePoints: e.leaguePoints,
    winRate: Math.round((e.wins / (e.wins + e.losses)) * 100),
  });

  const ranks = league.data.map(toRank);
  const solo = league.data.find((e) => e.queueType === "RANKED_SOLO_5x5");

  return {
    docId,
    gameName,
    tagLine,
    tier: solo ? solo.tier : "UNRANKED",
    division: solo ? solo.rank : "",
    leaguePoints: solo ? solo.leaguePoints : 0,
    winRate: solo ? Math.round((solo.wins / (solo.wins + solo.losses)) * 100) : null,
    ranks,
  };
}

async function main() {
  const results = [];
  for (const account of ACCOUNTS) {
    const r = await lookup(account);
    if (r.error) console.warn(`${account.docId}: ${r.error}`);
    else console.log(`${account.docId}: ${r.tier}${r.division ? " " + r.division : ""}`);
    results.push(r);
    await sleep(1200); // stay well under the dev key's rate limit
  }

  await mkdir("data", { recursive: true });
  await writeFile(
    OUT_PATH,
    JSON.stringify({ fetchedAt: new Date().toISOString(), accounts: results }, null, 2)
  );
  console.log(`Wrote ${results.length} accounts to ${OUT_PATH}.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
