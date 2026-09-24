'use strict';
/* Offline verification harness for the prediction model.
   Usage: node backtest.js [league] [startYYYYMM] [months]
   Fetches a completed season from the same feeds the site uses, then runs a
   walk-forward backtest: fit on earlier matchdays only, predict the next. */

const Predict = require('./predictions.js');
const API = 'https://site.api.espn.com/apis/site/v2/sports/soccer';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJSON(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(600 * Math.pow(2, i));
    }
  }
}

function monthsFrom(start, count) {
  const out = [];
  let y = +String(start).slice(0, 4), m = +String(start).slice(4, 6);
  for (let i = 0; i < count; i++) {
    out.push(`${y}${String(m).padStart(2, '0')}`);
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

async function loadSeason(lg, start, count) {
  const matches = [];
  for (const m of monthsFrom(start, count)) {
    const d = await getJSON(`${API}/${lg}/scoreboard?dates=${m}&limit=400`);
    let n = 0;
    (d.events || []).forEach(e => {
      const c = (e.competitions || [])[0] || {};
      const st = (e.status && e.status.type) || {};
      if (st.state !== 'post') return;
      const cs = c.competitors || [];
      const h = cs.find(x => x.homeAway === 'home'), a = cs.find(x => x.homeAway === 'away');
      if (!h || !a) return;
      const hg = Number(h.score), ag = Number(a.score);
      if (!isFinite(hg) || !isFinite(ag)) return;
      matches.push({ date: e.date, home: h.team.id, away: a.team.id, hg, ag,
                     homeName: h.team.shortDisplayName, awayName: a.team.shortDisplayName });
      n++;
    });
    process.stdout.write(`  ${m}: ${n} matches\n`);
    await sleep(700);
  }
  return matches;
}

function pct(x) { return (x * 100).toFixed(1) + '%'; }

(async () => {
  const lg = process.argv[2] || 'eng.1';
  const start = process.argv[3] || '202508';
  const count = Number(process.argv[4] || 10);
  console.log(`\nLoading ${lg} from ${start} (${count} months)...`);
  const matches = await loadSeason(lg, start, count);
  console.log(`\nTotal finished matches: ${matches.length}`);
  if (matches.length < 60) { console.log('Not enough data to backtest.'); return; }

  const res = Predict.backtest(matches, {});
  if (!res) { console.log('Backtest produced no scored predictions.'); return; }

  console.log(`\n=== WALK-FORWARD BACKTEST: ${lg} ===`);
  console.log(`  predictions scored : ${res.n}`);
  console.log(`  RPS (model)        : ${res.rps.toFixed(4)}   <-- lower is better`);
  console.log(`  RPS (uniform)      : ${res.rpsUniform.toFixed(4)}   (the gate: model must beat this)`);
  console.log(`  RPS (always home)  : ${res.rpsAlwaysHome.toFixed(4)}`);
  console.log(`  log loss           : ${res.logLoss.toFixed(4)}`);
  console.log(`  outcome accuracy   : ${pct(res.accuracy)}`);
  console.log(`  beats uniform      : ${res.beatsUniform ? 'YES' : 'NO'}`);
  console.log(`  fitted temperature : ${res.temperature}  (1.0 = already calibrated)`);

  console.log(`\n  calibration (predicted -> actually happened):`);
  res.reliability.forEach(b => {
    if (!b.n) return;
    const bar = '#'.repeat(Math.round((b.observed || 0) * 40));
    console.log(`    ${(b.lo * 100).toFixed(0).padStart(3)}-${(b.hi * 100).toFixed(0).padStart(3)}%  n=${String(b.n).padStart(4)}  observed=${pct(b.observed).padStart(6)}  ${bar}`);
  });

  const improvement = ((res.rpsUniform - res.rps) / res.rpsUniform) * 100;
  console.log(`\n  => ${improvement.toFixed(1)}% better than guessing uniformly\n`);
})();
