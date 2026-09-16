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

**Leagues** — fixtures and results by month, full tables with qualification zones and
groups, season top scorers and assists, a club directory, and a news feed.

**Clubs** — recent form, upcoming fixtures, position in every competition entered,
full squad by position, results, standings, the club's own scoring charts, and club
information (stadium, location, nickname, colours, history).

**Players** — position, club, age, nationality, shirt number; season statistics; and a
match-by-match log with minutes, goals and assists.

Follow clubs to pin them to the sidebar; pin competitions to reorder the scores page.

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
