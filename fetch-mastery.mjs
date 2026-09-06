#!/usr/bin/env node
/**
 * Resolves a fixed list of Riot IDs to their top-3 champion mastery, for baking
 * into rift-roster-artifact.jsx at build time.
 *
 * Two routing tiers, which is the easy thing to get wrong:
 *   Account-V1         -> REGIONAL  host (americas / europe / asia / sea)
 *   Champion-Mastery-V4 -> PLATFORM host (na1 / euw1 / kr / ...)
 * Using the wrong host returns 404, not a routing error, so a mistake here looks
 * like "summoner doesn't exist" rather than a config bug.
 *
 * Exits non-zero on auth failure so the job goes red instead of silently baking
 * an empty mastery panel. A missing summoner is tolerated (returns null) because
 * one renamed account shouldn't block a patch-day roster refresh.
 */

const KEY = process.env.RIOT_API_KEY;
if (!KEY) {
  console.error("RIOT_API_KEY is not set.");
  process.exit(1);
}

// PLATFORM -> REGIONAL. Extend as needed.
const REGIONAL = {
  na1: "americas", br1: "americas", la1: "americas", la2: "americas",
  euw1: "europe", eun1: "europe", tr1: "europe", ru: "europe",
  kr: "asia", jp1: "asia",
  oc1: "sea", ph2: "sea", sg2: "sea", th2: "sea", tw2: "sea", vn2: "sea",
};

async function riot(url) {
  const res = await fetch(url, { headers: { "X-Riot-Token": KEY } });
  if (res.status === 401 || res.status === 403) {
    // Dev keys expire every 24h. In a scheduled job this is the failure you hit.
    throw Object.assign(new Error(`Riot rejected the key (HTTP ${res.status})`), { fatal: true });
  }
  if (res.status === 429) {
    const wait = Number(res.headers.get("retry-after") || 1);
    await new Promise((r) => setTimeout(r, (wait + 1) * 1000));
    return riot(url);
  }
  if (!res.ok) return null;
  return res.json();
}

/**
 * @param {Array<{riotId: string, platform: string}>} summoners  riotId as "Name#TAG"
 * @param {Record<string, {id: string, name: string}>} byKey     ddragon numeric key -> champion
 */
export async function fetchMastery(summoners, byKey) {
  const out = [];

  for (const { riotId, platform } of summoners) {
    const regional = REGIONAL[platform];
    if (!regional) throw new Error(`Unknown platform "${platform}" for ${riotId}`);

    const hash = riotId.lastIndexOf("#");
    if (hash < 1) throw new Error(`Malformed Riot ID "${riotId}" — expected Name#TAG`);
    const gameName = encodeURIComponent(riotId.slice(0, hash));
    const tagLine = encodeURIComponent(riotId.slice(hash + 1));

    const account = await riot(
      `https://${regional}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${gameName}/${tagLine}`
    );
    if (!account?.puuid) {
      console.warn(`skip: ${riotId} did not resolve on ${regional}`);
      out.push({ riotId, platform, top: null });
      continue;
    }

    const top = await riot(
      `https://${platform}.api.riotgames.com/lol/champion-mastery/v4/champion-masteries` +
      `/by-puuid/${account.puuid}/top?count=3`
    );

    out.push({
      riotId,
      platform,
      // PUUID is deliberately NOT baked into the artifact — it's a stable player
      // identifier and the artifact is publicly shareable.
      top: (top || []).map((m) => {
        const champ = byKey[String(m.championId)];
        return {
          id: champ?.id ?? null,              // e.g. "Jayce" — joins to the roster row
          name: champ?.name ?? `#${m.championId}`,
          level: m.championLevel,
          points: m.championPoints,
        };
      }),
    });
  }

  return out;
}

/** Build the numeric-key lookup from the champion.json the roster script already fetched. */
export function indexByKey(championJson) {
  const byKey = {};
  for (const c of Object.values(championJson.data)) byKey[c.key] = { id: c.id, name: c.name };
  return byKey;
}
