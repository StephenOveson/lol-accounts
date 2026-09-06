/**
 * Accounts tracked for the Rift Roster artifact's tier/division/LP panel.
 *
 * docId must match the document id already seeded in the artifact's database
 * (collection "accounts") at:
 *   https://claude.ai/code/artifact/cbc26924-d162-4cea-adb0-2ae09c735b57
 * A mismatched docId creates a duplicate row instead of updating the existing
 * one, so this is the single source of truth for the join key.
 *
 * gameName/tagLine is the Riot ID as shown in the client (Name#TAG) — not the
 * old summoner name. platform is the routing value for the API host.
 */
export const ACCOUNTS = [
  { docId: "dj-foehammer",  gameName: "DJ Foehammer",  tagLine: "NA1", platform: "na1" },
  { docId: "spiritbr8ker",  gameName: "spiritbr8ker",  tagLine: "NA1", platform: "na1" },
  { docId: "nomessnofuss",  gameName: "NoMessNofuss",  tagLine: "1329", platform: "na1" },
  { docId: "mrs-deesenutz", gameName: "Mrs Deesenutz", tagLine: "NA1", platform: "na1" },
  { docId: "spiritb4ker",   gameName: "spiritb4ker",   tagLine: "NA1", platform: "na1" },
  { docId: "grabpatch",     gameName: "grabpatch",     tagLine: "NA1", platform: "na1" },
];
