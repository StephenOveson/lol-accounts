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
 * ## The rating, reason, and tips
 *
 * There's no official "how well did you play" number in the match-v5
 * payload, so this derives one from the same box-score stats a player
 * would look at themselves: KDA, damage dealt to champions, CS, kill
 * participation, and vision score, each per minute where duration matters
 * and each capped against a rough benchmark for "very good in that stat."
 * The benchmarks are deliberately simple round numbers, not role- or
 * rank-adjusted — a support's low CS or an ARAM's low vision score will
 * read as mediocre in those sub-scores (CS is excluded from the reason/tips
 * for an assists-heavy, farm-light game, since that's the support-shaped
 * signature), but the composite still leans heavily on KDA and kill
 * participation (45% combined) which hold up across roles and modes. Good
 * enough for an at-a-glance grade, not a substitute for an actual stats
 * site.
 *
 * Each stat also gets classified into a tier (great/good/ok/poor against
 * the same benchmarks), which feeds two more fields per match:
 *   - `reason`  — 1-2 sentences naming the standout strength and/or the
 *     stat that held the grade back, not just the number.
 *   - `tips`    — up to 2 short, actionable suggestions targeting whichever
 *     "poor" stats cost the most points (weight × how far below the cap),
 *     or a positive note if nothing was actually poor.
 * A game that ends inside the first 5 minutes (remake/early disconnect) is
 * excluded from all of this — `rating`/`grade` come back null and `reason`
 * says why, rather than grading a near-empty box score.
 *
 * Each match also carries `role` (Top/Jungle/Mid/Bottom/Support, from
 * Riot's teamPosition — same mapping fetch-champion-stats.mjs and
 * fetch-rank-benchmarks.mjs use, `null` if Riot didn't report one) so the
 * Rift Roster radar chart can filter this roster's own matches by role the
 * same way it filters the sampled rank-average benchmark — "my top lane
 * games" compared against "the average top laner at this rank," not one
 * side blended across every role while the other is filtered.
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

// Same mapping fetch-champion-stats.mjs and fetch-rank-benchmarks.mjs use
// for role detection. A match with no reported teamPosition (common in
// ARAM/URF/event modes, rare but possible in normal 5v5) gets `role: null`
// rather than a guess — the radar chart's role filter treats that the same
// as "not confirmed to be this role," not "matches every role."
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

// Caps `value` against `benchmark` to a 0-1 sub-score.
function capped(value, benchmark) {
  return Math.max(0, Math.min(1, value / benchmark));
}

// A game that ended inside the first 5 minutes is a remake (or a
// disconnect-triggered early end) — the box score is 0/0/0-ish noise, not a
// real performance, so it gets no rating/reason/tips rather than a
// misleadingly high grade from the win bonus alone.
const REMAKE_THRESHOLD_SECONDS = 300;

// Each stat is classified into a tier (best match wins; mins are ascending
// checked high-to-low) so the reason text can say *why*, not just *what*.
// Benchmarks are the same deliberately simple, non-role-adjusted numbers the
// rating itself uses — see the module doc comment above for the caveat.
const KDA_TIERS = [
  { min: 5, tier: "great", phrase: "an excellent KDA" },
  { min: 3, tier: "good", phrase: "a solid KDA" },
  { min: 1.5, tier: "ok", phrase: "an even KDA" },
  { min: -Infinity, tier: "poor", phrase: "a rough KDA" },
];
const KP_TIERS = [
  { min: 65, tier: "great", phrase: "constant kill involvement" },
  { min: 45, tier: "good", phrase: "solid kill involvement" },
  { min: 25, tier: "ok", phrase: "middling kill involvement" },
  { min: -Infinity, tier: "poor", phrase: "little kill involvement" },
];
const DMG_TIERS = [
  { min: 800, tier: "great", phrase: "elite damage output" },
  { min: 500, tier: "good", phrase: "solid damage output" },
  { min: 300, tier: "ok", phrase: "modest damage output" },
  { min: -Infinity, tier: "poor", phrase: "low damage output" },
];
const CS_TIERS = [
  { min: 8, tier: "great", phrase: "excellent farm" },
  { min: 6, tier: "good", phrase: "solid farm" },
  { min: 4, tier: "ok", phrase: "average farm" },
  { min: -Infinity, tier: "poor", phrase: "farm that fell behind" },
];
const VISION_TIERS = [
  { min: 1.5, tier: "great", phrase: "strong vision control" },
  { min: 0.8, tier: "good", phrase: "decent vision" },
  { min: 0.4, tier: "ok", phrase: "light vision" },
  { min: -Infinity, tier: "poor", phrase: "neglected vision" },
];

const TIPS_BY_KEY = {
  kda: "Look for safer trades and disengage from fights you're likely to lose before they happen, rather than after.",
  kp: "Group with teammates for fights and objectives instead of playing them out solo.",
  dmg: "Take more fights when you're ahead and prioritize itemizing for damage, not just survivability.",
  cs: "Focus on last-hitting between skirmishes — every ~10 CS is roughly a kill's worth of gold.",
  vision: "Buy and place control wards more often — aim for roughly one ward's worth of vision per minute.",
};

function classify(value, tiers) {
  return tiers.find((t) => value >= t.min);
}

function rateMatch(participant, match) {
  const durationSeconds = match.info.gameDuration;

  if (durationSeconds < REMAKE_THRESHOLD_SECONDS) {
    return {
      rating: null,
      grade: null,
      remake: true,
      kda: 0,
      csPerMin: 0,
      killParticipation: 0,
      damagePerMin: 0,
      reason: "Game ended in the first few minutes (remake or early disconnect) — not enough played to grade.",
      tips: [],
    };
  }

  const durationMin = durationSeconds / 60;
  const teamKills = match.info.participants
    .filter((p) => p.teamId === participant.teamId)
    .reduce((sum, p) => sum + p.kills, 0);

  const kda = (participant.kills + participant.assists) / Math.max(1, participant.deaths);
  const csPerMin = (participant.totalMinionsKilled + participant.neutralMinionsKilled) / durationMin;
  const dmgPerMin = participant.totalDamageDealtToChampions / durationMin;
  const visionPerMin = participant.visionScore / durationMin;
  const killParticipationPct = (teamKills > 0 ? (participant.kills + participant.assists) / teamKills : 0) * 100;

  // A support-shaped game (heavy assists, light farm) shouldn't get dinged
  // for low CS the way a farming-lane role would — the reason/tips just
  // leave CS out of it rather than pretending it's a fair comparison.
  const isSupportLike = participant.assists >= participant.kills * 2 && csPerMin < 3;

  const components = {
    kda: { key: "kda", weight: 0.30, score: capped(kda, 5), ...classify(kda, KDA_TIERS) },
    kp: { key: "kp", weight: 0.15, score: capped(killParticipationPct, 70), ...classify(killParticipationPct, KP_TIERS) },
    dmg: { key: "dmg", weight: 0.25, score: capped(dmgPerMin, 900), ...classify(dmgPerMin, DMG_TIERS) },
    cs: { key: "cs", weight: 0.20, score: capped(csPerMin, 8), ...classify(csPerMin, CS_TIERS), skip: isSupportLike },
    vision: { key: "vision", weight: 0.10, score: capped(visionPerMin, 2), ...classify(visionPerMin, VISION_TIERS) },
  };
  const ranked = Object.values(components).filter((c) => !c.skip);

  const composite = ranked.reduce((sum, c) => sum + c.score * c.weight, 0);
  const rating = Math.min(10, Math.round((composite + (participant.win ? 0.5 : 0)) * 10 * 10) / 10); // 0-10ish, win nudges it up half a point

  let grade;
  if (rating >= 8.5) grade = "S";
  else if (rating >= 7) grade = "A";
  else if (rating >= 5.5) grade = "B";
  else if (rating >= 4) grade = "C";
  else grade = "D";

  // Reason: lead with the overall verdict, then call out whatever actually
  // stood out — the single best "great" stat and the single worst "poor"
  // stat, if either exists. Not every game has both.
  const best = ranked.filter((c) => c.tier === "great").sort((a, b) => b.weight - a.weight)[0];
  const worst = ranked.filter((c) => c.tier === "poor").sort((a, b) => b.weight - a.weight)[0];

  let reason = `${participant.win ? "Won" : "Lost"} with ${classify(kda, KDA_TIERS).phrase} (${participant.kills}/${participant.deaths}/${participant.assists}) and ${classify(killParticipationPct, KP_TIERS).phrase} (${Math.round(killParticipationPct)}% of team kills).`;
  if (best && worst && best.key !== worst.key) {
    reason += ` The standout was ${best.phrase}, though ${worst.phrase} held the grade back.`;
  } else if (best) {
    reason += ` ${best.phrase[0].toUpperCase()}${best.phrase.slice(1)} carried the grade.`;
  } else if (worst) {
    reason += ` ${worst.phrase[0].toUpperCase()}${worst.phrase.slice(1)} held the grade back.`;
  }

  // Tips: the "poor" stats that cost the most points (weight * how far
  // below the cap), worst first, capped at 2 so it stays skimmable.
  const tips = ranked
    .filter((c) => c.tier === "poor")
    .map((c) => ({ key: c.key, deficit: c.weight * (1 - c.score) }))
    .sort((a, b) => b.deficit - a.deficit)
    .slice(0, 2)
    .map((c) => TIPS_BY_KEY[c.key]);
  if (tips.length === 0) {
    tips.push("Strong all-around performance — keep playing like this.");
  }

  return {
    rating,
    grade,
    kda: Math.round(kda * 100) / 100,
    csPerMin: Math.round(csPerMin * 10) / 10,
    killParticipation: Math.round(killParticipationPct),
    damagePerMin: Math.round(dmgPerMin),
    reason,
    tips,
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

    const { rating, grade, remake, kda, csPerMin, killParticipation, damagePerMin, reason, tips } = rateMatch(participant, match.data);

    matches.push({
      matchId,
      queueId: match.data.info.queueId,
      mode: QUEUE_LABELS[match.data.info.queueId] || `Queue ${match.data.info.queueId}`,
      championName: participant.championName,
      role: ROLE_LABELS[participant.teamPosition] || null,
      win: participant.win,
      kills: participant.kills,
      deaths: participant.deaths,
      assists: participant.assists,
      kda,
      csPerMin,
      killParticipation,
      damagePerMin,
      visionScore: participant.visionScore,
      durationSeconds: match.data.info.gameDuration,
      playedAt: new Date(match.data.info.gameEndTimestamp || match.data.info.gameStartTimestamp).toISOString(),
      rating,
      grade,
      remake: remake || false,
      reason,
      tips,
    });
  }

  return { docId, gameName, tagLine, matches };
}

async function main() {
  const results = [];
  for (const account of ACCOUNTS) {
    const r = await fetchRecentMatches(account);
    if (r.error) console.warn(`${account.docId}: ${r.error}`);
    else console.log(`${account.docId}: ${r.matches.length} recent match(es) — ${r.matches.map((m) => `${m.championName} ${m.win ? "W" : "L"} (${m.remake ? "remake" : m.grade})`).join(", ") || "(none)"}`);
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
