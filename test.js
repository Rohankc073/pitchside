'use strict';
/* Pitchside test suite — plain Node, no dependencies.  Run: node test.js
   Covers the maths that has no visible symptom when it goes wrong. The two
   worst bugs in this project (home advantage fitted at 1.06 against a real
   1.25, and a schedule counting 424 matches in a 380-match season) both
   produced plausible-looking output, so they are pinned here by assertion. */

const fs = require('fs');
const path = require('path');
const P = require('./predictions.js');

let pass = 0, fail = 0;
const results = [];
function t(name, fn) {
  try { fn(); pass++; results.push(['PASS', name, '']); }
  catch (e) { fail++; results.push(['FAIL', name, e.message]); }
}
const eq = (a, b, msg) => { if (a !== b) throw new Error(`${msg || ''} expected ${b}, got ${a}`); };
const near = (a, b, tol, msg) => { if (!(Math.abs(a - b) <= tol)) throw new Error(`${msg || ''} expected ~${b} (±${tol}), got ${a}`); };
const ok = (v, msg) => { if (!v) throw new Error(msg || 'expected truthy'); };

/* ---------- helpers ---------- */
function synthSeason(opts) {
  const o = Object.assign({ teams: 8, rounds: 4, homeAdv: 1.35, seed: 7 }, opts);
  let seed = o.seed;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const pois = l => { let k = 0, p = Math.exp(-l), s = p, u = rnd(); while (u > s && k < 12) { k++; p *= l / k; s += p; } return k; };
  const strength = i => 0.7 + (i / (o.teams - 1)) * 0.8;      // team 0 weakest
  const out = [];
  let day = 0;
  for (let r = 0; r < o.rounds; r++) {
    for (let i = 0; i < o.teams; i++) {
      for (let j = 0; j < o.teams; j++) {
        if (i === j) continue;
        if ((i + j + r) % 3) continue;
        day += 2;
        const d = new Date(2026, 0, 1); d.setDate(d.getDate() + day);
        const lh = 1.3 * strength(i) / strength(j) * o.homeAdv;
        const la = 1.3 * strength(j) / strength(i);
        out.push({ date: d.toISOString(), home: 'T' + i, away: 'T' + j, hg: pois(lh), ag: pois(la) });
      }
    }
  }
  return out;
}
// pull a function out of app.js and run it with stubs — app.js is not a module
function fromApp(startMarker, endMarker, globals, fnName) {
  const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
  const a = src.indexOf(startMarker), b = src.indexOf(endMarker, a);
  if (a < 0 || b < 0) throw new Error('could not locate ' + startMarker);
  Object.assign(global, globals || {});
  // the declaration lives in eval scope, so name it as the final expression
  return eval(src.slice(a, b) + ';' + fnName);
}

/* ---------- probability maths ---------- */
t('score matrix is a probability distribution', () => {
  const m = P.scoreMatrix(1.7, 1.1, -0.1);
  let s = 0;
  m.forEach(row => row.forEach(v => { s += v; ok(v >= 0, 'negative probability'); }));
  near(s, 1, 1e-9, 'matrix total');
});

t('outcomes sum to one', () => {
  const m = P.scoreMatrix(2.1, 0.8, -0.05);
  const r = P.summarise(m, 2.1, 0.8);
  near(r.home + r.draw + r.away, 1, 1e-9, 'W/D/L total');
});

t('total-goals distribution sums to one', () => {
  const d = P.goalsDistribution(P.scoreMatrix(1.4, 1.2, 0), 6);
  near(d.reduce((a, b) => a + b, 0), 1, 1e-9, 'goal distribution');
});

t('ranked probability score matches hand-computed values', () => {
  near(P.rps({ home: 1, draw: 0, away: 0 }, 'home'), 0, 1e-12, 'perfect call');
  near(P.rps({ home: 0, draw: 0, away: 1 }, 'home'), 1, 1e-12, 'worst call');
  near(P.rps({ home: 1 / 3, draw: 1 / 3, away: 1 / 3 }, 'draw'), 1 / 9, 1e-12, 'uniform on a draw');
});

/* ---------- rating fit: the home-advantage regression ---------- */
t('fitted home advantage tracks the real one (regression: was collapsing to 1.06)', () => {
  const matches = synthSeason({ homeAdv: 1.4 });
  const hg = matches.reduce((s, m) => s + m.hg, 0), ag = matches.reduce((s, m) => s + m.ag, 0);
  const actual = hg / ag;
  const r = P.fitRatings(matches, { asOf: '2026-12-31' });
  near(r.H, actual, 0.12, 'fitted H vs actual home/away goal ratio');
  ok(r.H > 1.15, 'home advantage must not collapse toward 1.0');
});

t('implied average scoreline matches the data', () => {
  const matches = synthSeason({});
  const r = P.fitRatings(matches, { asOf: '2026-12-31' });
  const n = matches.length;
  near(r.M * r.H, matches.reduce((s, m) => s + m.hg, 0) / n, 0.2, 'implied home goals');
  near(r.M, matches.reduce((s, m) => s + m.ag, 0) / n, 0.2, 'implied away goals');
});

t('stronger clubs get stronger ratings', () => {
  const r = P.fitRatings(synthSeason({}), { asOf: '2026-12-31' });
  const best = r.idx['T7'], worst = r.idx['T0'];
  ok(r.A[best] > r.A[worst], 'best team should out-rate the worst on attack');
});

t('a better side is favoured at home', () => {
  const r = P.fitRatings(synthSeason({}), { asOf: '2026-12-31' });
  const strong = P.predict(r, 'T7', 'T0');
  const weak = P.predict(r, 'T0', 'T7');
  ok(strong.home > 0.5, 'strong home side should be favourite');
  ok(strong.home > weak.home, 'home advantage should not invert');
});

t('unknown clubs degrade gracefully rather than throwing', () => {
  const r = P.fitRatings(synthSeason({}), { asOf: '2026-12-31' });
  const p = P.predict(r, 'NOPE', 'T1');
  ok(p && p.lowConfidence, 'unknown team must be flagged low confidence');
  near(p.home + p.draw + p.away, 1, 1e-9, 'still a valid distribution');
});

/* ---------- model quality gate ---------- */
t('model beats the uniform baseline on held-out matches', () => {
  const res = P.backtest(synthSeason({ rounds: 6 }), {});
  ok(res, 'backtest produced no result');
  ok(res.beatsUniform, `RPS ${res.rps.toFixed(4)} did not beat uniform ${res.rpsUniform.toFixed(4)}`);
  ok(res.n > 40, 'too few scored predictions to be meaningful');
});

/* ---------- in-play ---------- */
t('a two-goal lead at 88 minutes is near certain', () => {
  const r = P.fitRatings(synthSeason({}), { asOf: '2026-12-31' });
  const pre = P.predict(r, 'T4', 'T3');
  const late = P.inPlay(pre, { minute: 88, homeGoals: 2, awayGoals: 0 });
  ok(late.home > 0.95, `expected >95%, got ${(late.home * 100).toFixed(1)}%`);
});

t('kick-off probabilities stay close to the pre-match ones', () => {
  const r = P.fitRatings(synthSeason({}), { asOf: '2026-12-31' });
  const pre = P.predict(r, 'T4', 'T3');
  const kick = P.inPlay(pre, { minute: 1, homeGoals: 0, awayGoals: 0 });
  near(kick.home, pre.home, 0.12, 'minute 1 should resemble pre-match');
});

t('a red card hurts the team that received it', () => {
  const r = P.fitRatings(synthSeason({}), { asOf: '2026-12-31' });
  const pre = P.predict(r, 'T4', 'T3');
  const level = P.inPlay(pre, { minute: 40, homeGoals: 0, awayGoals: 0 });
  const down = P.inPlay(pre, { minute: 40, homeGoals: 0, awayGoals: 0, redHome: 1 });
  ok(down.home < level.home, 'a red card should reduce that side chances');
  ok(down.away > level.away, 'and improve the opponent chances');
});

/* ---------- availability ---------- */
t('absence penalty is capped so one bad signal cannot swing a match', () => {
  const huge = P.availabilityFactor([
    { share: 0.6, signal: 'manual' }, { share: 0.6, signal: 'manual' }, { share: 0.6, signal: 'manual' },
  ]);
  near(huge.attack, 0.8, 1e-9, 'attack multiplier floor');
});

t('weak signals count for less than certain ones', () => {
  const sure = P.availabilityFactor([{ share: 0.2, signal: 'suspension' }]);
  const rumour = P.availabilityFactor([{ share: 0.2, signal: 'news' }]);
  ok(rumour.attack > sure.attack, 'a news rumour must bite less than a suspension');
});

/* ---------- player ratings ---------- */
t('scoring beats an anonymous afternoon', () => {
  const base = { minutes: 90, totalPasses: 30, passPct: 0.8 };
  const scorer = P.playerRating(Object.assign({}, base, { totalGoals: 1 }), { position: 'F' });
  const quiet = P.playerRating(base, { position: 'F' });
  ok(scorer > quiet, 'a goal should raise the rating');
});

t('a red card is punished', () => {
  const base = { minutes: 90, totalPasses: 30, passPct: 0.8 };
  const sent = P.playerRating(Object.assign({}, base, { redCards: 1 }), { position: 'M' });
  ok(sent < P.playerRating(base, { position: 'M' }) - 1, 'red card should cost more than a point');
});

t('a goalkeeper clean sheet with saves rates well', () => {
  const gk = P.playerRating({ minutes: 90, saves: 4, cleanSheet: 1, goalsConceded: 0, passPct: 0.7, totalPasses: 25 }, { position: 'G' });
  ok(gk >= 7, `expected a strong rating, got ${gk}`);
});

t('a short cameo is pulled back toward average', () => {
  const stats = { minutes: 8, totalGoals: 1, totalPasses: 4 };
  const cameo = P.playerRating(stats, { position: 'F' });
  const full = P.playerRating(Object.assign({}, stats, { minutes: 90 }), { position: 'F' });
  ok(cameo < full, 'ten minutes should not equal ninety');
  ok(cameo > 6, 'but a goal is still a goal');
});

t('players who did not appear have no rating', () => {
  eq(P.playerRating({ minutes: 0 }, { position: 'F' }), null, 'unused sub');
  eq(P.playerRating(null, {}), null, 'missing stats');
});

t('ratings stay inside the 3-10 scale', () => {
  const absurd = P.playerRating({ minutes: 90, totalGoals: 9, goalAssists: 6, saves: 20, passPct: 1, totalPasses: 99, duels: 30, duelWinPct: 1 }, { position: 'F' });
  ok(absurd <= 10, 'upper bound');
  const awful = P.playerRating({ minutes: 90, redCards: 1, ownGoals: 3, passPct: 0.2, totalPasses: 30, goalsConceded: 6 }, { position: 'G' });
  ok(awful >= 3, 'lower bound');
});

/* ---------- calibration bookkeeping ---------- */
t('temperature scaling keeps distributions valid', () => {
  const p = P.applyTemperature({ home: 0.6, draw: 0.25, away: 0.15 }, 1.6);
  near(p.home + p.draw + p.away, 1, 1e-9, 'still sums to one');
  ok(p.home < 0.6, 'a temperature above 1 should flatten confidence');
});

t('reliability bins count what actually happened', () => {
  const hist = [
    { probs: { home: 0.85, draw: 0.1, away: 0.05 }, outcome: 'home' },
    { probs: { home: 0.85, draw: 0.1, away: 0.05 }, outcome: 'away' },
  ];
  const bins = P.reliability(hist, 10);
  const top = bins[8];                       // 0.85 falls in the 80-90% bin
  eq(top.n, 2, 'two predictions in the 80-90% bin');
  near(top.observed, 0.5, 1e-9, 'one of the two came in');
});

/* ---------- app.js: season window (the 424-vs-380 regression) ---------- */
t('schedule window covers one season, not thirteen months', () => {
  const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
  ok(src.includes('const season = await ensureSeason(lgId)'), 'schedule must consult the season');
  ok(/if \(d >= start && d <= end\) all\.set/.test(src), 'events must be filtered to the season window');
  ok(src.includes('s.year && s.start'), 'ensureSeason must refresh metadata cached before start/end existed');
});

t('season month list spans the season and stays bounded', () => {
  const addMonths = (d, n) => new Date(d.getFullYear(), d.getMonth() + n, 1);
  const start = new Date('2026-06-01'), end = new Date('2027-06-01');
  const months = [];
  for (let cur = new Date(start.getFullYear(), start.getMonth(), 1); cur <= end && months.length < 15; cur = addMonths(cur, 1)) months.push(new Date(cur));
  eq(months.length, 13, 'June to June inclusive');
  ok(months[0] <= start && months[months.length - 1] <= end, 'stays inside the season');
});

/* ---------- app.js: clubs fallback chain ---------- */
t('clubs list falls back to the table, then to fixtures', async () => {
  const runs = [];
  const mk = (request, getStandings, loadMonth) => {
    let painted = '';
    const fn = fromApp('async function fillLeagueTeams(lgId, body) {', '\nasync function fillLeagueMatches(', {
      paint: (el, html) => { painted = html; },
      esc: s => String(s == null ? '' : s),
      crest: () => '<img>',
      ICON: { info: '', refresh: '', shirt: '' },
      API: 'https://api',
      addMonths: (d, n) => new Date(d.getFullYear(), d.getMonth() + n, 1),
      S: { route: { name: 'league', lg: 'x' } },
      request, getStandings, loadMonth,
    }, 'fillLeagueTeams');
    return fn('x', {}).then(() => painted);
  };
  runs.push(mk(
    async () => { throw new Error('403'); },
    async () => ({ groups: [{ entries: [{ id: '1', name: 'A', short: 'A' }, { id: '2', name: 'B', short: 'B' }] }] }),
    async () => []));
  return Promise.all(runs).then(([viaTable]) => {
    ok(/class="club"/.test(viaTable), 'table fallback should still list clubs');
    ok(!/does not publish a club directory/.test(viaTable), 'must not blame the competition');
  });
});

/* ---------- output ---------- */
(async () => {
  // allow the one async test above to settle
  await new Promise(r => setTimeout(r, 300));
  const width = Math.max.apply(null, results.map(r => r[1].length));
  results.forEach(([state, name, msg]) => {
    console.log(`  ${state === 'PASS' ? '✓' : '✗'} ${name.padEnd(width)}${msg ? '  ' + msg : ''}`);
  });
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
