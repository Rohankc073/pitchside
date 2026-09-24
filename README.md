# Pitchside

Live football scores, fixtures, results, tables, line-ups, club and player pages —
in one page, with no build step and no API key.

## Running locally

```bash
node server.js      # → http://localhost:4173
```

`server.js` is a ~30-line static file server for local use only. The site itself is
three static files (`index.html`, `styles.css`, `app.js`) and can be hosted anywhere.

## What's in it

**Scores** — every match for any date, across 19 competitions (Champions League,
Premier League, LaLiga, Serie A, Bundesliga, Ligue 1, Europa, Conference, and more).
Live minute, scorers, red cards, auto-refresh every 30 seconds. Date strip, calendar
picker, and `←`/`→`/`T` keyboard shortcuts.

**Match centre** — timeline of goals, cards and substitutions; team stats with
possession and comparison bars; line-ups on a pitch with player portraits, goals and
assists; full player performance tables; live commentary; head-to-head history;
highlights; match reports; and the league table with both clubs highlighted.

**Leagues** — a full-season schedule on one page (played and upcoming, filterable, with a jump to the next fixture), fixtures and results by month, full tables with qualification zones and
groups, season top scorers and assists, a club directory, and a news feed.

**Clubs** — recent form, upcoming fixtures, position in every competition entered,
full squad by position, results, standings, the club's own scoring charts, and club
information (stadium, location, nickname, colours, history).

**Players** — position, club, age, nationality, shirt number; season statistics; and a
match-by-match log with minutes, goals and assists.

Follow clubs to pin them to the sidebar; pin competitions to reorder the scores page.

## Predictions

Every fixture gets win/draw/loss probabilities, expected goals and a likely-scoreline
spread, shown on the match page and collected in the Predictions hub.

### The model

A **Dixon-Coles style bivariate Poisson**. Each club carries an attack and a defence
rating; a league-wide home multiplier and a low-score correlation term complete it:

    lambda_home = M * attack[home] * defence[away] * H
    lambda_away = M * attack[away] * defence[home]

Ratings are fitted by iterative proportional fitting over the last 13 months of results,
weighted by exponential time decay, with shrinkage pulling thin-sample clubs toward the
league average. The score matrix is then read off for 1X2, both-teams-to-score,
over/under and exact scorelines.

**Measured performance** — walk-forward backtest over 2025-26 (fit on earlier matchdays
only, predict the next; 795 scored predictions across three leagues):

| League | RPS | Uniform baseline | Outcome accuracy |
|---|---|---|---|
| Premier League | 0.2110 | 0.2283 | 45.9% |
| LaLiga | 0.2078 | 0.2386 | 52.3% |
| Bundesliga | 0.1975 | 0.2345 | 54.6% |
| **Average** | **0.2054** | **0.222** | **50.9%** |

Run it yourself: `node backtest.js eng.1 202508 10`.

RPS (ranked probability score, lower is better) is the standard ordered metric for 1X2.
For reference, betting-market odds score around 0.19 — the gap is the value of
information this model does not have.

### Player ratings

ESPN exposes rating fields but leaves them at 0.0 in every league checked, so Pitchside
computes its own from the 146 per-player statistics the feed does publish: goals and
assists, shots, expected goals, pass accuracy, duels won, tackles, interceptions,
recoveries, saves, goals prevented, clean sheets and cards, with short cameos pulled back
toward the mean. Ratings are labelled in the UI as ours, not official ones.

The line-ups tab draws both starting elevens on a vertical pitch with portraits, shirt
numbers, goal/card/substitution markers and a colour-coded rating badge per player. Before
kick-off, when squads are still empty, each side's most recent starting eleven is shown
instead, labelled as probable rather than confirmed.

### Live predictions

Once a match kicks off, remaining expected goals are scaled by time left and adjusted for
game state (trailing sides push, leaders sit deeper) and red cards, then convolved with
the current score. The match page charts how the probabilities moved.

### Availability

ESPN publishes **no injury data for football**, and squads are empty until roughly an hour
before kick-off. Availability is therefore assembled from four weaker signals, each
weighted by how much it can be trusted:

| Signal | Weight | Reliability |
|---|---|---|
| Red-card suspension | 1.0 | Exact — derived from match events |
| Manual override | 1.0 | Exact — you set it |
| Missing from recent line-ups | 0.6 | Cannot distinguish injury from rotation; only reacts after a missed match |
| News keyword match | 0.4 | Fragile; shown as an unconfirmed report with its source |

Each absent player removes a share of their club's goals; the total adjustment is capped
at 20% so one bad signal cannot distort a prediction.

### Scored, and honest about it

Every pre-match prediction is written to a ledger and scored at full time (RPS, correct or
wrong) against the coin-toss baseline. The hub shows the running record and a calibration
chart — whether a stated 60% actually happens 60% of the time.

**Two honest limitations.** The ledger lives in `localStorage`, so the live track record is
per-browser; the backtests are the reproducible, shared measure. And temperature
calibration was tested and **did not** improve out-of-sample scores, so it is not applied —
the raw model is already reasonably calibrated.

**xG is not used in the model.** ESPN carries xG only for the current season, so there is no
historical xG to validate a blend against. The code path exists and is switched off rather
than shipping an unmeasured claim.

No betting odds are used or displayed, and nothing here is advice.

## Data sources

- **Match data**: ESPN's public soccer feeds (`site.api.espn.com`,
  `sports.core.api.espn.com`). No key required. These endpoints are undocumented and
  unofficial — they rate-limit bursts (HTTP 403) and may change without notice. The app
  queues requests and retries with backoff.
- **Player portraits and club descriptions**: Wikipedia / Wikimedia Commons, via the
  MediaWiki API. Images are available under CC BY-SA. Only exact name matches are
  accepted — a fuzzy search returns the wrong person, and players with no Wikipedia
  photo fall back to a shirt-number avatar.

Not affiliated with ESPN, Wikipedia, or any club or competition.

## Known limitations

- **No injury or suspension lists** — ESPN's soccer injuries endpoint returns 404.
- **No transfer data** in these feeds.
- **TV listings are ESPN's own market (US)** and are labelled as such. They are absent
  for most fixtures.
- **Some players have no portrait** — they have no photo on Wikipedia at all.
- Betting odds are available in the feed but deliberately not displayed.

## Caching

Resolved player names, club crests, portraits and club descriptions are cached in
`localStorage`; API responses are cached in memory for the length of the session, so
revisiting a page is instant and gentle on the upstream feeds.
