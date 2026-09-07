#!/usr/bin/env node
/**
 * Fetches each account's 3 most recent matches — any queue/mode, not just
 * ranked — and a per-match performance rating, writing
 * data/recent-matches.json.
 *
 * Per account:
 *   1. account-v1 by-riot-id         -> puuid (same lookup the other two
 *      scripts do; kept separate here so this script can run standalone).
 *   2. match-v5 matches/by-puuid/ids -> latest MATCH_COUNT match ids, no
 *      `type` filter, so ARAM/normals/URF/etc. all count, not only ranked.
 *   3. match-v5 matches/{id}         -> one call per match id.
 *
 * Only 1 + MATCH_COUNT calls per account (MATCH_COUNT defaults to 3), so
 * this is cheap enough to run on a short interval — see
 * update-recent-matches.yml.
 *
 * ## The rating
 *
 * There's no official "how well did you play" number in the match-v5
 * payload, so this derives one from the same box-score stats a player
 * would look at themselves: KDA, damage dealt to champions, CS, kill
 * participation, and vision score, each per minute where duration matters
 * and each capped against a rough benchmark for "very good in that stat."
 * The benchmarks are deliberately simple round numbers, not role- or
 * rank-adjusted — a support's low CS or an ARAM's low vision score will
 * read as mediocre in those sub-scores, but the composite still leans
 * heavily on KDA and kill participation (45% combined) which hold up
 * across roles and modes. Good enough for an at-a-glance grade, not a
 * substitute for an actual stats site.
 *
 *   RIOT_API_KEY=RGAPI-... node scripts/fetch-recent-matches.mjs
 */

import { mkdir, writeFile } from "node:fs/promises";
import { ACCOUNTS } from "./ranked-accounts.config.mjs";

const KEY = process.env.RIOT_API_KEY;
const OUT_PATH = process.env.OUT_PATH || "data/recent-matches.json";
const MATCH_COUNT = Number(process.env.RECENT_MATCH_COUNT || 3);
const SLEEP_MS = Number(process.env.RIOT_SLEEP_MS || 1300); // ~46 req/min, comfortably under the dev key's 100/2min cap

if (!KEY) {
  console.error("RIOT_API_KEY is not set.");
  process.exit(1);
}

const REGIONAL = {
  na1: "americas", br1: "americas", la1: "americas", la2: "americas", oc1: "americas",
  euw1: "europe", eun1: "europe", tr1: "europe", ru: "europe",
  kr: "asia", jp1: "asia",
};

// Display labels for the queue ids seen in practice on these accounts'
// regions. An unrecognized id falls back to "Queue {id}" rather than being
// dropped or mislabeled — Riot adds/retires queue ids over time (rotating
// modes especially) and this list isn't meant to track all of them.
const QUEUE_LABELS = {
  400: "Normal Draft",
  420: "Ranked Solo/Duo",
  430: "Normal Blind",
  440: "Ranked Flex",
  450: "ARAM",
  700: "Clash",
  830: "Co-op vs AI (Intro)",
  840: "Co-op vs AI (Beginner)",
  850: "Co-op vs AI (Intermediate)",
  900: "URF",
  1300: "Nexus Blitz",
  1400: "Ultimate Spellbook",
  1700: "Arena",
  1900: "URF (Pick)",
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

// Caps `value` against `benchmark` to a 0-1 sub-score.
function capped(value, benchmark) {
  return Math.max(0, Math.min(1, value / benchmark));
}

function rateMatch(participant, match) {
  const durationMin = Math.max(1 / 60, match.info.gameDuration / 60);
  const teamKills = match.info.participants
    .filter((p) => p.teamId === participant.teamId)
    .reduce((sum, p) => sum + p.kills, 0);

  const kda = (participant.kills + participant.assists) / Math.max(1, participant.deaths);
  const csPerMin = (participant.totalMinionsKilled + participant.neutralMinionsKilled) / durationMin;
  const dmgPerMin = participant.totalDamageDealtToChampions / durationMin;
  const visionPerMin = participant.visionScore / durationMin;
  const killParticipation = teamKills > 0 ? (participant.kills + participant.assists) / teamKills : 0;

  const composite =
    capped(kda, 5) * 0.30 +
    capped(killParticipation, 0.7) * 0.15 +
    capped(dmgPerMin, 900) * 0.25 +
    capped(csPerMin, 8) * 0.20 +
    capped(visionPerMin, 2) * 0.10;

  const rating = Math.round((composite + (participant.win ? 0.5 : 0)) * 10 * 10) / 10; // 0-10ish, win nudges it up half a point
  const cappedRating = Math.min(10, rating);

  let grade;
  if (cappedRating >= 8.5) grade = "S";
  else if (cappedRating >= 7) grade = "A";
  else if (cappedRating >= 5.5) grade = "B";
  else if (cappedRating >= 4) grade = "C";
  else grade = "D";

  return {
    rating: cappedRating,
    grade,
    kda: Math.round(kda * 100) / 100,
    csPerMin: Math.round(csPerMin * 10) / 10,
    killParticipation: Math.round(killParticipation * 100),
  };
}

async function fetchRecentMatches({ docId, gameName, tagLine, platform }) {
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
    `?start=0&count=${MATCH_COUNT}`
  );
  await sleep(SLEEP_MS);
  if (!idsResp.ok) {
    return { docId, gameName, tagLine, error: `match id lookup ${idsResp.status}` };
  }

  const matches = [];
  for (const matchId of idsResp.data) {
    const match = await riot(`https://${regional}.api.riotgames.com/lol/match/v5/matches/${matchId}`);
    await sleep(SLEEP_MS);
    if (!match.ok) continue; // skip one bad match rather than failing the whole account

    const participant = match.data.info.participants.find((p) => p.puuid === puuid);
    if (!participant) continue;

    const { rating, grade, kda, csPerMin, killParticipation } = rateMatch(participant, match.data);

    matches.push({
      matchId,
      queueId: match.data.info.queueId,
      mode: QUEUE_LABELS[match.data.info.queueId] || `Queue ${match.data.info.queueId}`,
      championName: participant.championName,
      win: participant.win,
      kills: participant.kills,
      deaths: participant.deaths,
      assists: participant.assists,
      kda,
      csPerMin,
      killParticipation,
      visionScore: participant.visionScore,
      durationSeconds: match.data.info.gameDuration,
      playedAt: new Date(match.data.info.gameEndTimestamp || match.data.info.gameStartTimestamp).toISOString(),
      rating,
      grade,
    });
  }

  return { docId, gameName, tagLine, matches };
}

async function main() {
  const results = [];
  for (const account of ACCOUNTS) {
    const r = await fetchRecentMatches(account);
    if (r.error) console.warn(`${account.docId}: ${r.error}`);
    else console.log(`${account.docId}: ${r.matches.length} recent match(es) — ${r.matches.map((m) => `${m.championName} ${m.win ? "W" : "L"} (${m.grade})`).join(", ") || "(none)"}`);
    results.push(r);
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
