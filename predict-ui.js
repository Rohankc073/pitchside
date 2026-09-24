'use strict';

/* ============================================================
   Pitchside — prediction integration + UI
   Bridges the pure model in predictions.js to the app: gathers
   training data, works out who is unavailable, keeps the ledger of
   what we predicted and whether it came true, and renders it.
   ============================================================ */

(function () {
  const P = window.Predict;
  const ps = () => window.PS;

  const load = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k) || 'null'); return v == null ? d : v; } catch (e) { return d; } };
  let saveTimer = null;
  const ST = {
    ratings: load('pitchside.ratings', {}),
    ledger: load('pitchside.ledger', []),
    manual: load('pitchside.manualOut', {}),
    moves: load('pitchside.moves', {}),
    xg: load('pitchside.xg', {}),
  };
  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        ST.ledger = ST.ledger.slice(-500);                       // keep storage bounded
        localStorage.setItem('pitchside.ratings', JSON.stringify(ST.ratings));
        localStorage.setItem('pitchside.ledger', JSON.stringify(ST.ledger));
        localStorage.setItem('pitchside.manualOut', JSON.stringify(ST.manual));
        localStorage.setItem('pitchside.moves', JSON.stringify(ST.moves));
        localStorage.setItem('pitchside.xg', JSON.stringify(ST.xg));
      } catch (e) { /* quota or private mode — predictions still work in-session */ }
    }, 400);
  }

  const RATING_TTL = 12 * 3600 * 1000;
  // never display 0% or 100%: football has no certainties, and a rounded
  // "100%" reads as a promise the model cannot make
  const pct = x => `${Math.min(99, Math.max(1, Math.round(x * 100)))}%`;
  const pct1 = x => `${(x * 100).toFixed(1)}%`;

  /* ---------------- training data ---------------- */
  async function trainingMatches(lgId) {
    const A = ps();
    const now = new Date();
    const months = [];
    for (let i = 0; i <= 12; i++) months.push(A.addMonths(now, -i));
    const out = [];
    await Promise.all(months.map(async m => {
      try {
        const events = await A.loadMonth(lgId, m);
        events.forEach(e => {
          if (A.statusOf(e).kind !== 'post') return;
          const hg = Number(e.home.score), ag = Number(e.away.score);
          if (!isFinite(hg) || !isFinite(ag) || !e.home.id || !e.away.id) return;
          out.push({ date: e.date, home: e.home.id, away: e.away.id, hg, ag, id: e.id, details: e.details,
            homeName: e.home.name, awayName: e.away.name });
        });
      } catch (err) { /* a month with no fixtures is normal */ }
    }));
    return out.sort((a, b) => new Date(a.date) - new Date(b.date));
  }

  const trainingCache = new Map();
  async function getTraining(lgId) {
    if (!trainingCache.has(lgId)) trainingCache.set(lgId, trainingMatches(lgId));
    return trainingCache.get(lgId);
  }

  async function ratingsFor(lgId, force) {
    const cached = ST.ratings[lgId];
    if (!force && cached && Date.now() - cached.fittedAt < RATING_TTL) return cached;
    const matches = await getTraining(lgId);
    const r = P.fitRatings(matches, {});
    if (r) { ST.ratings[lgId] = r; persist(); }
    return r;
  }

  /* ---------------- who is missing ----------------
     ESPN publishes no injury data for football, so availability is assembled
     from four weaker signals, each carrying its own confidence weight. */

  // share of a club's goals each player is responsible for
  const sharesCache = new Map();
  async function attackShares(lgId, teamId) {
    const key = `${lgId}|${teamId}`;
    if (sharesCache.has(key)) return sharesCache.get(key);
    const A = ps();
    const p = (async () => {
      try {
        const season = await A.ensureSeason(lgId);
        const data = await A.request(`${A.CORE}/${lgId}/seasons/${season.year}/types/${season.type || 1}/teams/${teamId}/leaders?lang=en`, { ttl: 6 * 3600 * 1000 });
        const cat = (data.categories || []).find(c => c.name === 'goalsLeaders' || c.name === 'goals');
        const rows = ((cat && cat.leaders) || []).map(l => ({
          id: (String(l.athlete && l.athlete.$ref || '').match(/\/(\d+)\?/) || [])[1],
          goals: Number(l.value) || 0,
        })).filter(r => r.id && r.goals > 0);
        const total = rows.reduce((s, r) => s + r.goals, 0) || 1;
        const map = {};
        rows.forEach(r => { map[r.id] = r.goals / total; });
        return map;
      } catch (err) { return {}; }
    })();
    sharesCache.set(key, p);
    return p;
  }

  // a player sent off in their club's most recent match misses the next one
  function suspensions(training, teamId) {
    const played = training.filter(m => String(m.home) === String(teamId) || String(m.away) === String(teamId));
    const last = played[played.length - 1];
    if (!last || !last.details) return [];
    const out = [];
    last.details.forEach(d => {
      if (!d.redCard) return;
      if (!d.team || String(d.team.id) !== String(teamId)) return;
      const ath = (d.athletesInvolved || [])[0];
      if (ath) out.push({ id: String(ath.id), name: ath.displayName || ath.shortName || 'Player', signal: 'suspension' });
    });
    return out;
  }

  // regulars who have stopped appearing — cannot tell injury from rotation
  async function lineupAbsences(lgId, teamId, training) {
    const A = ps();
    const played = training.filter(m => String(m.home) === String(teamId) || String(m.away) === String(teamId)).slice(-3);
    if (played.length < 2) return [];
    const squads = [];
    for (const m of played) {
      try {
        const sum = await A.request(`${A.API}/${lgId}/summary?event=${m.id}`, { ttl: 24 * 3600 * 1000 });
        const roster = (sum.rosters || []).find(r => String(r.team && r.team.id) === String(teamId));
        if (!roster) continue;
        const starters = {}, present = {};
        (roster.roster || []).forEach(p => {
          const a = p.athlete || {};
          if (!a.id) return;
          present[a.id] = a.displayName || '';
          if (p.starter) starters[a.id] = a.displayName || '';
        });
        squads.push({ starters, present });
      } catch (err) { /* summary may be unavailable */ }
    }
    if (squads.length < 2) return [];
    const latest = squads[squads.length - 1];
    const earlier = squads.slice(0, -1);
    const out = [];
    const startCount = {};
    earlier.forEach(s => Object.keys(s.starters).forEach(id => { startCount[id] = (startCount[id] || 0) + 1; }));
    Object.keys(startCount).forEach(id => {
      if (startCount[id] >= Math.max(1, earlier.length) && !latest.present[id]) {
        const name = earlier.map(s => s.starters[id]).filter(Boolean)[0] || 'Player';
        out.push({ id, name, signal: 'lineup' });
      }
    });
    return out;
  }

  // last resort: club news mentioning a squad member near injury wording
  const INJURY_WORDS = /(injur|ruled out|sidelined|hamstring|knee|ankle|calf|groin|surgery|doubt|fitness|out for|miss(es|ing)? the|suspend)/i;
  async function newsAbsences(lgId, teamId, squadNames) {
    const A = ps();
    if (!squadNames || !squadNames.length) return [];
    try {
      const data = await A.request(`${A.API}/${lgId}/news?limit=25`, { ttl: 3 * 3600 * 1000 });
      const out = [];
      (data.articles || []).forEach(art => {
        const text = `${art.headline || ''} ${art.description || ''}`;
        if (!INJURY_WORDS.test(text)) return;
        squadNames.forEach(p => {
          const surname = String(p.name || '').split(/\s+/).slice(-1)[0];
          if (surname.length < 4) return;
          if (new RegExp(`\\b${surname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text)) {
            out.push({ id: p.id, name: p.name, signal: 'news', note: art.headline,
                       link: (art.links && art.links.web && art.links.web.href) || '' });
          }
        });
      });
      const seen = new Set();
      return out.filter(x => (seen.has(x.id) ? false : seen.add(x.id)));
    } catch (err) { return []; }
  }

  async function squadList(lgId, teamId) {
    const A = ps();
    try {
      const data = await A.request(`${A.API}/${lgId}/teams/${teamId}/roster`, { ttl: 24 * 3600 * 1000 });
      return (data.athletes || []).map(a => (a.items ? a.items : [a])).flat()
        .map(p => ({ id: String(p.id), name: p.displayName, pos: (p.position && p.position.abbreviation) || '' }));
    } catch (err) { return []; }
  }

  async function absencesFor(lgId, teamId, training) {
    const [shares, squad] = await Promise.all([attackShares(lgId, teamId), squadList(lgId, teamId)]);
    const byId = {};
    squad.forEach(p => { byId[p.id] = p; });

    const manual = (ST.manual[String(teamId)] || []).map(p => ({ id: String(p.id), name: p.name, signal: 'manual' }));
    const susp = suspensions(training, teamId);
    const [lineup, news] = await Promise.all([
      lineupAbsences(lgId, teamId, training),
      newsAbsences(lgId, teamId, squad),
    ]);

    const merged = new Map();
    // strongest signal wins when several flag the same player
    [...news, ...lineup, ...susp, ...manual].forEach(a => {
      const prev = merged.get(a.id);
      const rank = { news: 1, lineup: 2, suspension: 3, manual: 4 };
      if (!prev || rank[a.signal] > rank[prev.signal]) merged.set(a.id, a);
    });

    return [...merged.values()].map(a => {
      const pos = (byId[a.id] && byId[a.id].pos) || '';
      return Object.assign({}, a, {
        name: a.name || (byId[a.id] && byId[a.id].name) || 'Player',
        share: shares[a.id] || 0,
        defensive: /^(G|GK|D|CB|CD|LB|RB|SW|WB)/.test(pos.toUpperCase()),
        pos,
      });
    }).filter(a => a.share > 0 || a.signal === 'manual' || a.signal === 'suspension');
  }

  /* ---------------- prediction ---------------- */
  async function predictFixture(lgId, homeId, awayId, opts) {
    const ratings = await ratingsFor(lgId);
    if (!ratings) return null;
    const o = opts || {};
    let homeAbs = [], awayAbs = [];
    if (o.withAvailability) {
      const training = await getTraining(lgId);
      [homeAbs, awayAbs] = await Promise.all([
        absencesFor(lgId, homeId, training).catch(() => []),
        absencesFor(lgId, awayId, training).catch(() => []),
      ]);
    }
    const pred = P.predict(ratings, homeId, awayId, { homeAbsences: homeAbs, awayAbsences: awayAbs });
    if (!pred) return null;
    pred.homeAbsences = homeAbs;
    pred.awayAbsences = awayAbs;
    pred.ratingMatches = ratings.matches;
    return pred;
  }

  /* ---------------- ledger ---------------- */
  function ledgerKey(matchId) { return String(matchId); }
  function recordPrediction(match, pred, phase) {
    if (!pred) return;
    const id = ledgerKey(match.id);
    const existing = ST.ledger.find(e => e.id === id && e.phase === 'pre');
    if (phase === 'pre' && existing) return;
    if (phase === 'pre') {
      ST.ledger.push({
        id, lg: match.lg, date: match.date, ts: Date.now(), phase: 'pre',
        home: match.home.name, away: match.away.name,
        probs: { home: pred.home, draw: pred.draw, away: pred.away },
        eh: pred.expectedHome, ea: pred.expectedAway,
        absences: (pred.homeAbsences || []).length + (pred.awayAbsences || []).length,
      });
      persist();
    }
  }
  function recordMove(matchId, minute, probs) {
    const id = ledgerKey(matchId);
    const arr = ST.moves[id] || [];
    const last = arr[arr.length - 1];
    if (last && last.m === minute) return;
    arr.push({ m: minute, h: +probs.home.toFixed(3), d: +probs.draw.toFixed(3), a: +probs.away.toFixed(3) });
    ST.moves[id] = arr.slice(-60);
    const keys = Object.keys(ST.moves);
    if (keys.length > 25) delete ST.moves[keys[0]];
    persist();
  }
  function settle(matchId, hg, ag) {
    const id = ledgerKey(matchId);
    let changed = false;
    ST.ledger.forEach(e => {
      if (e.id !== id || e.settled) return;
      e.outcome = P.outcomeOf(hg, ag);
      e.score = `${hg}-${ag}`;
      e.rps = P.rps(e.probs, e.outcome);
      e.rpsUniform = P.rps({ home: 1 / 3, draw: 1 / 3, away: 1 / 3 }, e.outcome);
      e.correct = P.pickOf(e.probs) === e.outcome;
      e.settled = true;
      changed = true;
    });
    if (changed) persist();
    return ST.ledger.find(e => e.id === id && e.settled) || null;
  }
  function ledgerStats() {
    const settled = ST.ledger.filter(e => e.settled);
    if (!settled.length) return { n: 0, pending: ST.ledger.length };
    const sum = (f) => settled.reduce((s, e) => s + f(e), 0);
    return {
      n: settled.length,
      pending: ST.ledger.length - settled.length,
      correct: sum(e => e.correct ? 1 : 0),
      accuracy: sum(e => e.correct ? 1 : 0) / settled.length,
      rps: sum(e => e.rps) / settled.length,
      rpsUniform: sum(e => e.rpsUniform) / settled.length,
      reliability: P.reliability(settled.map(e => ({ probs: e.probs, outcome: e.outcome }))),
      settled,
    };
  }

  window.PredictUI = {
    ST, persist, ratingsFor, getTraining, predictFixture, absencesFor,
    recordPrediction, recordMove, settle, ledgerStats, pct, pct1,
  };
})();

/* ============================================================
   Rendering
   ============================================================ */
(function () {
  const U = window.PredictUI;
  const P = window.Predict;
  const ps = () => window.PS;
  const pct = U.pct;

  const SIGNAL_LABEL = {
    suspension: 'Suspended', manual: 'Marked out',
    lineup: 'Missing recently', news: 'Reported doubt',
  };
  const SIGNAL_NOTE = {
    suspension: 'Sent off in their last match — automatically banned',
    manual: 'You marked this player unavailable',
    lineup: 'Started recently then dropped out of the squad — could be injury, rotation or a suspension',
    news: 'Named in a news report alongside injury wording — unconfirmed',
  };

  function barRow(cls, name, p) {
    const A = ps();
    return `<div class="pbar ${cls}">
      <span class="pb-name">${A.esc(name)}</span>
      <span class="pb-track"><i style="width:${(p * 100).toFixed(1)}%"></i></span>
      <b>${pct(p)}</b></div>`;
  }

  function absenceChips(list, side) {
    const A = ps();
    if (!list || !list.length) return '';
    return `<div class="abs-group"><span class="abs-side">${A.esc(side)}</span>
      ${list.map(a => `<span class="abs-chip ${a.signal}" title="${A.esc(SIGNAL_NOTE[a.signal] || '')}">
        ${A.esc(a.name)}<i>${A.esc(SIGNAL_LABEL[a.signal] || a.signal)}</i>
        ${a.share > 0.01 ? `<em>${Math.round(a.share * 100)}% of goals</em>` : ''}</span>`).join('')}</div>`;
  }


  /* ---------------- analytics building blocks ---------------- */

  const fmt1 = v => (Math.round(v * 10) / 10).toFixed(1);
  const fmt2 = v => (Math.round(v * 100) / 100).toFixed(2);

  function formStrip(recent) {
    const A = ps();
    if (!recent || !recent.length) return '<span class="form-empty">no recent matches</span>';
    return `<span class="form-strip">${recent.slice(0, 6).map(r =>
      `<i class="${r.res}" title="${A.esc(`${r.atHome ? 'vs' : 'at'} ${r.opponent} ${r.gf}-${r.ga}`)}">${r.res}</i>`).join('')}</span>`;
  }

  // one comparison row: two values either side of a label, with a split bar
  function cmpRow(label, hv, av, opts) {
    const o = opts || {};
    const hn = Number(o.hNum != null ? o.hNum : hv) || 0;
    const an = Number(o.aNum != null ? o.aNum : av) || 0;
    const total = hn + an;
    const hp = total > 0 ? (hn / total) * 100 : 50;
    const better = o.lowerBetter ? (hn < an ? 'h' : an < hn ? 'a' : '') : (hn > an ? 'h' : an > hn ? 'a' : '');
    return `<div class="cmp-row">
      <span class="cmp-v h ${better === 'h' ? 'win' : ''}">${hv}</span>
      <span class="cmp-mid"><i class="cmp-label">${label}</i>
        <span class="cmp-bar"><b class="h" style="width:${hp.toFixed(1)}%"></b><b class="a" style="width:${(100 - hp).toFixed(1)}%"></b></span>
      </span>
      <span class="cmp-v a ${better === 'a' ? 'win' : ''}">${av}</span>
    </div>`;
  }

  /* ---------------- plain-language visuals ----------------
     Deliberately simple: labelled horizontal bars, no axes, no grids, no
     scatter plots. Every chart says in words what it means, and probabilities
     are restated as "out of 100 matches" because percentages alone don't land. */

  function scorelineBars(pred, ctx) {
    const A = ps();
    const top = (pred.topScores || []).slice(0, 6);
    if (!top.length) return '';
    const max = top[0].p || 1;
    const side = s => s.h > s.a ? 'h' : s.h === s.a ? 'd' : 'a';
    const who = s => s.h > s.a ? A.esc(ctx.home.name) : s.h === s.a ? 'draw' : A.esc(ctx.away.name);
    return `<div class="viz">
      <div class="viz-head"><b>Most likely final scores</b>
        <span>${A.esc(ctx.home.name)} score shown first</span></div>
      ${top.map(s => `<div class="vrow">
        <span class="vlab score">${s.h}–${s.a}</span>
        <span class="vtrack"><i class="${side(s)}" style="width:${((s.p / max) * 100).toFixed(1)}%"></i></span>
        <span class="vval">${(s.p * 100).toFixed(1)}%</span>
        <span class="vwho">${who(s)}</span>
      </div>`).join('')}
      <p class="viz-note">Read it like this: if this match were played 100 times,
        about <b>${Math.round(top[0].p * 100)}</b> of them would end <b>${top[0].h}–${top[0].a}</b>.</p>
    </div>`;
  }

  function goalsBars(matrix) {
    const dist = P.goalsDistribution(matrix, 5);
    const max = Math.max.apply(null, dist) || 1;
    const best = dist.indexOf(max);
    const labels = ['0 goals', '1 goal', '2 goals', '3 goals', '4 goals', '5 or more'];
    return `<div class="viz">
      <div class="viz-head"><b>How many goals in total?</b><span>both teams combined</span></div>
      ${dist.map((p, i) => `<div class="vrow">
        <span class="vlab">${labels[i]}</span>
        <span class="vtrack"><i class="${i === best ? 'best' : 'g'}" style="width:${((p / max) * 100).toFixed(1)}%"></i></span>
        <span class="vval">${Math.round(p * 100)}%</span>
        ${i === best ? '<span class="vwho">most likely</span>' : '<span class="vwho"></span>'}
      </div>`).join('')}
      <p class="viz-note">${[
        "A goalless draw is the single most likely outcome.",
        "A <b>one-goal</b> match is the single most likely outcome.",
        "<b>Two goals</b> in total is the single most likely outcome.",
        "<b>Three goals</b> in total is the single most likely outcome.",
        "<b>Four goals</b> in total is the single most likely outcome.",
        "A <b>high-scoring</b> match is the single most likely outcome.",
      ][best]}</p>
    </div>`;
  }

  /* replaces the old scatter plot: a plain "Nth best of M" bar per club */
  function strengthRanks(ranks, ctx) {
    const A = ps();
    const hr = ranks[String(ctx.home.id)], ar = ranks[String(ctx.away.id)];
    if (!hr || !ar) return '';
    const place = (rank, of) => `${ord(rank)} of ${of}`;
    const share = (rank, of) => (((of - rank + 1) / of) * 100).toFixed(1);
    const row = (team, rank, of, cls) => `<div class="vrow">
      <span class="vlab team">${A.esc(team)}</span>
      <span class="vtrack"><i class="${cls}" style="width:${share(rank, of)}%"></i></span>
      <span class="vval rank">${place(rank, of)}</span>
    </div>`;
    const better = (a, b, nameA, nameB) => a < b ? nameA : b < a ? nameB : null;
    const atkWin = better(hr.attackRank, ar.attackRank, ctx.home.name, ctx.away.name);
    const defWin = better(hr.defenceRank, ar.defenceRank, ctx.home.name, ctx.away.name);
    return `<div class="viz">
      <div class="viz-head"><b>How good is each team?</b><span>ranked against every club in this competition</span></div>
      <div class="viz-sub">Scoring goals — longer is better</div>
      ${row(ctx.home.name, hr.attackRank, hr.of, 'h')}
      ${row(ctx.away.name, ar.attackRank, ar.of, 'a')}
      <div class="viz-sub">Stopping goals — longer is better</div>
      ${row(ctx.home.name, hr.defenceRank, hr.of, 'h')}
      ${row(ctx.away.name, ar.defenceRank, ar.of, 'a')}
      <p class="viz-note">${
        atkWin && defWin && atkWin === defWin
          ? `<b>${A.esc(atkWin)}</b> rank higher at both ends of the pitch — better at scoring and better at stopping goals.`
          : `${atkWin ? `<b>${A.esc(atkWin)}</b> are the better attacking side` : 'Both attacks rank alike'}${defWin ? `, while <b>${A.esc(defWin)}</b> have the stronger defence` : ''}.`
      }</p>
    </div>`;
  }

  /* live only: how the chances have shifted during the match */
  function movementBars(matchId, ctx, pred) {
    const A = ps();
    const pts = U.ST.moves[String(matchId)] || [];
    if (pts.length < 2) return '';
    const first = pts[0], last = pts[pts.length - 1];
    const delta = (a, b) => {
      const d = Math.round((b - a) * 100);
      return d === 0 ? 'unchanged' : d > 0 ? `up ${d} points` : `down ${Math.abs(d)} points`;
    };
    return `<div class="viz">
      <div class="viz-head"><b>How the chances have moved</b><span>since the ${first.m}th minute</span></div>
      <div class="mv-rows">
        <div class="mv-row"><span>${A.esc(ctx.home.name)}</span>
          <b>${Math.round(first.h * 100)}% → ${Math.round(last.h * 100)}%</b><i>${delta(first.h, last.h)}</i></div>
        <div class="mv-row"><span>Draw</span>
          <b>${Math.round(first.d * 100)}% → ${Math.round(last.d * 100)}%</b><i>${delta(first.d, last.d)}</i></div>
        <div class="mv-row"><span>${A.esc(ctx.away.name)}</span>
          <b>${Math.round(first.a * 100)}% → ${Math.round(last.a * 100)}%</b><i>${delta(first.a, last.a)}</i></div>
      </div>
    </div>`;
  }

  /* ---------------- factor cards ----------------
     Replaces the paragraph explanation. Each card is one reason, readable at a
     glance: icon, two-word label, both clubs' numbers, and the stronger side
     marked with a tick as well as weight — never colour alone. */

  const FIC = {
    attack: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m12 7.4 3.6 2.6-1.4 4.3h-4.4L8.4 10z"/></svg>',
    defence: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 5 6v5.5c0 4.2 3 8.1 7 9.5 4-1.4 7-5.3 7-9.5V6z"/></svg>',
    home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z"/></svg>',
    form: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3 16 5-5 4 4 8-8"/><path d="M15 7h5v5"/></svg>',
    goals: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 20V9l9-5 9 5v11"/><path d="M3 13h18M9 20V9M15 20V9"/></svg>',
    tick: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 5 5L19 7"/></svg>',
  };

  function factorCards(ctx, pred, data) {
    const A = ps();
    const { hp, ap, ranks } = data;
    if (!hp || !ap) return '';
    const hr = ranks[String(ctx.home.id)], ar = ranks[String(ctx.away.id)];
    const habb = ctx.home.abbr || ctx.home.name.slice(0, 3).toUpperCase();
    const aabb = ctx.away.abbr || ctx.away.name.slice(0, 3).toUpperCase();

    const cards = [];
    if (hr && ar) {
      cards.push({ ic: FIC.attack, label: 'Attack', sub: `of ${hr.of} clubs`,
        h: ord(hr.attackRank), a: ord(ar.attackRank), hn: -hr.attackRank, an: -ar.attackRank });
      cards.push({ ic: FIC.defence, label: 'Defence', sub: `of ${hr.of} clubs`,
        h: ord(hr.defenceRank), a: ord(ar.defenceRank), hn: -hr.defenceRank, an: -ar.defenceRank });
    }
    cards.push({ ic: FIC.home, label: 'Home / away', sub: 'points a game',
      h: fmt2(hp.home.ppg), a: fmt2(ap.away.ppg), hn: hp.home.ppg, an: ap.away.ppg });
    cards.push({ ic: FIC.form, label: 'Form', sub: 'last 6 games',
      h: `${hp.formPoints}<em>/${hp.formMax}</em>`, a: `${ap.formPoints}<em>/${ap.formMax}</em>`,
      hn: hp.formPoints, an: ap.formPoints });
    cards.push({ ic: FIC.goals, label: 'Scoring', sub: 'goals a game',
      h: fmt2(hp.all.gfpg), a: fmt2(ap.all.gfpg), hn: hp.all.gfpg, an: ap.all.gfpg });

    const side = (abbr, val, wins) => `<div class="fc-side${wins ? ' win' : ''}">
        <i>${A.esc(abbr)}</i><b>${val}</b>${wins ? `<span class="fc-tick" aria-label="stronger">${FIC.tick}</span>` : ''}</div>`;

    // one short line instead of five paragraphs
    const wins = { h: 0, a: 0 };
    cards.forEach(c => { if (c.hn > c.an) wins.h++; else if (c.an > c.hn) wins.a++; });
    const lead = wins.h === wins.a ? null : (wins.h > wins.a ? ctx.home.name : ctx.away.name);
    const leadCount = Math.max(wins.h, wins.a);
    const pick = P.pickOf({ home: pred.home, draw: pred.draw, away: pred.away });
    const pickName = pick === 'draw' ? 'Draw' : pick === 'home' ? ctx.home.name : ctx.away.name;

    return `<div class="factors">
      <div class="viz-head"><b>Why</b><span>${lead ? `${A.esc(lead)} lead ${leadCount} of ${cards.length}` : 'evenly matched'}</span></div>
      <div class="fgrid">${cards.map(c => `<div class="fcard">
        <div class="fc-top"><span class="fc-ic">${c.ic}</span><span class="fc-label">${c.label}</span></div>
        <div class="fc-vs">${side(habb, c.h, c.hn > c.an)}${side(aabb, c.a, c.an > c.hn)}</div>
        <span class="fc-sub">${c.sub}</span>
      </div>`).join('')}</div>
      <div class="fverdict"><span class="fv-pick">${A.esc(pickName)}</span>
        <span class="fv-p">${pct(pred[pick])}</span>
        <span class="fv-xg">${fmt2(pred.expectedHome)} – ${fmt2(pred.expectedAway)} goals</span></div>
    </div>`;
  }

  const ord = n => `${n}${['th', 'st', 'nd', 'rd'][(n % 100 - 20) % 10] || ['th', 'st', 'nd', 'rd'][n % 100] || 'th'}`;

  /* ---------------- supporting data ---------------- */

  const scorerCache = new Map();
  async function clubTopScorers(lgId, teamId) {
    const key = `${lgId}|${teamId}`;
    if (scorerCache.has(key)) return scorerCache.get(key);
    const A = ps();
    const p = (async () => {
      try {
        const season = await A.ensureSeason(lgId);
        const data = await A.request(`${A.CORE}/${lgId}/seasons/${season.year}/types/${season.type || 1}/teams/${teamId}/leaders?lang=en`, { ttl: 6 * 3600 * 1000 });
        const pull = names => {
          const cat = (data.categories || []).find(c => names.includes(c.name));
          return ((cat && cat.leaders) || []).slice(0, 4).map(l => ({
            id: (String((l.athlete && l.athlete.$ref) || '').match(/\/(\d+)\?/) || [])[1],
            value: Math.round(Number(l.value) || 0),
            apps: (/Matches:\s*(\d+)/.exec(l.displayValue || '') || [])[1] || '',
          })).filter(r => r.id && r.value > 0);
        };
        const goals = pull(['goalsLeaders', 'goals']);
        const assists = pull(['assistsLeaders', 'assists']);
        const ids = [...new Set([...goals, ...assists].map(r => r.id))];
        const people = {};
        await Promise.all(ids.map(async id => {
          try { people[id] = await A.getPerson(lgId, season.year, id); } catch (e) { /* name stays blank */ }
        }));
        const name = id => (people[id] && people[id].name) || 'Player';
        return {
          goals: goals.map(r => Object.assign({}, r, { name: name(r.id), flag: people[r.id] && people[r.id].flag, jersey: people[r.id] && people[r.id].jersey })),
          assists: assists.map(r => Object.assign({}, r, { name: name(r.id), flag: people[r.id] && people[r.id].flag, jersey: people[r.id] && people[r.id].jersey })),
        };
      } catch (err) { return { goals: [], assists: [] }; }
    })();
    scorerCache.set(key, p);
    return p;
  }

  /* xG exists only for the current season, so this is shown as context and
     never fed into the model — see the note in predictions.js */
  async function recentXg(lgId, teamId, training) {
    const A = ps();
    const xgStore = U.ST.xg || (U.ST.xg = {});
    const games = training.filter(m => String(m.home) === String(teamId) || String(m.away) === String(teamId)).slice(-5);
    const out = [];
    let misses = 0;
    for (const m of games.reverse()) {
      const key = `${m.id}|${teamId}`;
      if (xgStore[key] === undefined) {
        if (misses >= 2) continue;                       // older seasons carry no xG — stop probing
        try {
          const d = await A.request(`${A.CORE}/${lgId}/events/${m.id}/competitions/${m.id}/competitors/${teamId}/statistics?lang=en`, { ttl: 30 * 86400000 });
          let xg = null;
          ((d.splits && d.splits.categories) || []).forEach(c => (c.stats || []).forEach(s => {
            if (s.name === 'expectedGoals') xg = Number(s.value != null ? s.value : s.displayValue);
          }));
          xgStore[key] = isFinite(xg) ? xg : null;
        } catch (err) { xgStore[key] = null; }
        if (xgStore[key] == null) misses++;
      }
      if (xgStore[key] != null) {
        const atHome = String(m.home) === String(teamId);
        out.push({ date: m.date, xg: xgStore[key], goals: atHome ? m.hg : m.ag,
                   opponent: atHome ? (m.awayName || '') : (m.homeName || '') });
      }
    }
    U.persist();
    return out;
  }

  /* ---------------- the panel ---------------- */
  function card(ctx, pred, opts) {
    const A = ps();
    const o = opts || {};
    const d = o.data || {};
    const live = !!pred.live;
    const hp = d.hp, ap = d.ap, ranks = d.ranks || {};
    const hr = ranks[String(ctx.home.id)], ar = ranks[String(ctx.away.id)];
    const matrix = d.matrix;
    const top = (pred.topScores || [])[0];

    const verdict = o.verdict ? `<div class="verdict ${o.verdict.correct ? 'ok' : 'miss'}">
        <b>${o.verdict.correct ? 'Called it' : 'Got it wrong'}</b>
        <span>predicted ${pct(o.verdict.probs[P.pickOf(o.verdict.probs)])} ${P.pickOf(o.verdict.probs) === 'draw' ? 'draw' : (P.pickOf(o.verdict.probs) === 'home' ? A.esc(ctx.home.name) : A.esc(ctx.away.name))}
        · finished ${A.esc(o.verdict.score)} · RPS ${o.verdict.rps.toFixed(3)} against ${o.verdict.rpsUniform.toFixed(3)} for a coin toss</span></div>` : '';

    const compare = (hp && ap) ? `<div class="cmp">
        <div class="viz-head"><b>Season so far</b><span>the stronger number is highlighted</span></div>
        <div class="cmp-head"><span>${A.esc(ctx.home.name)}</span><i>at home</i><span>${A.esc(ctx.away.name)}</span></div>
        ${cmpRow('Points per game', fmt2(hp.all.ppg), fmt2(ap.all.ppg))}
        ${cmpRow('Goals scored per game', fmt2(hp.all.gfpg), fmt2(ap.all.gfpg))}
        ${cmpRow('Goals let in per game', fmt2(hp.all.gapg), fmt2(ap.all.gapg), { lowerBetter: true })}
        ${cmpRow('Record at home / away', `${hp.home.w}W ${hp.home.d}D ${hp.home.l}L`, `${ap.away.w}W ${ap.away.d}D ${ap.away.l}L`,
            { hNum: hp.home.ppg, aNum: ap.away.ppg })}
        ${cmpRow('Matches without conceding', `${Math.round(hp.all.csRate * 100)}%`, `${Math.round(ap.all.csRate * 100)}%`,
            { hNum: hp.all.csRate, aNum: ap.all.csRate })}
        ${cmpRow('Points in last 6 games', `${hp.formPoints} of ${hp.formMax}`, `${ap.formPoints} of ${ap.formMax}`,
            { hNum: hp.formPoints, aNum: ap.formPoints })}
        <div class="cmp-forms">
          <span>${formStrip(hp.recent)}</span><i>recent results</i><span>${formStrip(ap.recent)}</span>
        </div>
      </div>` : '';

    const charts = matrix ? `<div class="pred-charts">
        <div class="chart-box">${scorelineBars(pred, ctx)}</div>
        <div class="chart-box">${goalsBars(matrix)}</div>
      </div>` : '';

    const scatter = (ranks.__all && ranks.__all.length > 3) ? `<div class="chart-box wide">${strengthRanks(ranks, ctx)}</div>` : '';

    const players = d.scorers ? `<div class="pred-players">
        ${['home', 'away'].map(side => {
          const s = d.scorers[side] || { goals: [], assists: [] };
          const team = ctx[side];
          if (!s.goals.length && !s.assists.length) return `<div><div class="label">${A.esc(team.name)}</div><div class="chart-note">No scoring charts published yet.</div></div>`;
          return `<div><div class="viz-head"><b>${A.esc(team.name)} — who has been scoring</b></div>
            ${s.goals.slice(0, 3).map(p => `<a class="pl-row" href="#/player/${A.esc(ctx.lgId)}/${A.esc(p.id)}">
              ${A.avatar({ jersey: p.jersey, name: p.name, flag: p.flag }, 'sm')}
              <span class="pl-n">${A.esc(p.name)}</span><span class="pl-m">${p.apps ? p.apps + ' apps' : ''}</span>
              <b>${p.value}<i>goals</i></b></a>`).join('')}
            ${s.assists.slice(0, 2).map(p => `<a class="pl-row dim" href="#/player/${A.esc(ctx.lgId)}/${A.esc(p.id)}">
              ${A.avatar({ jersey: p.jersey, name: p.name, flag: p.flag }, 'sm')}
              <span class="pl-n">${A.esc(p.name)}</span><span class="pl-m">${p.apps ? p.apps + ' apps' : ''}</span>
              <b>${p.value}<i>assists</i></b></a>`).join('')}</div>`;
        }).join('')}
      </div>` : '';

    const xgPanel = (d.xg && (d.xg.home.length || d.xg.away.length)) ? `<div class="pred-xg">
        <div class="viz-head"><b>Are they finishing well?</b><span>goals scored against the quality of chances created</span></div>
        <div class="xg-grid">${['home', 'away'].map(side => {
          const rows = d.xg[side] || [];
          if (!rows.length) return '';
          const g = rows.reduce((s, r) => s + r.goals, 0), x = rows.reduce((s, r) => s + r.xg, 0);
          const diff = g - x;
          return `<div class="xg-col"><b>${A.esc(ctx[side].name)}</b>
            <span class="xg-sum ${diff >= 0 ? 'over' : 'under'}">Scored ${g} from chances worth ${fmt1(x)}
              <i>${diff >= 0 ? `taking chances well (+${fmt1(diff)})` : `missing chances (${fmt1(diff)})`}</i></span>
            ${rows.map(r => `<span class="xg-row"><i>${A.esc(r.opponent || '')}</i>
              <em>${r.goals} <small>/ ${fmt1(r.xg)} xG</small></em></span>`).join('')}</div>`;
        }).join('')}</div>
        <div class="viz-note">"Chances worth 1.5" means the shots they had would typically produce 1.5 goals.
          Shown as background only — it is not used in the prediction.</div>
      </div>` : '';

    const absBlock = (pred.homeAbsences && pred.homeAbsences.length) || (pred.awayAbsences && pred.awayAbsences.length)
      ? `<div class="pred-abs"><div class="viz-head"><b>Missing players</b><span>factored into the numbers</span></div>
          ${absenceChips(pred.homeAbsences, ctx.home.name)}${absenceChips(pred.awayAbsences, ctx.away.name)}</div>`
      : '';

    return `<div class="card-title"><span class="label">${live ? 'Live prediction' : 'Prediction'}</span>
        <span class="label">${live ? `at ${pred.minute}'` : 'estimate, not advice'}</span></div>
      ${verdict}
      <div class="pred-bars">
        ${barRow('h', ctx.home.name, pred.home)}
        ${barRow('d', 'Draw', pred.draw)}
        ${barRow('a', ctx.away.name, pred.away)}
      </div>
      <div class="pred-stats">
        <div><i>${live ? 'Projected' : 'Expected goals'}</i><b>${fmt2(pred.expectedHome)} – ${fmt2(pred.expectedAway)}</b></div>
        <div><i>Likeliest score</i><b>${top ? `${top.h}–${top.a}` : '–'}</b></div>
        <div><i>Both score</i><b>${pct(pred.btts)}</b></div>
        <div><i>Over 2.5</i><b>${pct(pred.over25)}</b></div>
      </div>
      ${factorCards(ctx, pred, d)}
      ${charts}
      ${live ? movementBars(ctx.matchId, ctx, pred) : ''}
      ${absBlock}
      ${(compare || scatter || players || xgPanel) ? `<details class="more-detail">
        <summary><span>Full numbers</span>${A.ICON && A.ICON.chevR ? A.ICON.chevR : ''}</summary>
        <div class="more-body">${scatter}${compare}${players}${xgPanel}
          <div class="viz" style="padding-top:8px">
            <div class="viz-head"><b>Every likely score</b></div>
            <div class="pred-scores">${(pred.topScores || []).slice(0, 6).map(s =>
              `<span class="sc-chip"><b>${s.h}–${s.a}</b><i>${pct(s.p)}</i></span>`).join('')}</div>
          </div>
          <ul class="pred-factors">${[
            pred.strength ? `Home advantage ×${fmt2(pred.strength.homeAdvantage)}` : '',
            `Fitted on ${pred.ratingMatches || 0} matches`,
            pred.lowConfidence ? 'Thin history — low confidence' : '',
          ].filter(Boolean).map(f => `<li>${f}</li>`).join('')}</ul>
        </div></details>` : ''}
      <p class="fine">A 50% call still loses half the time. Injuries are not published for football, so availability is
        inferred. No betting odds are used.</p>`;
  }

  /* called by app.js from the match page */
  async function renderMatchPrediction(host, ctx) {
    const A = ps();
    if (!host || !A || !P) return;
    A.paint(host, `<div class="card-title"><span class="label">Prediction</span></div>
      <div class="note">Fitting the model to this season…</div>`);

    let ratings, training, pred;
    try {
      [ratings, training] = await Promise.all([U.ratingsFor(ctx.lgId), U.getTraining(ctx.lgId)]);
      pred = ratings ? P.predict(ratings, ctx.home.id, ctx.away.id, {}) : null;
    } catch (err) { pred = null; }
    if (!pred) {
      A.paint(host, `<div class="card-title"><span class="label">Prediction</span></div>
        <div class="note">Not enough match history in this competition to model yet.</div>`);
      return;
    }
    if (!host.isConnected) return;
    pred.ratingMatches = ratings.matches;

    const finished = ctx.statusKind === 'post';
    const live = ctx.statusKind === 'live';
    if (!finished && !live) U.recordPrediction({ id: ctx.matchId, lg: ctx.lgId, date: ctx.date, home: ctx.home, away: ctx.away }, pred, 'pre');

    // everything here comes from data already fetched for the ratings
    const data = {
      hp: P.teamProfile(training, ctx.home.id),
      ap: P.teamProfile(training, ctx.away.id),
      ranks: P.leagueRanks(ratings),
      matrix: P.scoreMatrix(pred.expectedHome, pred.expectedAway, ratings.rho),
    };

    const state = { minute: ctx.minute, homeGoals: ctx.hg, awayGoals: ctx.ag, redHome: ctx.redH, redAway: ctx.redA, finished };
    const shape = base => {
      if (!live && !finished) return base;
      const ip = P.inPlay(base, state);
      if (!ip) return base;
      const merged = Object.assign({}, base, ip);
      merged.strength = base.strength; merged.ratingMatches = base.ratingMatches;
      merged.homeAbsences = base.homeAbsences; merged.awayAbsences = base.awayAbsences;
      merged.availability = base.availability;
      return merged;
    };

    let verdict = null;
    if (finished) verdict = U.settle(ctx.matchId, ctx.hg, ctx.ag);
    if (live) U.recordMove(ctx.matchId, ctx.minute, shape(pred));

    const actual = finished ? { h: ctx.hg, a: ctx.ag } : null;
    A.paint(host, card(ctx, shape(pred), { verdict, data, actual }));

    // slower context: squads, news, club scorers, xG — fill in when they land
    try {
      const [full, hs, as, hx, ax] = await Promise.all([
        finished ? Promise.resolve(pred) : U.predictFixture(ctx.lgId, ctx.home.id, ctx.away.id, { withAvailability: true }),
        clubTopScorers(ctx.lgId, ctx.home.id),
        clubTopScorers(ctx.lgId, ctx.away.id),
        recentXg(ctx.lgId, ctx.home.id, training).catch(() => []),
        recentXg(ctx.lgId, ctx.away.id, training).catch(() => []),
      ]);
      if (!host.isConnected) return;
      const merged = full || pred;
      merged.ratingMatches = ratings.matches;
      data.scorers = { home: hs, away: as };
      data.xg = { home: hx, away: ax };
      data.matrix = P.scoreMatrix(merged.expectedHome, merged.expectedAway, ratings.rho);
      A.paint(host, card(ctx, shape(merged), { verdict, data, actual }));
    } catch (err) { /* the base panel already stands */ }
  }

  /* ---------------- hub ---------------- */
  const backtestCache = {};
  async function runBacktest(lgId) {
    if (backtestCache[lgId]) return backtestCache[lgId];
    const matches = await U.getTraining(lgId);
    const res = P.backtest(matches, {});
    backtestCache[lgId] = res;
    return res;
  }

  function reliabilityChart(bins) {
    const rows = (bins || []).filter(b => b.n > 0);
    if (!rows.length) return '<div class="note">Not enough settled predictions yet to chart calibration.</div>';
    const W = 300, H = 160, pad = 24;
    const sx = v => pad + v * (W - pad * 2);
    const sy = v => H - pad - v * (H - pad * 2);
    return `<svg viewBox="0 0 ${W} ${H}" class="rel-svg" role="img" aria-label="Calibration chart">
      <line x1="${sx(0)}" y1="${sy(0)}" x2="${sx(1)}" y2="${sy(1)}" class="rel-ideal"/>
      <line x1="${pad}" y1="${sy(0)}" x2="${W - pad}" y2="${sy(0)}" class="rel-axis"/>
      <line x1="${pad}" y1="${sy(0)}" x2="${pad}" y2="${sy(1)}" class="rel-axis"/>
      ${rows.map(b => `<circle cx="${sx(b.expected)}" cy="${sy(b.observed)}" r="${Math.min(7, 2 + Math.sqrt(b.n))}" class="rel-dot"><title>predicted ${Math.round(b.expected * 100)}% · happened ${Math.round(b.observed * 100)}% (n=${b.n})</title></circle>`).join('')}
      <text x="${W / 2}" y="${H - 4}" class="rel-lbl">predicted</text>
      <text x="6" y="14" class="rel-lbl">actual</text>
    </svg>`;
  }

  async function renderHub(main, rail) {
    const A = ps();
    const stats = U.ledgerStats();
    const leagues = A.orderedLeagues().slice(0, 8);

    A.paint(main, `
      <div class="toolbar">
        <div><h1 class="page-title">Predictions</h1>
          <p class="page-sub">A statistical model, scored honestly — including when it is wrong.</p></div>
      </div>
      <section class="panel section">
        <div class="card-title"><span class="label">This browser's record</span>
          <span class="label">${stats.n || 0} settled · ${stats.pending || 0} pending</span></div>
        ${stats.n ? `<div class="stat-cards">
            <div class="stat-card"><b>${(stats.accuracy * 100).toFixed(0)}%</b><span>Outcomes called</span></div>
            <div class="stat-card"><b>${stats.rps.toFixed(3)}</b><span>RPS (lower is better)</span></div>
            <div class="stat-card"><b>${stats.rpsUniform.toFixed(3)}</b><span>Coin-toss baseline</span></div>
            <div class="stat-card"><b>${stats.rps < stats.rpsUniform ? 'Ahead' : 'Behind'}</b><span>vs baseline</span></div>
          </div>`
        : `<div class="note">No settled predictions yet. Open an upcoming match and the model's call is recorded here,
             then scored automatically once the match finishes.</div>`}
      </section>

      <div class="grid2">
        <section class="panel section">
          <div class="card-title"><span class="label">Calibration</span></div>
          <div class="rel-wrap">${reliabilityChart(stats.reliability)}</div>
          <p class="fine">Dots on the diagonal mean the stated confidence matches reality — a 60% call landing 60% of the time.</p>
        </section>
        <section class="panel section">
          <div class="card-title"><span class="label">Model accuracy by competition</span></div>
          <div class="note" id="btHint">Backtests replay a whole season: fit on earlier matchdays only, predict the next.</div>
          <div class="bt-list">${leagues.map(l => `<button class="bt-row" data-backtest="${A.esc(l.id)}">
              ${A.lgLogo(l.id)}<span class="nm">${A.esc(l.name)}</span><span class="bt-res" id="bt-${A.esc(l.id)}">Run</span></button>`).join('')}</div>
        </section>
      </div>

      <section class="panel section" id="upcomingPreds">
        <div class="card-title"><span class="label">Upcoming predictions</span></div>
        <div class="note">Loading fixtures…</div>
      </section>

      ${stats.n ? `<section class="panel section">
        <div class="card-title"><span class="label">Settled predictions</span></div>
        <div class="table-wrap"><table class="tbl"><thead><tr>
          <th class="team">Match</th><th>Predicted</th><th>Result</th><th>RPS</th><th>Verdict</th></tr></thead>
          <tbody>${stats.settled.slice().reverse().slice(0, 40).map(e => `<tr class="clickable" data-href="#/match/${A.esc(e.lg)}/${A.esc(e.id)}">
            <td class="team">${A.esc(e.home)} v ${A.esc(e.away)}</td>
            <td>${pct(e.probs[P.pickOf(e.probs)])} ${P.pickOf(e.probs)}</td>
            <td class="key">${A.esc(e.score || '')}</td>
            <td>${e.rps.toFixed(3)}</td>
            <td class="${e.correct ? 'hot' : 'zero'}">${e.correct ? 'Correct' : 'Wrong'}</td>
          </tr>`).join('')}</tbody></table></div>
      </section>` : ''}

      <p class="fine">Predictions are generated in your browser from public match data, so this record is personal to this
        device. The backtests above are reproducible for everyone. No betting odds are used or shown.</p>`);

    if (rail) A.paint(rail, '');
    fillUpcoming();
  }

  async function fillUpcoming() {
    const A = ps();
    const host = document.getElementById('upcomingPreds');
    if (!host) return;
    const leagues = A.orderedLeagues().slice(0, 6);
    const now = new Date();
    const fixtures = [];
    for (const lg of leagues) {
      for (const off of [0, 1]) {
        try {
          const events = await A.loadMonth(lg.id, A.addMonths(now, off));
          events.forEach(e => {
            const st = A.statusOf(e);
            const when = new Date(e.date);
            if (st.kind === 'pre' && when > now && (when - now) < 8 * 86400000) fixtures.push(e);
          });
        } catch (err) { /* league may be out of season */ }
      }
    }
    fixtures.sort((a, b) => new Date(a.date) - new Date(b.date));
    const pick = fixtures.slice(0, 12);
    if (!pick.length) {
      A.paint(host, `<div class="card-title"><span class="label">Upcoming predictions</span></div>
        <div class="note">No fixtures in the next week for the competitions you follow.</div>`);
      return;
    }
    const rows = [];
    for (const m of pick) {
      try {
        const p = await U.predictFixture(m.lg, m.home.id, m.away.id, { withAvailability: false });
        if (p) rows.push({ m, p });
      } catch (err) { /* skip */ }
    }
    if (!document.getElementById('upcomingPreds')) return;
    A.paint(host, `<div class="card-title"><span class="label">Upcoming predictions</span><span class="label">${rows.length} fixtures</span></div>
      <div class="up-list">${rows.map(({ m, p }) => {
        const best = P.pickOf({ home: p.home, draw: p.draw, away: p.away });
        const label = best === 'draw' ? 'Draw' : best === 'home' ? m.home.name : m.away.name;
        return `<a class="up-row" href="#/match/${A.esc(m.lg)}/${A.esc(m.id)}">
          <span class="up-when">${A.esc(A.fmtDayShort(new Date(m.date)))}<i>${A.esc(A.fmtTime(m.date))}</i></span>
          <span class="up-teams">${A.esc(m.home.name)} <em>v</em> ${A.esc(m.away.name)}</span>
          <span class="up-mini"><i class="h" style="width:${(p.home * 100).toFixed(0)}%"></i><i class="d" style="width:${(p.draw * 100).toFixed(0)}%"></i><i class="a" style="width:${(p.away * 100).toFixed(0)}%"></i></span>
          <span class="up-pick">${A.esc(label)} ${pct(p[best])}</span></a>`;
      }).join('')}</div>`);
  }

  document.addEventListener('click', async e => {
    const btn = e.target.closest('[data-backtest]');
    if (!btn) return;
    const lg = btn.dataset.backtest;
    const cell = document.getElementById(`bt-${lg}`);
    if (cell) cell.textContent = 'Running…';
    try {
      const res = await runBacktest(lg);
      if (!cell) return;
      cell.innerHTML = res
        ? `<b class="${res.beatsUniform ? 'good' : 'bad'}">${res.rps.toFixed(3)}</b> vs ${res.rpsUniform.toFixed(3)} · ${(res.accuracy * 100).toFixed(0)}% · n=${res.n}`
        : 'not enough history';
    } catch (err) {
      if (cell) cell.textContent = 'failed';
    }
  });

  U.renderMatchPrediction = renderMatchPrediction;
  U.renderHub = renderHub;
  U.runBacktest = runBacktest;
})();
