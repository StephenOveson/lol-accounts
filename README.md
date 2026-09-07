# lol-accounts

Keeps the [Rift Roster artifact](https://claude.ai/code/artifact/cbc26924-d162-4cea-adb0-2ae09c735b57)'s
ranked tier/division/LP/win-rate, top champions, main role, and recent-match
performance current, automatically.

## How it fits together

Two systems, because neither can do the whole job alone:

1. **This repo's GitHub Actions** run on a schedule, call the Riot API, and
   commit the results. GitHub's runners have normal internet access, so this
   is the only piece that can actually reach `api.riotgames.com`.
   - `update-ranked.yml` (every 6h) — tier/division/LP/win-rate for every
     ranked queue -> `data/ranked.json`.
   - `update-champion-stats.yml` (daily) — top 3 champions and most probable
     role for the current season, via Match-V5 -> `data/champion-stats.json`.
     Heavier fetch (roughly 50 match-detail calls per account), hence the
     slower schedule.
   - `update-recent-matches.yml` (every 2h) — the 3 most recent matches in
     any queue/mode (ranked, normals, ARAM, event modes, ...) with a derived
     per-match performance rating -> `data/recent-matches.json`. Only 4 calls
     per account, so it can run more often and stay actually "recent."
   - `update-rank-benchmarks.yml` (weekly) — samples a handful of real
     Emerald/Diamond/Master/Grandmaster players and averages their recent
     ranked stats -> `data/rank-benchmarks.json`. This is the "average
     player at this rank" line the radar chart plots alongside the roster's
     own numbers; there's no Riot endpoint for it, so this builds it from a
     small sample instead.
2. **A Claude scheduled task** (set up separately, not part of this repo)
   reads all four data files back via the GitHub API and writes them into
   the artifact's live database. Only Claude's own tooling can write to a
   published artifact's database — there's no public API for that — so this
   step has to run there, not here.

## One-time setup

```
git init
git add -A
git commit -m "first commit"
gh repo create lol-accounts --public --source=. --push
# or: create the repo on github.com, then
#   git remote add origin git@github.com:<you>/lol-accounts.git
#   git push -u origin main
```

Then add the Riot API key as a repo secret: **Settings → Secrets and
variables → Actions → New repository secret**, name `RIOT_API_KEY`.

## The dev-key catch

A personal/dev key from the [developer portal](https://developer.riotgames.com/)
expires every 24 hours. None of the workflows try to work around that — a
run that hits an expired key fails loudly (red X in the Actions tab) rather
than silently committing stale data. Refresh the `RIOT_API_KEY` secret with
a new key from the portal to clear it. A production key (an approved,
registered app) is the only way to remove this step entirely.

## Manual run

Actions tab → "Update ranked stats", "Update champion stats", "Update
recent matches", or "Update rank benchmarks" → Run workflow. Or locally:

```
RIOT_API_KEY=RGAPI-... node scripts/fetch-ranked.mjs
RIOT_API_KEY=RGAPI-... node scripts/fetch-champion-stats.mjs
RIOT_API_KEY=RGAPI-... node scripts/fetch-recent-matches.mjs
RIOT_API_KEY=RGAPI-... node scripts/fetch-rank-benchmarks.mjs
```

`fetch-champion-stats.mjs` accepts a couple of env overrides:
`MATCHES_PER_ACCOUNT` (default 50, max 100 per Riot's per-request cap) and
`SEASON_START_ISO` (default: Jan 1 UTC of the current year).

`fetch-recent-matches.mjs` accepts `RECENT_MATCH_COUNT` (default 3). Each
match gets a 0-10 performance `rating` and an S/A/B/C/D `grade` derived from
KDA, kill participation, damage/CS/vision per minute, and a small win bonus
— see the comment at the top of the script for the exact weights and why
they're not role-adjusted. Each match also gets a `reason` (1-2 sentences
naming the standout stat and/or whatever held the grade back) and up to 2
`tips` targeting the weakest stats. A game that ends in the first 5 minutes
(remake/early disconnect) is flagged `remake: true` with no rating, grade,
or tips — its box score is too thin to grade fairly.

`fetch-rank-benchmarks.mjs` accepts `RANK_SAMPLE_SIZE` (default 10 players
per rank), `RANK_SAMPLE_MATCHES` (default 3 ranked games per player),
`RANK_SAMPLE_PLATFORM` (default `na1`), and `RANK_SAMPLE_DIVISION` (default
`I`, only used for the divisioned Emerald/Diamond tiers — Master/Grandmaster
have no divisions). It samples real players via league-v4 (LeagueEntryDTO
now carries `puuid` directly, so no summoner-v4 lookup is needed), pulls a
few of their recent ranked games via match-v5, and averages the same 5
stats the match rating uses — both overall per rank and broken out by role
(Top/Jungle/Mid/Bottom/Support, via each match's `teamPosition`, same as
`fetch-champion-stats.mjs`'s role detection) so the radar chart can compare
"this roster's top laner" against "the average Emerald top laner" instead
of blending every role together. A role nobody in the sample played just
isn't in that rank's `roles` map. Small sample, on purpose — this is meant
to be "basic data" for a rough comparison line, not a rigorous population
study; role-split numbers are thinner still (a handful of games each), so
treat them as an even rougher signal.

Two things narrow what actually gets sampled, both read from this repo's
own other data files: only ranks the roster has actually reached
(`data/ranked.json`'s per-account `tier`) get sampled at all, and only
roles the roster actually plays (`data/champion-stats.json`'s per-account
`mainRole`) count toward a rank's benchmark — a jungler or support sampled
off the ladder just gets discarded rather than diluting the "overall"
average with a playstyle this roster doesn't have. Both fall back to
"sample everything" if the relevant file is missing, unparseable, or has
no usable data yet.
