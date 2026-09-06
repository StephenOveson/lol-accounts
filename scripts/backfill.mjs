#!/usr/bin/env node
/**
 * One-off backfill. Run this manually before wiring the Action.
 *
 *   RIOT_API_KEY=RGAPI-... node scripts/backfill.mjs
 *
 * It writes data/season-stats.json and prints what it found. Safe to re-run —
 * aggregation is incremental, so a second run only fetches matches it hasn't
 * already counted. The output is a dry-run report; nothing is baked into the
 * artifact yet.
 */

import { mkdir } from "node:fs/promises";
import { fetchSeasonStats, indexByKey } from "./fetch-season-stats.mjs";
import { SUMMONERS, SEASON_LABEL, MIN_GAMES } from "./roster.config.mjs";

export const SEASON_START_EPOCH = 1767902400; // 8 Jan 2026 — full 2026 ranked year
export const SEASON_LABEL = "2026 ranked year";

const pct = (n) => `${(n * 100).toFixed(1)}%`;

async function main() {
  await mkdir("data", { recursive: true });

  // Champion names come from Data Dragon, which is a public CDN and needs no key.
  const versions = await (await fetch("https://ddragon.leagueoflegends.com/api/versions.json")).json();
  const patch = versions[0];
  const championJson = await (
    await fetch(`https://ddragon.leagueoflegends.com/cdn/${patch}/data/en_US/champion.json`)
  ).json();

  const count = Object.keys(championJson.data).length;
  if (count < 150) {
    console.error(`champion.json returned only ${count} champions — looks truncated. Stopping.`);
    process.exit(1);
  }
  console.log(`Data Dragon ${patch}, ${count} champions.`);
  console.log(`Season window: ${SEASON_LABEL}, minimum ${MIN_GAMES} games.\n`);

  const results = await fetchSeasonStats(SUMMONERS, indexByKey(championJson));

  console.log("");
  for (const r of results) {
    if (!r.top) { console.log(`${r.riotId}: did not resolve.`); continue; }
    if (r.truncated) console.log(`${r.riotId}: WARNING hit the 1000-match ceiling.`);
    if (!r.top.length) {
      console.log(`${r.riotId}: no champion reached ${MIN_GAMES} games this season.`);
      continue;
    }
    console.log(`${r.riotId}:`);
    for (const c of r.top) {
      console.log(
        `  ${c.name.padEnd(14)} ${String(c.games).padStart(3)} games  ` +
        `${pct(c.winrate).padStart(6)}  score ${c.score.toFixed(3)}`
      );
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
