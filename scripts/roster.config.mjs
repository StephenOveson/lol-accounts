/**
 * Tracked summoners and the season window for the Rift Roster mastery panel.
 *
 * riotId is the Riot ID as displayed in client: gameName#tagLine.
 * platform is the routing value for the API host, which is a SEPARATE thing that
 * happens to look identical for NA accounts on a default tagline. They diverge
 * elsewhere — a EUW account reads "Name#EUW" but routes on "euw1" — so don't
 * derive one from the other.
 */
export const SUMMONERS = [
  { riotId: "spiritbr8ker#NA1", platform: "na1" },
];

/** Ranked Solo/Duo only. Flex would be 440. */
export const QUEUES = [420];

/**
 * 2026 Season 3 — started 29 July 2026, 19:00 UTC (noon PT), patch 26.15.
 *
 * This is "the current season" in Riot's naming, but note it is a split, not a
 * ladder reset: LP and tier carried over from Season 2, and the only full soft
 * reset of the year was 8 January. So the choice here is about which sample you
 * want, not about matching a rank boundary:
 *
 *   1785351600  29 Jul 2026 — current season (Season 3). Few weeks of games.
 *   1767902400   8 Jan 2026 — full 2026 ranked year, back to the annual reset.
 *
 * Starting with the season, per the brief. If the panel comes back thin, the
 * January value is a one-line swap and no code change.
 */
export const SEASON_START_EPOCH = 1785351600;
export const SEASON_LABEL = "2026 Season 3";

/**
 * Minimum games before a champion is eligible for the top 3. Interacts directly
 * with the window above: over a five-week season a floor of 5 may exclude
 * everything. Drop to 3 if the panel renders empty.
 */
export const MIN_GAMES = 5;
