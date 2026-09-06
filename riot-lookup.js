// Run this with:  RIOT_API_KEY=RGAPI-xxxx node riot-lookup.js
// (Reads the key from the environment so it never sits in this file.)
//
// Looks up ranked solo/duo tier, division, and win rate for each account
// below via the Riot API, then prints one JSON array to paste back.
//
// v2: uses account-v1's puuid directly against league-v4's by-puuid route
// (the old by-summoner/{summonerId} route came back 403 on this key —
// Riot has been migrating league-v4 off encryptedSummonerId).

const https = require('https');

const REGION = 'americas';   // routing value for account-v1
const PLATFORM = 'na1';      // platform routing value for league-v4

const ACCOUNTS = [
  { docId: 'dj-foehammer',  gameName: 'DJ Foehammer',   tagLine: 'NA1' },
  { docId: 'spiritbr8ker',  gameName: 'spiritbr8ker',   tagLine: 'NA1' },
  { docId: 'nomessnofuss',  gameName: 'NoMessNoFuss',   tagLine: 'NA1' }, // still 404s — verify exact Riot ID in client
  { docId: 'mrs-deesenutz', gameName: 'Mrs Deesenutz',  tagLine: 'NA1' },
  { docId: 'spiritb4ker',   gameName: 'spiritb4ker',    tagLine: 'NA1' },
  { docId: 'grabpatch',     gameName: 'grabpatch',      tagLine: 'NA1' },
];

const KEY = process.env.RIOT_API_KEY;
if (!KEY) {
  console.error('Set RIOT_API_KEY first, e.g.:  RIOT_API_KEY=RGAPI-xxxx node riot-lookup.js');
  process.exit(1);
}

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'X-Riot-Token': KEY } }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function lookup(account) {
  const { docId, gameName, tagLine } = account;
  const encName = encodeURIComponent(gameName);
  const encTag = encodeURIComponent(tagLine);

  const acctResp = await get(
    `https://${REGION}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encName}/${encTag}`
  );
  if (acctResp.status !== 200) {
    return { docId, gameName, tagLine, error: `account lookup ${acctResp.status}` };
  }
  const puuid = JSON.parse(acctResp.body).puuid;

  const leagueResp = await get(
    `https://${PLATFORM}.api.riotgames.com/lol/league/v4/entries/by-puuid/${puuid}`
  );
  if (leagueResp.status !== 200) {
    return { docId, gameName, tagLine, puuid, error: `league lookup ${leagueResp.status}` };
  }
  const entries = JSON.parse(leagueResp.body);
  const solo = entries.find((e) => e.queueType === 'RANKED_SOLO_5x5');

  if (!solo) {
    return { docId, gameName, tagLine, tier: 'UNRANKED', division: '', winRate: null };
  }

  const winRate = Math.round((solo.wins / (solo.wins + solo.losses)) * 100);
  return {
    docId,
    gameName,
    tagLine,
    tier: solo.tier,
    division: solo.rank,
    leaguePoints: solo.leaguePoints,
    winRate,
  };
}

(async () => {
  const results = [];
  for (const account of ACCOUNTS) {
    const r = await lookup(account);
    results.push(r);
    await sleep(1200); // stay well under the dev key's rate limit
  }
  console.log(JSON.stringify(results, null, 2));
})();