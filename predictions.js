'use strict';

/* ============================================================
   Pitchside — prediction model

   Dixon-Coles style bivariate Poisson with exponential time decay.
   Pure maths and metrics: no DOM, no fetch. The browser feeds it
   matches and so does the Node backtest harness, so the model that
   ships is literally the model that gets scored.
   ============================================================ */

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Predict = api;
}(typeof self !== 'undefined' ? self : this, function () {

  /* Defaults chosen by walk-forward backtest over 2025-26 (eng.1/esp.1/ger.1,
     1066 matches). The parameter surface is genuinely flat: everything from
     halfLife 90-400 with shrinkage 4-14 scores RPS 0.205-0.211, so these sit
     in the middle of a plateau rather than at a sharp optimum. Notably, heavy
     recency weighting does NOT improve outcome prediction on this data — a
     400-day half-life scored marginally best — so form matters less than it
     feels like it should.

     xgBlend defaults to 0 (off) on purpose: ESPN only carries xG for the
     current season, so there is no historical xG to validate a blend against.
     The code path is kept and can be switched on once the season is long
     enough to backtest it, but nothing here claims an improvement we have not
     measured. */
  const DEFAULTS = {
    halfLifeDays: 270,   // how fast old results stop mattering
    xgBlend: 0,          // unvalidated on this data source — see note above
    shrinkage: 8,        // pseudo-matches pulling a thin-sample club to average
    iterations: 80,
    maxGoals: 9,
    minMatches: 40,      // below this a league is flagged low-confidence
  };

  const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;

  /* ---------------- helpers ---------------- */
  function logFactorial(n) {
    let s = 0;
    for (let i = 2; i <= n; i++) s += Math.log(i);
    return s;
  }
  const LOG_FACT = Array.from({ length: 16 }, (_, i) => logFactorial(i));
  function poissonPmf(k, lambda) {
    if (lambda <= 0) return k === 0 ? 1 : 0;
    return Math.exp(k * Math.log(lambda) - lambda - (LOG_FACT[k] != null ? LOG_FACT[k] : logFactorial(k)));
  }

  // Dixon-Coles low-score correction: independent Poisson misfits 0-0/1-0/0-1/1-1
  function tau(x, y, lh, la, rho) {
    if (x === 0 && y === 0) return 1 - lh * la * rho;
    if (x === 0 && y === 1) return 1 + lh * rho;
    if (x === 1 && y === 0) return 1 + la * rho;
    if (x === 1 && y === 1) return 1 - rho;
    return 1;
  }

  const decay = (days, halfLife) => Math.pow(0.5, Math.max(0, days) / halfLife);

  // xG predicts future performance better than goals do, so train on a blend
  // wherever xG has been fetched; fall back to goals cleanly when it hasn't.
  function target(goals, xg, blend) {
    const g = Number(goals);
    if (xg == null || !isFinite(Number(xg))) return g;
    return (1 - blend) * g + blend * Number(xg);
  }

  function geoNormalise(arr) {
    let s = 0, n = 0;
    for (let i = 0; i < arr.length; i++) {
      if (arr[i] > 0) { s += Math.log(arr[i]); n++; }
    }
    if (!n) return;
    const g = Math.exp(s / n);
    if (g > 0) for (let i = 0; i < arr.length; i++) arr[i] /= g;
  }

  /* ---------------- rating fit ----------------
     Multiplicative Poisson (iterative proportional fitting):
       lambda_home = M * A[home] * D[away] * H
       lambda_away = M * A[away] * D[home]
     Closed-form ratio updates — no learning rate to babysit, converges in
     tens of iterations, and stays stable on the thin samples small leagues
     give us. Shrinkage pulls low-sample clubs toward league average. */
  function fitRatings(matches, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const asOf = o.asOf ? new Date(o.asOf).getTime() : Date.now();

    const teams = [];
    const idx = {};
    (matches || []).forEach(m => {
      [m.home, m.away].forEach(t => {
        if (t != null && idx[t] === undefined) { idx[t] = teams.length; teams.push(String(t)); }
      });
    });
    const n = teams.length;
    if (!n) return null;

    const rows = [];
    for (const m of matches) {
      const hg = Number(m.hg), ag = Number(m.ag);
      if (!isFinite(hg) || !isFinite(ag)) continue;
      const days = (asOf - new Date(m.date).getTime()) / 86400000;
      if (days < 0) continue;                       // never train on the future
      rows.push({
        h: idx[m.home], a: idx[m.away], hg, ag,
        yh: target(hg, m.hxg, o.xgBlend),
        ya: target(ag, m.axg, o.xgBlend),
        w: decay(days, o.halfLifeDays),
      });
    }
    if (!rows.length) return null;

    const A = new Float64Array(n).fill(1);
    const D = new Float64Array(n).fill(1);
    const wCount = new Float64Array(n);
    let H = 1.3;

    let swGoals = 0, swSlots = 0;
    for (const r of rows) {
      swGoals += r.w * (r.yh + r.ya);
      swSlots += r.w * 2;
      wCount[r.h] += r.w;
      wCount[r.a] += r.w;
    }
    /* M is the baseline scoring level and H the home multiplier. BOTH must be
       free: with M pinned to the overall mean, only one of the home/away goal
       totals can be matched and home advantage collapses toward 1. */
    let M = swSlots > 0 ? swGoals / swSlots : 1.35;

    for (let it = 0; it < o.iterations; it++) {
      const numA = new Float64Array(n), denA = new Float64Array(n);
      const numD = new Float64Array(n), denD = new Float64Array(n);
      let numH = 0, denH = 0;

      for (const r of rows) {
        numA[r.h] += r.w * r.yh;  denA[r.h] += r.w * M * D[r.a] * H;
        numA[r.a] += r.w * r.ya;  denA[r.a] += r.w * M * D[r.h];
        numD[r.a] += r.w * r.yh;  denD[r.a] += r.w * M * A[r.h] * H;
        numD[r.h] += r.w * r.ya;  denD[r.h] += r.w * M * A[r.a];
        numH      += r.w * r.yh;  denH      += r.w * M * A[r.h] * D[r.a];
      }
      for (let i = 0; i < n; i++) {
        const k = wCount[i] / (wCount[i] + o.shrinkage);   // shrink thin samples
        if (denA[i] > 0) A[i] = Math.exp(Math.log(clamp(numA[i] / denA[i], 0.2, 5)) * k);
        if (denD[i] > 0) D[i] = Math.exp(Math.log(clamp(numD[i] / denD[i], 0.2, 5)) * k);
      }
      if (denH > 0) H = clamp(numH / denH, 1.0, 1.8);
      geoNormalise(A);
      geoNormalise(D);

      // re-level M against the goals the current ratings actually imply
      let expTotal = 0;
      for (const r of rows) expTotal += r.w * (A[r.h] * D[r.a] * H + A[r.a] * D[r.h]);
      if (expTotal > 0) M = clamp(swGoals / expTotal, 0.4, 4);
    }

    // rho fitted separately on integer scores: the DC correction is only
    // defined for actual scorelines, and our targets may be blended with xG
    let rho = 0, best = -Infinity;
    for (let cand = -0.18; cand <= 0.181; cand += 0.02) {
      let ll = 0;
      for (const r of rows) {
        const lh = M * A[r.h] * D[r.a] * H;
        const la = M * A[r.a] * D[r.h];
        const t = tau(r.hg, r.ag, lh, la, cand);
        if (t <= 0) { ll = -Infinity; break; }
        ll += r.w * Math.log(t);
      }
      if (ll > best) { best = ll; rho = cand; }
    }

    const ratings = { teams, idx, A: Array.from(A), D: Array.from(D), H, M, rho,
                      matches: rows.length, lowConfidence: rows.length < o.minMatches,
                      halfLifeDays: o.halfLifeDays, xgBlend: o.xgBlend, fittedAt: Date.now() };
    return ratings;
  }

  /* ---------------- score distribution ---------------- */
  function scoreMatrix(lh, la, rho, maxGoals) {
    const N = (maxGoals || DEFAULTS.maxGoals) + 1;
    const ph = new Array(N), pa = new Array(N);
    for (let i = 0; i < N; i++) { ph[i] = poissonPmf(i, lh); pa[i] = poissonPmf(i, la); }
    const m = [];
    let total = 0;
    for (let i = 0; i < N; i++) {
      m[i] = new Array(N);
      for (let j = 0; j < N; j++) {
        const v = ph[i] * pa[j] * tau(i, j, lh, la, rho || 0);
        m[i][j] = v > 0 ? v : 0;
        total += m[i][j];
      }
    }
    if (total > 0) for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) m[i][j] /= total;
    return m;
  }

  function summarise(matrix, lh, la) {
    const N = matrix.length;
    let home = 0, draw = 0, away = 0, btts = 0, over25 = 0, csH = 0, csA = 0;
    const scores = [];
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        const p = matrix[i][j];
        if (i > j) home += p; else if (i === j) draw += p; else away += p;
        if (i > 0 && j > 0) btts += p;
        if (i + j > 2.5) over25 += p;
        if (j === 0) csH += p;
        if (i === 0) csA += p;
        scores.push({ h: i, a: j, p });
      }
    }
    scores.sort((x, y) => y.p - x.p);
    return {
      home, draw, away, btts, over25, under25: 1 - over25,
      cleanSheetHome: csH, cleanSheetAway: csA,
      expectedHome: lh, expectedAway: la,
      topScores: scores.slice(0, 6),
    };
  }

  /* ---------------- availability ----------------
     Each absent player removes a share of their club's attacking output,
     scaled by how much we trust the signal. Capped hard so one shaky news
     match cannot swing a prediction. */
  const SIGNAL_WEIGHT = { manual: 1, suspension: 1, lineup: 0.6, news: 0.4 };

  function availabilityFactor(absences, opts) {
    const cap = (opts && opts.cap) != null ? opts.cap : 0.2;
    let attackLoss = 0, defenceLoss = 0;
    (absences || []).forEach(a => {
      const w = SIGNAL_WEIGHT[a.signal] != null ? SIGNAL_WEIGHT[a.signal] : 0.4;
      const share = clamp(Number(a.share) || 0, 0, 0.6);
      if (a.defensive) defenceLoss += share * w;
      else attackLoss += share * w;
    });
    return {
      attack: 1 - clamp(attackLoss, 0, cap),
      concede: 1 + clamp(defenceLoss, 0, cap),
      attackLoss: clamp(attackLoss, 0, cap),
      defenceLoss: clamp(defenceLoss, 0, cap),
    };
  }

  /* ---------------- prediction ---------------- */
  function predict(ratings, homeId, awayId, opts) {
    const o = opts || {};
    if (!ratings) return null;
    const hi = ratings.idx[homeId], ai = ratings.idx[awayId];
    const unknown = hi === undefined || ai === undefined;
    const A = ratings.A, D = ratings.D;
    const ah = hi === undefined ? 1 : A[hi], dh = hi === undefined ? 1 : D[hi];
    const aa = ai === undefined ? 1 : A[ai], da = ai === undefined ? 1 : D[ai];

    const availH = availabilityFactor(o.homeAbsences, o);
    const availA = availabilityFactor(o.awayAbsences, o);

    const lh = ratings.M * ah * da * ratings.H * availH.attack * availA.concede;
    const la = ratings.M * aa * dh * availA.attack * availH.concede;

    const matrix = scoreMatrix(lh, la, ratings.rho, o.maxGoals);
    const out = summarise(matrix, lh, la);
    out.lowConfidence = !!ratings.lowConfidence || unknown;
    out.unknownTeam = unknown;
    out.availability = { home: availH, away: availA };
    out.strength = {
      homeAttack: ah, homeDefence: dh, awayAttack: aa, awayDefence: da, homeAdvantage: ratings.H,
    };
    return out;
  }

  /* ---------------- in-play ----------------
     Remaining goals only: scale the pre-match rates by time left, then adjust
     for game state (trailing sides push, leaders sit) and red cards. */
  function inPlay(pre, state) {
    if (!pre) return null;
    const s = state || {};
    const minute = clamp(Number(s.minute) || 0, 0, 120);
    const hg = Number(s.homeGoals) || 0, ag = Number(s.awayGoals) || 0;
    const redH = Number(s.redHome) || 0, redA = Number(s.redAway) || 0;

    let remain = minute >= 90 ? 0.03 : (90 - minute) / 90;   // stoppage still allows a goal
    if (s.finished) remain = 0;

    const lead = hg - ag;
    const chaseHome = lead < 0 ? Math.pow(1.10, Math.min(2, -lead)) : Math.pow(0.95, Math.min(2, lead));
    const chaseAway = lead > 0 ? Math.pow(1.10, Math.min(2, lead)) : Math.pow(0.95, Math.min(2, -lead));

    const redAttackH = Math.pow(0.75, redH), redAttackA = Math.pow(0.75, redA);
    const redConcedeH = Math.pow(1.25, redH), redConcedeA = Math.pow(1.25, redA);

    const lh = pre.expectedHome * remain * chaseHome * redAttackH * redConcedeA;
    const la = pre.expectedAway * remain * chaseAway * redAttackA * redConcedeH;

    const N = 7;
    const ph = [], pa = [];
    for (let i = 0; i < N; i++) { ph.push(poissonPmf(i, lh)); pa.push(poissonPmf(i, la)); }

    let home = 0, draw = 0, away = 0, btts = 0, over25 = 0;
    const scores = [];
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        const p = ph[i] * pa[j];
        const fh = hg + i, fa = ag + j;
        if (fh > fa) home += p; else if (fh === fa) draw += p; else away += p;
        if (fh > 0 && fa > 0) btts += p;
        if (fh + fa > 2.5) over25 += p;
        scores.push({ h: fh, a: fa, p });
      }
    }
    const tot = home + draw + away || 1;
    scores.sort((x, y) => y.p - x.p);
    return {
      home: home / tot, draw: draw / tot, away: away / tot,
      btts, over25, under25: 1 - over25,
      expectedHome: hg + lh, expectedAway: ag + la,
      remainingHome: lh, remainingAway: la,
      topScores: scores.slice(0, 6),
      live: true, minute,
    };
  }

  /* ---------------- metrics ----------------
     RPS is the standard ordered metric for 1X2: it punishes predicting a
     home win when the away side wins harder than predicting a draw. */
  function rps(probs, outcome) {
    const p = [probs.home, probs.draw, probs.away];
    const o = [outcome === 'home' ? 1 : 0, outcome === 'draw' ? 1 : 0, outcome === 'away' ? 1 : 0];
    let cp = 0, co = 0, sum = 0;
    for (let i = 0; i < 2; i++) { cp += p[i]; co += o[i]; sum += (cp - co) * (cp - co); }
    return sum / 2;
  }
  function brier(probs, outcome) {
    const p = [probs.home, probs.draw, probs.away];
    const o = [outcome === 'home' ? 1 : 0, outcome === 'draw' ? 1 : 0, outcome === 'away' ? 1 : 0];
    return p.reduce((s, v, i) => s + (v - o[i]) * (v - o[i]), 0) / 3;
  }
  function logLoss(probs, outcome) {
    const p = clamp(probs[outcome], 1e-9, 1);
    return -Math.log(p);
  }
  const outcomeOf = (hg, ag) => hg > ag ? 'home' : hg < ag ? 'away' : 'draw';
  const pickOf = p => p.home >= p.draw && p.home >= p.away ? 'home' : (p.away >= p.draw ? 'away' : 'draw');

  /* ---------------- calibration ----------------
     Temperature scaling on accumulated settled predictions: if the model is
     systematically over-confident, T > 1 flattens it. Fitted by minimising
     log loss over the ledger. */
  function fitTemperature(history) {
    const rows = (history || []).filter(h => h && h.probs && h.outcome);
    if (rows.length < 30) return 1;
    let bestT = 1, best = Infinity;
    for (let T = 0.6; T <= 2.51; T += 0.05) {
      let ll = 0;
      for (const r of rows) ll += logLoss(applyTemperature(r.probs, T), r.outcome);
      if (ll < best) { best = ll; bestT = T; }
    }
    return Math.round(bestT * 100) / 100;
  }
  function applyTemperature(probs, T) {
    if (!T || T === 1) return probs;
    const keys = ['home', 'draw', 'away'];
    const raised = keys.map(k => Math.pow(clamp(probs[k], 1e-9, 1), 1 / T));
    const s = raised.reduce((a, b) => a + b, 0) || 1;
    const out = {};
    keys.forEach((k, i) => { out[k] = raised[i] / s; });
    return Object.assign({}, probs, out);
  }

  function reliability(history, bins) {
    const B = bins || 10;
    const out = Array.from({ length: B }, (_, i) => ({ lo: i / B, hi: (i + 1) / B, n: 0, hits: 0 }));
    (history || []).forEach(h => {
      if (!h.probs || !h.outcome) return;
      ['home', 'draw', 'away'].forEach(k => {
        const p = h.probs[k];
        if (p == null) return;
        const b = Math.min(B - 1, Math.floor(p * B));
        out[b].n++;
        if (h.outcome === k) out[b].hits++;
      });
    });
    return out.map(b => Object.assign({}, b, { observed: b.n ? b.hits / b.n : null, expected: (b.lo + b.hi) / 2 }));
  }

  /* ---------------- walk-forward backtest ----------------
     Refit per matchday on strictly earlier matches, predict the next round.
     This is what makes an accuracy claim honest: nothing in the fit has seen
     the match it is predicting. */
  function backtest(matches, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const sorted = (matches || []).slice()
      .filter(m => isFinite(Number(m.hg)) && isFinite(Number(m.ag)))
      .sort((a, b) => new Date(a.date) - new Date(b.date));
    if (sorted.length < 60) return null;

    const byDay = new Map();
    sorted.forEach(m => {
      const k = String(m.date).slice(0, 10);
      if (!byDay.has(k)) byDay.set(k, []);
      byDay.get(k).push(m);
    });
    const days = [...byDay.keys()].sort();

    const warmup = o.warmup || Math.max(50, Math.floor(sorted.length * 0.25));
    const history = [];
    let played = [];
    let modelRps = 0, uniRps = 0, homeRps = 0, modelLL = 0, hits = 0, scored = 0;

    for (const day of days) {
      const todays = byDay.get(day);
      if (played.length >= warmup) {
        const ratings = fitRatings(played, Object.assign({}, o, { asOf: day }));
        if (ratings) {
          for (const m of todays) {
            const p = predict(ratings, m.home, m.away, o);
            if (!p) continue;
            const outcome = outcomeOf(m.hg, m.ag);
            const probs = { home: p.home, draw: p.draw, away: p.away };
            modelRps += rps(probs, outcome);
            uniRps += rps({ home: 1 / 3, draw: 1 / 3, away: 1 / 3 }, outcome);
            homeRps += rps({ home: 1, draw: 0, away: 0 }, outcome);
            modelLL += logLoss(probs, outcome);
            if (pickOf(probs) === outcome) hits++;
            scored++;
            history.push({ date: m.date, home: m.home, away: m.away, probs, outcome });
          }
        }
      }
      played = played.concat(todays);
    }
    if (!scored) return null;
    return {
      n: scored,
      rps: modelRps / scored,
      rpsUniform: uniRps / scored,
      rpsAlwaysHome: homeRps / scored,
      logLoss: modelLL / scored,
      accuracy: hits / scored,
      beatsUniform: (modelRps / scored) < (uniRps / scored),
      history,
      reliability: reliability(history),
      temperature: fitTemperature(history),
    };
  }


  /* ---------------- descriptive analytics ----------------
     Everything below explains a prediction rather than producing it: form,
     home/away splits, league ranks, goal distributions. All derived from the
     same match list the ratings are fitted on, so nothing extra is fetched. */

  function teamProfile(matches, teamId, opts) {
    const o = opts || {};
    const id = String(teamId);
    const games = (matches || [])
      .filter(m => String(m.home) === id || String(m.away) === id)
      .sort((a, b) => new Date(a.date) - new Date(b.date));
    const blank = { played: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, cs: 0, pts: 0 };
    const all = Object.assign({}, blank);
    const home = Object.assign({}, blank);
    const away = Object.assign({}, blank);
    const recent = [];

    games.forEach(m => {
      const atHome = String(m.home) === id;
      const gf = atHome ? m.hg : m.ag;
      const ga = atHome ? m.ag : m.hg;
      const res = gf > ga ? "W" : gf === ga ? "D" : "L";
      const bucket = atHome ? home : away;
      [all, bucket].forEach(b => {
        b.played++; b.gf += gf; b.ga += ga;
        if (res === "W") { b.w++; b.pts += 3; } else if (res === "D") { b.d++; b.pts += 1; } else b.l++;
        if (ga === 0) b.cs++;
      });
      recent.push({
        date: m.date, res, gf, ga, atHome,
        opponent: atHome ? (m.awayName || m.away) : (m.homeName || m.home),
        opponentId: atHome ? m.away : m.home,
        xg: atHome ? m.hxg : m.axg,
        xga: atHome ? m.axg : m.hxg,
      });
    });

    const per = b => ({
      played: b.played, w: b.w, d: b.d, l: b.l, gf: b.gf, ga: b.ga, cs: b.cs, pts: b.pts,
      gfpg: b.played ? b.gf / b.played : 0,
      gapg: b.played ? b.ga / b.played : 0,
      ppg: b.played ? b.pts / b.played : 0,
      csRate: b.played ? b.cs / b.played : 0,
    });
    const lastN = recent.slice(-(o.formGames || 6)).reverse();
    const formPts = lastN.reduce((s, r) => s + (r.res === "W" ? 3 : r.res === "D" ? 1 : 0), 0);
    return {
      all: per(all), home: per(home), away: per(away),
      recent: lastN,
      formPoints: formPts,
      formMax: lastN.length * 3,
      formGfpg: lastN.length ? lastN.reduce((s, r) => s + r.gf, 0) / lastN.length : 0,
      formGapg: lastN.length ? lastN.reduce((s, r) => s + r.ga, 0) / lastN.length : 0,
    };
  }

  // where a club sits in its own league for attack and defence
  function leagueRanks(ratings) {
    if (!ratings) return {};
    const rows = ratings.teams.map((t, i) => ({ id: t, attack: ratings.A[i], defence: ratings.D[i] }));
    const byAttack = rows.slice().sort((a, b) => b.attack - a.attack);
    const byDefence = rows.slice().sort((a, b) => a.defence - b.defence); // lower concedes less
    const out = {};
    rows.forEach(r => {
      out[r.id] = {
        attack: r.attack, defence: r.defence,
        attackRank: byAttack.findIndex(x => x.id === r.id) + 1,
        defenceRank: byDefence.findIndex(x => x.id === r.id) + 1,
        of: rows.length,
      };
    });
    out.__all = rows;
    return out;
  }

  // P(total goals = k) and the cumulative over/under ladder
  function goalsDistribution(matrix, maxTotal) {
    const N = matrix.length;
    const cap = maxTotal || 6;
    const dist = new Array(cap + 1).fill(0);
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        const t = Math.min(cap, i + j);
        dist[t] += matrix[i][j];
      }
    }
    return dist;
  }

  // "which side does each scoreline favour" — for shading a heatmap
  function matrixCells(matrix, cap) {
    const N = Math.min(matrix.length, (cap || 5) + 1);
    const cells = [];
    let max = 0;
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) if (matrix[i][j] > max) max = matrix[i][j];
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        cells.push({ h: i, a: j, p: matrix[i][j], rel: max > 0 ? matrix[i][j] / max : 0,
                     side: i > j ? "home" : i === j ? "draw" : "away" });
      }
    }
    return { cells, size: N, max };
  }

  return {
    DEFAULTS, fitRatings, predict, inPlay, scoreMatrix, summarise,
    teamProfile, leagueRanks, goalsDistribution, matrixCells,
    availabilityFactor, SIGNAL_WEIGHT,
    rps, brier, logLoss, outcomeOf, pickOf,
    fitTemperature, applyTemperature, reliability, backtest,
    poissonPmf, tau,
  };
}));
