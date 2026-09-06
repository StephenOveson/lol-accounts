# lol-accounts

Keeps the [Rift Roster artifact](https://claude.ai/code/artifact/cbc26924-d162-4cea-adb0-2ae09c735b57)'s
ranked tier/division/LP/win-rate current, automatically.

## How it fits together

Two systems, because neither can do the whole job alone:

1. **This repo's GitHub Action** (`.github/workflows/update-ranked.yml`) runs
   on a schedule, calls the Riot API, and commits the result to
   `data/ranked.json`. GitHub's runners have normal internet access, so this
   is the only piece that can actually reach `api.riotgames.com`.
2. **A Claude scheduled task** (set up separately, not part of this repo)
   reads `data/ranked.json` back via the GitHub API and writes it into the
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
expires every 24 hours. This workflow does NOT try to work around that — a
run that hits an expired key fails loudly (red X in the Actions tab) rather
than silently committing stale data. Refresh the `RIOT_API_KEY` secret with a
new key from the portal to clear it. A production key (an approved,
registered app) is the only way to remove this step entirely.

## Manual run

Actions tab → "Update ranked stats" → Run workflow. Or locally:

```
RIOT_API_KEY=RGAPI-... node scripts/fetch-ranked.mjs
```

