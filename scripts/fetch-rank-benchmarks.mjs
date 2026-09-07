#!/usr/bin/env node
/**
 * Samples a handful of real players at each tracked rank (Emerald, Diamond,
 * Master, Grandmaster) and averages the same 5 stats the match rating and
 * the Rift Roster radar chart use, writing data/rank-benchmarks.json. This
 * is what lets the artifact plot "an average player at this rank" next to
 * this roster's own numbers instead of only ever comparing the roster to
 * itself.
 *
 * There's no Riot endpoint that hands back "average KDA at Diamond" — this
 * builds that number the same way a human analyst would: pull some real
 * players who are currently at that rank, look at a couple of their recent
 * ranked games, and average the box score.
 *
 * Per rank:
 *   1. league-v4 entries -> a page (or listing) of real players at that
 *      rank, each carrying a puuid directly (Riot added puuid to
 *      LeagueEntryDTO, so no summoner-v4 lookup is needed):
 *        - Emerald/Diamond (divisioned): GET
 *          /lol/league/v4/entries/{queue}/{tier}/{division} — page 1 of one
 *          division (RANK_SAMPLE_DIVISION, default "I"). One page, not the
 *          whole tier.
 *        - Master/Grandmaster (apex, no divisions): GET
 *          /lol/league/v4/{master,grandmaster}leagues/by-queue/{queue} —
 *          returns the *entire* league in one call; a random subset of it
 *          is sampled client-side.
 *   2. A random RANK_SAMPLE_SIZE of those entries (Fisher-Yates partial
 *      shuffle — not a rigorous population sample, just "don't always grab
 *      the same handful").
 *   3. match-v5 matches/by-puuid/ids (type=ranked) -> up to
 *      RANK_SAMPLE_MATCHES recent ranked match ids per sampled player.
 *   4. match-v5 matches/{id} -> one call per match id, to read that
 *      player's participant entry.
 *
 * Every qualifying match (excluding remakes under 5 minutes, same rule as
 * fetch-recent-matches.mjs, AND excluding any role this roster doesn't
 * play — see below) across every sampled player at a rank is averaged into
 * that rank's overall benchmark, AND bucketed by role (Riot's teamPosition
 * on the match, same TOP/JUNGLE/MIDDLE/BOTTOM/UTILITY -> Top/Jungle/Mid/
 * Bottom/Support mapping fetch-champion-stats.mjs uses) so "average
 * Emerald player" and "average Emerald top laner" are both available. A
 * role with zero qualifying matches just isn't in the output's "roles"
 * map — there's no meaningful average to report.
 *
 * Default 10 players x 3 matches x 4 ranks keeps this well under the dev
 * key's rate limit while giving each role at least a few samples most of
 * the time. Small sample, on purpose — this is "basic data," not a
 * rigorous population study.
 *
 * Two things narrow what actually gets sampled, both read from this same
 * repo's other data files (already checked out alongside this script in
 * CI) rather than sampling everything indiscriminately:
 *   - Only ranks this roster has actually reached get sampled at all —
 *     data/ranked.json's per-account `tier` decides which of the 4
 *     candidate ranks to bother with, matching the artifact's own rank
 *     selector, so no API budget goes to benchmarking a rank nobody's
 *     climbed to yet.
 *   - Only roles this roster actually plays count toward a rank's
 *     benchmark — data/champion-stats.json's per-account `mainRole`
 *     decides the target role set (e.g. a top/mid/bot roster only keeps
 *     top/mid/bot games), so a jungler or support sampled from the ladder
 *     doesn't quietly drag the "overall" average toward a playstyle this
 *     roster doesn't have. There's no way to ask Riot for "only top lane
 *     games" up front (role is a fact about a game, not the player), so
 *     this still fetches each sampled player's recent ranked games as
 *     usual and discards whichever ones land on an off-roster role.
 *
 *   RIOT_API_KEY=RGAPI-... node scripts/fetch-rank-benchmarks.mjs
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";

const KEY = process.env.RIOT_API_KEY;
const OUT_PATH = process.env.OUT_PATH || "data/rank-benchmarks.json";
const QUEUE = "RANKED_SOLO_5x5";
const PLATFORM = process.env.RANK_SAMPLE_PLATFORM || "na1";
const DIVISION = process.env.RANK_SAMPLE_DIVISION || "I";
const SAMPLE_SIZE = Number(process.env.RANK_SAMPLE_SIZE || 10);
const MATCHES_PER_PLAYER = Number(process.env.RANK_SAMPLE_MATCHES || 3);
const SLEEP_MS = Number(process.env.RIOT_SLEEP_MS || 1300); // ~46 req/min, comfortably under the dev key's 100/2min cap
const REMAKE_THRESHOLD_SECONDS = 300; // matches fetch-recent-matches.mjs's remake cutoff

if (!KEY) {
  console.error("RIOT_API_KEY is not set.");
  process.exit(1);
}

const REGIONAL = {
  na1: "americas", br1: "americas", la1: "americas", la2: "americas", oc1: "americas",
  euw1: "europe", eun1: "europe", tr1: "europe", ru: "europe",
  kr: "asia", jp1: "asia",
};

const RANKS = [
  { key: "EMERALD", kind: "division" },
  { key: "DIAMOND", kind: "division" },
  { key: "MASTER", kind: "apex", path: "masterleagues" },
  { key: "GRANDMASTER", kind: "apex", path: "grandmasterleagues" },
];

// Same mapping fetch-champion-stats.mjs uses for "most probable role". A
// handful of very old or non-standard matches can have an empty
// teamPosition; those just don't count toward any role bucket.
const ROLE_LABELS = {
  TOP: "Top",
  JUNGLE: "Jungle",
  MIDDLE: "Mid",
  BOTTOM: "Bottom",
  UTILITY: "Support",
};

const regional = REGIONAL[PLATFORM];
if (!regional) {
  console.error(`Unknown platform "${PLATFORM}".`);
  process.exit(1);
}

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

// Fisher-Yates partial shuffle — returns up to n random entries from arr
// without mutating it.
function sampleRandom(arr, n) {
  const copy = arr.slice();
  const out = [];
  for (let i = 0; i < Math.min(n, copy.length); i++) {
    const j = i + Math.floor(Math.random() * (copy.length - i));
    [copy[i], copy[j]] = [copy[j], copy[i]];
    out.push(copy[i]);
  }
  return out;
}

async function fetchRankEntries(rank) {
  if (rank.kind === "division") {
    const resp = await riot(
      `https://${PLATFORM}.api.riotgames.com/lol/league/v4/entries/${QUEUE}/${rank.key}/${DIVISION}?page=1`
    );
    if (!resp.ok) return { error: `entries lookup ${resp.status}` };
    return { entries: resp.data };
  }
  const resp = await riot(`https://${PLATFORM}.api.riotgames.com/lol/league/v4/${rank.path}/by-queue/${QUEUE}`);
  if (!resp.ok) return { error: `${rank.path} lookup ${resp.status}` };
  return { entries: resp.data.entries || [] };
}

// Same raw stats fetch-recent-matches.mjs's rateMatch() computes — just the
// numbers, no grading, since this is a benchmark input, not a graded match.
function sampleMatchMetrics(participant, match) {
  const durationSeconds = match.info.gameDuration;
  if (durationSeconds < REMAKE_THRESHOLD_SECONDS) return null;

  const durationMin = durationSeconds / 60;
  const teamKills = match.info.participants
    .filter((p) => p.teamId === participant.teamId)
    .reduce((sum, p) => sum + p.kills, 0);

  return {
    role: ROLE_LABELS[participant.teamPosition] || null,
    kda: (participant.kills + participant.assists) / Math.max(1, participant.deaths),
    killParticipation: (teamKills > 0 ? (participant.kills + participant.assists) / teamKills : 0) * 100,
    damagePerMin: participant.totalDamageDealtToChampions / durationMin,
    csPerMin: (participant.totalMinionsKilled + participant.neutralMinionsKilled) / durationMin,
    visionPerMin: participant.visionScore / durationMin,
  };
}

function averageMetrics(samples) {
  const keys = ["kda", "killParticipation", "damagePerMin", "csPerMin", "visionPerMin"];
  const out = {};
  keys.forEach((k) => {
    const vals = samples.map((s) => s[k]);
    out[k] = Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100;
  });
  return out;
}

// `targetRoleSet` (from this roster's own mainRole spread, or null to
// accept every role — see targetRoles() below) decides which sampled
// matches actually count. There's no way to ask league-v4/match-v5 for
// "only top laners" up front — role is a fact about a specific game, not
// the player — so this fetches a sampled player's recent ranked games as
// usual and then discards any whose teamPosition isn't one this roster
// plays (including matches with no reported teamPosition, since those
// can't be confirmed either way). A player sampled who turns out to main
// an off-roster role can end up contributing zero matches; that's fine,
// it's just not the point of the sample.
async function benchmarkRank(rank, targetRoleSet) {
  const entriesResult = await fetchRankEntries(rank);
  await sleep(SLEEP_MS);
  if (entriesResult.error) return { key: rank.key, error: entriesResult.error };

  const withPuuid = entriesResult.entries.filter((e) => e.puuid);
  const sampled = sampleRandom(withPuuid, SAMPLE_SIZE);
  if (sampled.length === 0) return { key: rank.key, error: "no players with a puuid in the sampled listing" };

  const metricSamples = [];
  let playersWithData = 0;

  for (const entry of sampled) {
    const idsResp = await riot(
      `https://${regional}.api.riotgames.com/lol/match/v5/matches/by-puuid/${entry.puuid}/ids` +
      `?type=ranked&count=${MATCHES_PER_PLAYER}`
    );
    await sleep(SLEEP_MS);
    if (!idsResp.ok) continue;

    let gotOne = false;
    for (const matchId of idsResp.data) {
      const match = await riot(`https://${regional}.api.riotgames.com/lol/match/v5/matches/${matchId}`);
      await sleep(SLEEP_MS);
      if (!match.ok) continue;

      const participant = match.data.info.participants.find((p) => p.puuid === entry.puuid);
      if (!participant) continue;

      const metrics = sampleMatchMetrics(participant, match.data);
      if (!metrics) continue; // remake
      if (targetRoleSet && (!metrics.role || !targetRoleSet.has(metrics.role))) continue; // not a role this roster plays

      metricSamples.push(metrics);
      gotOne = true;
    }
    if (gotOne) playersWithData++;
  }

  if (metricSamples.length === 0) {
    const reason = targetRoleSet
      ? `no qualifying (non-remake, ${[...targetRoleSet].join("/")}) matches found for the sampled players`
      : "no qualifying (non-remake) matches found for the sampled players";
    return { key: rank.key, error: reason };
  }

  // Bucket by role in addition to the overall average — a role with zero
  // qualifying matches (nobody sampled played it, Riot didn't report a
  // teamPosition for it, or it was filtered out above) just doesn't get a
  // "roles" entry.
  const roles = {};
  Object.values(ROLE_LABELS).forEach((roleLabel) => {
    const roleSamples = metricSamples.filter((s) => s.role === roleLabel);
    if (roleSamples.length === 0) return;
    roles[roleLabel] = { matchesAnalyzed: roleSamples.length, metrics: averageMetrics(roleSamples) };
  });

  return {
    key: rank.key,
    sampleSize: sampled.length,
    playersWithData,
    matchesAnalyzed: metricSamples.length,
    metrics: averageMetrics(metricSamples),
    roles,
  };
}

// The set of this roster's currently-reached tiers, read from
// data/ranked.json's per-account `tier` field (their Solo/Duo rank — same
// field the artifact's own rank selector keys off). Falls back to "sample
// every candidate rank" (the old behavior) if that file is missing or
// unparseable, since that's a more useful default than silently sampling
// nothing when the roster's current ranks simply aren't known yet.
async function reachedRanks(ranksPath) {
  let raw;
  try {
    raw = await readFile(ranksPath, "utf8");
  } catch {
    console.warn(`Couldn't read ${ranksPath} — sampling every candidate rank instead of just the ones this roster has reached.`);
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn(`${ranksPath} isn't valid JSON — sampling every candidate rank instead.`);
    return null;
  }

  const tiers = new Set(
    (parsed.accounts || [])
      .filter((a) => !a.error && a.tier)
      .map((a) => a.tier.toUpperCase())
  );
  return tiers;
}

// The set of roles this roster actually plays, read from
// data/champion-stats.json's per-account `mainRole` field (written by
// fetch-champion-stats.mjs). Without this, a roster of top/mid/bot mains
// would get an "average player" benchmark quietly diluted by sampled
// junglers and supports — very different stat profiles (low CS, high
// vision) that have nothing to do with what this roster plays. Falls back
// to null ("sample every role") if that file is missing, unparseable, or
// nobody has a mainRole recorded yet, same reasoning as reachedRanks().
async function targetRoles(championStatsPath) {
  let raw;
  try {
    raw = await readFile(championStatsPath, "utf8");
  } catch {
    console.warn(`Couldn't read ${championStatsPath} — sampling every role instead of just the ones this roster plays.`);
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn(`${championStatsPath} isn't valid JSON — sampling every role instead.`);
    return null;
  }

  const roles = new Set(
    (parsed.accounts || [])
      .filter((a) => !a.error && a.mainRole)
      .map((a) => a.mainRole)
  );
  if (roles.size === 0) {
    console.warn("No tracked account has a mainRole recorded yet — sampling every role instead.");
    return null;
  }
  return roles;
}

async function main() {
  const reached = await reachedRanks("data/ranked.json");
  const targetRanks = reached ? RANKS.filter((r) => reached.has(r.key)) : RANKS;
  const roles = await targetRoles("data/champion-stats.json");

  if (reached && targetRanks.length === 0) {
    console.warn("No tracked account is currently at Emerald, Diamond, Master, or Grandmaster — nothing to sample this run.");
  } else if (reached) {
    console.log(`Sampling only reached ranks: ${targetRanks.map((r) => r.key).join(", ")}.`);
  }
  if (roles) console.log(`Sampling only roster-played roles: ${[...roles].join(", ")}.`);

  const results = {};
  for (const rank of targetRanks) {
    const r = await benchmarkRank(rank, roles);
    if (r.error) {
      console.warn(`${rank.key}: ${r.error}`);
    } else {
      const roleCoverage = Object.keys(r.roles).map((role) => `${role} ${r.roles[role].matchesAnalyzed}`).join(", ") || "none";
      console.log(`${rank.key}: ${r.matchesAnalyzed} matches from ${r.playersWithData}/${r.sampleSize} sampled players — roles: ${roleCoverage}`);
    }
    results[rank.key] = r;
  }

  await mkdir("data", { recursive: true });
  await writeFile(
    OUT_PATH,
    JSON.stringify({ fetchedAt: new Date().toISOString(), queue: QUEUE, platform: PLATFORM, ranks: results }, null, 2)
  );
  console.log(`Wrote rank benchmarks to ${OUT_PATH}.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
