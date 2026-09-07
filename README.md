# lol-accounts

Keeps the [Rift Roster artifact](https://claude.ai/code/artifact/cbc26924-d162-4cea-adb0-2ae09c735b57)'s
ranked tier/division/LP/win-rate, top champions, and main role current,
automatically.

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
2. **A Claude scheduled task** (set up separately, not part of this repo)
   reads both data files back via the GitHub API and writes them into the
   artifact's live database. Only Claude's own tooling can write to a
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
expires every 24 hours. Neither workflow tries to work around that — a run
that hits an expired key fails loudly (red X in the Actions tab) rather than
silently committing stale data. Refresh the `RIOT_API_KEY` secret with a new
key from the portal to clear it. A production key (an approved, registered
app) is the only way to remove this step entirely.

## Manual run

Actions tab → "Update ranked stats" or "Update champion stats" → Run
workflow. Or locally:

```
RIOT_API_KEY=RGAPI-... node scripts/fetch-ranked.mjs
RIOT_API_KEY=RGAPI-... node scripts/fetch-champion-stats.mjs
```

`fetch-champion-stats.mjs` accepts a couple of env overrides:
`MATCHES_PER_ACCOUNT` (default 50, max 100 per Riot's per-request cap) and
`SEASON_START_ISO` (default: Jan 1 UTC of the current year).
