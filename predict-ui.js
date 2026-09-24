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

  /* scoreline heatmap — the most-likely scorelines at a glance */
  function heatmapSvg(matrix, ctx, actual) {
    const A = ps();
    const { cells, size, max } = P.matrixCells(matrix, 5);
    const c = 30, pad = 30, W = pad + size * c + 6, H = pad + size * c + 6;
    const colour = s => s === 'home' ? '61,220,132' : s === 'away' ? '92,200,255' : '150,160,175';
    return `<svg viewBox="0 0 ${W} ${H}" class="heat-svg" role="img" aria-label="Scoreline probability grid">
      <text x="${pad + (size * c) / 2}" y="10" class="heat-ax">${A.esc(ctx.away.abbr || ctx.away.name)} goals →</text>
      <text x="9" y="${pad + (size * c) / 2}" class="heat-ax" transform="rotate(-90 9 ${pad + (size * c) / 2})">${A.esc(ctx.home.abbr || ctx.home.name)} goals →</text>
      ${Array.from({ length: size }, (_, i) => `<text x="${pad + i * c + c / 2}" y="${pad - 6}" class="heat-n">${i}</text>`).join('')}
      ${Array.from({ length: size }, (_, i) => `<text x="${pad - 8}" y="${pad + i * c + c / 2 + 4}" class="heat-n">${i}</text>`).join('')}
      ${cells.map(cl => {
        const isActual = actual && actual.h === cl.h && actual.a === cl.a;
        return `<g><rect x="${pad + cl.a * c}" y="${pad + cl.h * c}" width="${c - 2}" height="${c - 2}" rx="4"
          fill="rgba(${colour(cl.side)},${(0.08 + cl.rel * 0.85).toFixed(3)})"
          ${isActual ? 'class="heat-actual"' : ''}><title>${cl.h}–${cl.a}: ${(cl.p * 100).toFixed(1)}%</title></rect>
          ${cl.rel > 0.45 ? `<text x="${pad + cl.a * c + (c - 2) / 2}" y="${pad + cl.h * c + (c - 2) / 2 + 4}" class="heat-p">${Math.round(cl.p * 100)}</text>` : ''}
        </g>`;
      }).join('')}
    </svg>`;
  }

  /* total goals distribution */
  function goalsSvg(matrix) {
    const dist = P.goalsDistribution(matrix, 6);
    const max = Math.max.apply(null, dist) || 1;
    const W = 260, H = 110, bw = W / dist.length;
    return `<svg viewBox="0 0 ${W} ${H}" class="gd-svg" role="img" aria-label="Total goals distribution">
      ${dist.map((p, i) => {
        const h = (p / max) * (H - 30);
        return `<g><rect x="${i * bw + 5}" y="${H - 20 - h}" width="${bw - 10}" height="${h}" rx="3" class="gd-bar ${i > 2 ? 'over' : 'under'}">
          <title>${i === 6 ? '6+' : i} goals: ${(p * 100).toFixed(1)}%</title></rect>
          <text x="${i * bw + bw / 2}" y="${H - 6}" class="gd-x">${i === 6 ? '6+' : i}</text>
          ${p > 0.06 ? `<text x="${i * bw + bw / 2}" y="${H - 25 - h}" class="gd-v">${Math.round(p * 100)}</text>` : ''}
        </g>`;
      }).join('')}
    </svg>`;
  }

  /* where both clubs sit among every club in the competition */
  function scatterSvg(ranks, ctx) {
    const A = ps();
    const all = (ranks && ranks.__all) || [];
    if (all.length < 4) return '';
    const W = 300, H = 210, pad = 34;
    const ax = all.map(r => r.attack), dx = all.map(r => r.defence);
    const minA = Math.min.apply(null, ax), maxA = Math.max.apply(null, ax);
    const minD = Math.min.apply(null, dx), maxD = Math.max.apply(null, dx);
    const sx = v => pad + ((v - minA) / ((maxA - minA) || 1)) * (W - pad - 14);
    const sy = v => pad + ((v - minD) / ((maxD - minD) || 1)) * (H - pad - 26); // higher = concedes more
    const dot = (r) => {
      const isH = String(r.id) === String(ctx.home.id), isA = String(r.id) === String(ctx.away.id);
      if (!isH && !isA) return `<circle cx="${sx(r.attack)}" cy="${sy(r.defence)}" r="3" class="sc-dot"/>`;
      const name = isH ? (ctx.home.abbr || ctx.home.name) : (ctx.away.abbr || ctx.away.name);
      return `<g><circle cx="${sx(r.attack)}" cy="${sy(r.defence)}" r="6" class="sc-dot ${isH ? 'h' : 'a'}"/>
        <text x="${sx(r.attack)}" y="${sy(r.defence) - 10}" class="sc-lbl ${isH ? 'h' : 'a'}">${A.esc(name)}</text></g>`;
    };
    return `<svg viewBox="0 0 ${W} ${H}" class="sc-svg" role="img" aria-label="Attack and defence ratings across the competition">
      <line x1="${pad}" y1="${H - 22}" x2="${W - 6}" y2="${H - 22}" class="sc-axis"/>
      <line x1="${pad}" y1="${pad - 10}" x2="${pad}" y2="${H - 22}" class="sc-axis"/>
      <text x="${W - 6}" y="${H - 8}" class="sc-ax" text-anchor="end">stronger attack →</text>
      <text x="6" y="${pad - 16}" class="sc-ax">← concedes more</text>
      ${all.map(dot).join('')}
    </svg>`;
  }

  /* plain-English reasoning, generated from the same numbers shown above */
  function narrative(ctx, pred, data) {
    const A = ps();
    const { hp, ap, ranks } = data;
    const hr = ranks[String(ctx.home.id)], ar = ranks[String(ctx.away.id)];
    const bits = [];
    const H = A.esc(ctx.home.name), Aw = A.esc(ctx.away.name);

    if (hr && ar) {
      bits.push(`<b>${H}</b> rate <b>${ord(hr.attackRank)}</b> for attack and <b>${ord(hr.defenceRank)}</b> for defence of the ${hr.of} clubs modelled here; <b>${Aw}</b> rate ${ord(ar.attackRank)} and ${ord(ar.defenceRank)}.`);
    }
    if (hp && ap && hp.home.played && ap.away.played) {
      bits.push(`At home <b>${H}</b> average <b>${fmt2(hp.home.ppg)}</b> points and <b>${fmt2(hp.home.gfpg)}</b> goals a game (conceding ${fmt2(hp.home.gapg)}); on the road <b>${Aw}</b> average <b>${fmt2(ap.away.ppg)}</b> points and ${fmt2(ap.away.gfpg)} goals (conceding ${fmt2(ap.away.gapg)}).`);
    }
    if (hp && ap) {
      const hf = `${hp.formPoints}/${hp.formMax}`, af = `${ap.formPoints}/${ap.formMax}`;
      bits.push(`Recent form: <b>${H}</b> ${hf} points from their last ${hp.recent.length}, <b>${Aw}</b> ${af} from ${ap.recent.length}.`);
    }
    if (pred.strength) {
      bits.push(`Home teams in this competition score <b>${fmt2(pred.strength.homeAdvantage)}×</b> as often as visitors, which is already priced in.`);
    }
    const absAll = (pred.homeAbsences || []).concat(pred.awayAbsences || []);
    if (absAll.length) {
      const hLoss = pred.availability ? Math.round(pred.availability.home.attackLoss * 100) : 0;
      const aLoss = pred.availability ? Math.round(pred.availability.away.attackLoss * 100) : 0;
      if (hLoss || aLoss) bits.push(`Absences trim ${hLoss ? `<b>${H}</b>'s attack by ${hLoss}%` : ''}${hLoss && aLoss ? ' and ' : ''}${aLoss ? `<b>${Aw}</b>'s by ${aLoss}%` : ''}.`);
    }
    const pick = P.pickOf({ home: pred.home, draw: pred.draw, away: pred.away });
    const pickName = pick === 'draw' ? 'a draw' : pick === 'home' ? `a ${H} win` : `an ${Aw} win`;
    bits.push(`Together that gives <b>${fmt2(pred.expectedHome)}</b> expected goals to <b>${fmt2(pred.expectedAway)}</b> — making ${pickName} the single most likely result at <b>${pct(pred[pick])}</b>, though ${pct(1 - pred[pick])} of the time it goes another way.`);
    return bits.map(b => `<p>${b}</p>`).join('');
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
        <div class="cmp-head"><span>${A.esc(ctx.home.name)}</span><i>this season</i><span>${A.esc(ctx.away.name)}</span></div>
        ${cmpRow('Points per game', fmt2(hp.all.ppg), fmt2(ap.all.ppg))}
        ${cmpRow('Goals scored / game', fmt2(hp.all.gfpg), fmt2(ap.all.gfpg))}
        ${cmpRow('Conceded / game', fmt2(hp.all.gapg), fmt2(ap.all.gapg), { lowerBetter: true })}
        ${cmpRow('At home / away', `${hp.home.w}W ${hp.home.d}D ${hp.home.l}L`, `${ap.away.w}W ${ap.away.d}D ${ap.away.l}L`,
            { hNum: hp.home.ppg, aNum: ap.away.ppg })}
        ${cmpRow('Clean sheets', `${Math.round(hp.all.csRate * 100)}%`, `${Math.round(ap.all.csRate * 100)}%`,
            { hNum: hp.all.csRate, aNum: ap.all.csRate })}
        ${hr && ar ? cmpRow('Attack rating', `${fmt2(hr.attack)} <small>${ord(hr.attackRank)}</small>`, `${fmt2(ar.attack)} <small>${ord(ar.attackRank)}</small>`,
            { hNum: hr.attack, aNum: ar.attack }) : ''}
        ${hr && ar ? cmpRow('Defence rating', `${fmt2(hr.defence)} <small>${ord(hr.defenceRank)}</small>`, `${fmt2(ar.defence)} <small>${ord(ar.defenceRank)}</small>`,
            { hNum: hr.defence, aNum: ar.defence, lowerBetter: true }) : ''}
        ${cmpRow('Form (last 6)', `${hp.formPoints}/${hp.formMax} pts`, `${ap.formPoints}/${ap.formMax} pts`,
            { hNum: hp.formPoints, aNum: ap.formPoints })}
        <div class="cmp-forms">
          <span>${formStrip(hp.recent)}</span><i>recent results</i><span>${formStrip(ap.recent)}</span>
        </div>
      </div>` : '';

    const charts = matrix ? `<div class="pred-charts">
        <div class="chart-box"><div class="label">Most likely scorelines</div>${heatmapSvg(matrix, ctx, o.actual)}</div>
        <div class="chart-box"><div class="label">Total goals in the match</div>${goalsSvg(matrix)}
          <div class="chart-note">Under 2.5 ${pct(pred.under25)} · Over 2.5 ${pct(pred.over25)} · Both score ${pct(pred.btts)}</div></div>
      </div>` : '';

    const scatter = (ranks.__all && ranks.__all.length > 3) ? `<div class="chart-box wide">
        <div class="label">Where both clubs sit in the competition</div>${scatterSvg(ranks, ctx)}
        <div class="chart-note">Each dot is a club: further right scores more, lower concedes less.</div>
      </div>` : '';

    const players = d.scorers ? `<div class="pred-players">
        ${['home', 'away'].map(side => {
          const s = d.scorers[side] || { goals: [], assists: [] };
          const team = ctx[side];
          if (!s.goals.length && !s.assists.length) return `<div><div class="label">${A.esc(team.name)}</div><div class="chart-note">No scoring charts published yet.</div></div>`;
          return `<div><div class="label">${A.esc(team.name)} — in front of goal</div>
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
        <div class="label">Underlying performance — goals against expected goals</div>
        <div class="xg-grid">${['home', 'away'].map(side => {
          const rows = d.xg[side] || [];
          if (!rows.length) return '';
          const g = rows.reduce((s, r) => s + r.goals, 0), x = rows.reduce((s, r) => s + r.xg, 0);
          const diff = g - x;
          return `<div class="xg-col"><b>${A.esc(ctx[side].name)}</b>
            <span class="xg-sum ${diff >= 0 ? 'over' : 'under'}">${g} scored from ${fmt1(x)} xG
              <i>${diff >= 0 ? 'clinical' : 'wasteful'} by ${fmt1(Math.abs(diff))}</i></span>
            ${rows.map(r => `<span class="xg-row"><i>${A.esc(r.opponent || '')}</i>
              <em>${r.goals} <small>/ ${fmt1(r.xg)} xG</small></em></span>`).join('')}</div>`;
        }).join('')}</div>
        <div class="chart-note">Shown as context only — xG is not fed into the model, because the feed carries it for the current season alone.</div>
      </div>` : '';

    const factors = [];
    if (pred.strength) factors.push(`Home advantage ×${fmt2(pred.strength.homeAdvantage)}`);
    factors.push(`Fitted on ${pred.ratingMatches || 0} matches`);
    if (pred.lowConfidence) factors.push('Thin history — low confidence');

    return `<div class="card-title"><span class="label">${live ? 'Live prediction' : 'Prediction'}</span>
        <span class="label">${live ? `recalculated at ${pred.minute}'` : 'model estimate · not advice'}</span></div>
      ${verdict}
      <div class="pred-bars">
        ${barRow('h', ctx.home.name, pred.home)}
        ${barRow('d', 'Draw', pred.draw)}
        ${barRow('a', ctx.away.name, pred.away)}
      </div>
      <div class="pred-stats">
        <div><i>${live ? 'Projected final' : 'Expected goals'}</i><b>${fmt2(pred.expectedHome)} – ${fmt2(pred.expectedAway)}</b></div>
        <div><i>Most likely score</i><b>${top ? `${top.h}–${top.a}` : '–'}</b></div>
        <div><i>Both teams score</i><b>${pct(pred.btts)}</b></div>
        <div><i>Over 2.5 goals</i><b>${pct(pred.over25)}</b></div>
      </div>
      ${d.hp ? `<div class="pred-why"><div class="label">Why this prediction</div>${narrative(ctx, pred, d)}</div>` : ''}
      ${compare}
      ${charts}
      ${scatter}
      ${players}
      ${xgPanel}
      ${movementChart(ctx.matchId)}
      ${(pred.homeAbsences && pred.homeAbsences.length) || (pred.awayAbsences && pred.awayAbsences.length)
        ? `<div class="pred-abs"><div class="label">Availability</div>${absenceChips(pred.homeAbsences, ctx.home.name)}${absenceChips(pred.awayAbsences, ctx.away.name)}</div>`
        : ''}
      <div class="pred-scores">${(pred.topScores || []).slice(0, 5).map(s =>
        `<span class="sc-chip"><b>${s.h}–${s.a}</b><i>${pct(s.p)}</i></span>`).join('')}</div>
      <ul class="pred-factors">${factors.map(f => `<li>${f}</li>`).join('')}</ul>
      <p class="fine">Built from ${pred.ratingMatches || 0} past results, home advantage and availability signals. Football
        is not predictable to this precision — a 50% call still loses half the time. ESPN publishes no injury data for
        football, so availability is inferred and can be wrong. No betting odds are used.</p>`;
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
