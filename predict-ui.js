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
          out.push({ date: e.date, home: e.home.id, away: e.away.id, hg, ag, id: e.id, details: e.details });
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

  function movementChart(matchId) {
    const pts = U.ST.moves[String(matchId)] || [];
    if (pts.length < 3) return '';
    const W = 320, H = 70;
    const x = i => (i / (pts.length - 1)) * W;
    const line = key => pts.map((p, i) => `${x(i).toFixed(1)},${(H - p[key] * H).toFixed(1)}`).join(' ');
    return `<div class="pred-move">
      <div class="label">How the model moved</div>
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="move-svg" aria-hidden="true">
        <polyline points="${line('h')}" class="mv h"/>
        <polyline points="${line('d')}" class="mv d"/>
        <polyline points="${line('a')}" class="mv a"/>
      </svg>
      <div class="move-key"><span class="k h">Home</span><span class="k d">Draw</span><span class="k a">Away</span>
        <span class="k t">${pts[0].m}' → ${pts[pts.length - 1].m}'</span></div></div>`;
  }

  function card(ctx, pred, opts) {
    const A = ps();
    const o = opts || {};
    const live = !!pred.live;
    const top = (pred.topScores || [])[0];
    const factors = [];
    factors.push(`Home advantage ×${(pred.strength ? pred.strength.homeAdvantage : 1).toFixed(2)}`);
    factors.push(`Ratings from ${pred.ratingMatches || 0} recent matches`);
    if (pred.availability) {
      const ah = pred.availability.home, aa = pred.availability.away;
      if (ah.attackLoss > 0.001) factors.push(`${A.esc(ctx.home.name)} attack −${Math.round(ah.attackLoss * 100)}% for absences`);
      if (aa.attackLoss > 0.001) factors.push(`${A.esc(ctx.away.name)} attack −${Math.round(aa.attackLoss * 100)}% for absences`);
    }
    if (pred.lowConfidence) factors.push('Thin match history — treat as low confidence');

    const verdict = o.verdict ? `<div class="verdict ${o.verdict.correct ? 'ok' : 'miss'}">
        ${o.verdict.correct ? A.ICON.check || '✓' : ''}
        <b>${o.verdict.correct ? 'Called it' : 'Got it wrong'}</b>
        <span>predicted ${pct(o.verdict.probs[P.pickOf(o.verdict.probs)])} ${P.pickOf(o.verdict.probs) === 'draw' ? 'draw' : (P.pickOf(o.verdict.probs) === 'home' ? A.esc(ctx.home.name) : A.esc(ctx.away.name))} · actual ${A.esc(o.verdict.score)} · RPS ${o.verdict.rps.toFixed(3)} vs ${o.verdict.rpsUniform.toFixed(3)} for a coin toss</span>
      </div>` : '';

    return `<div class="card-title"><span class="label">${live ? 'Live prediction' : 'Prediction'}</span>
        <span class="label">${live ? `recalculated at ${pred.minute}'` : 'model estimate · not advice'}</span></div>
      ${verdict}
      <div class="pred-bars">
        ${barRow('h', ctx.home.name, pred.home)}
        ${barRow('d', 'Draw', pred.draw)}
        ${barRow('a', ctx.away.name, pred.away)}
      </div>
      <div class="pred-stats">
        <div><i>${live ? 'Projected final' : 'Expected goals'}</i><b>${pred.expectedHome.toFixed(2)} – ${pred.expectedAway.toFixed(2)}</b></div>
        <div><i>Most likely score</i><b>${top ? `${top.h}–${top.a}` : '–'}</b></div>
        <div><i>Both teams score</i><b>${pct(pred.btts)}</b></div>
        <div><i>Over 2.5 goals</i><b>${pct(pred.over25)}</b></div>
      </div>
      <div class="pred-scores">${(pred.topScores || []).slice(0, 5).map(s =>
        `<span class="sc-chip"><b>${s.h}–${s.a}</b><i>${pct(s.p)}</i></span>`).join('')}</div>
      ${movementChart(ctx.matchId)}
      ${(pred.homeAbsences && pred.homeAbsences.length) || (pred.awayAbsences && pred.awayAbsences.length)
        ? `<div class="pred-abs">${absenceChips(pred.homeAbsences, ctx.home.name)}${absenceChips(pred.awayAbsences, ctx.away.name)}</div>`
        : ''}
      <ul class="pred-factors">${factors.map(f => `<li>${f}</li>`).join('')}</ul>
      <p class="fine">Model estimate from past results, home advantage and available-player signals. Football is not
        predictable to this precision — treat these as rough odds, not advice. ESPN publishes no injury data for
        football, so availability is inferred and can be wrong.</p>`;
  }

  /* called by app.js from the match page */
  async function renderMatchPrediction(host, ctx) {
    const A = ps();
    if (!host || !A || !P) return;
    A.paint(host, `<div class="card-title"><span class="label">Prediction</span></div>
      <div class="note">Fitting the model…</div>`);
    let pred;
    try {
      pred = await U.predictFixture(ctx.lgId, ctx.home.id, ctx.away.id, { withAvailability: false });
    } catch (err) { pred = null; }
    if (!pred) {
      A.paint(host, `<div class="card-title"><span class="label">Prediction</span></div>
        <div class="note">Not enough match history in this competition to model yet.</div>`);
      return;
    }
    if (!host.isConnected) return;

    const finished = ctx.statusKind === 'post';
    const live = ctx.statusKind === 'live';

    // pre-match probabilities are the ones we commit to the ledger
    if (!finished && !live) U.recordPrediction({ id: ctx.matchId, lg: ctx.lgId, date: ctx.date, home: ctx.home, away: ctx.away }, pred, 'pre');

    let shown = pred;
    if (live || finished) {
      const state = { minute: ctx.minute, homeGoals: ctx.hg, awayGoals: ctx.ag, redHome: ctx.redH, redAway: ctx.redA, finished };
      const ip = P.inPlay(pred, state);
      if (ip) { shown = Object.assign({}, pred, ip); shown.strength = pred.strength; shown.ratingMatches = pred.ratingMatches; }
      if (live) U.recordMove(ctx.matchId, ctx.minute, shown);
    }

    let verdict = null;
    if (finished) {
      const entry = U.settle(ctx.matchId, ctx.hg, ctx.ag);
      if (entry) verdict = entry;
    }
    A.paint(host, card(ctx, shown, { verdict }));

    // availability is slower (squads, news, club scorers) — refine once it lands
    if (!finished) {
      try {
        const full = await U.predictFixture(ctx.lgId, ctx.home.id, ctx.away.id, { withAvailability: true });
        if (!full || !host.isConnected) return;
        let out = full;
        if (live) {
          const ip = P.inPlay(full, { minute: ctx.minute, homeGoals: ctx.hg, awayGoals: ctx.ag, redHome: ctx.redH, redAway: ctx.redA });
          if (ip) { out = Object.assign({}, full, ip); out.strength = full.strength; out.ratingMatches = full.ratingMatches; }
        }
        A.paint(host, card(ctx, out, { verdict }));
      } catch (err) { /* keep the base prediction */ }
    }
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
