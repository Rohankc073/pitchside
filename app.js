'use strict';

/* ============================================================
   Pitchside — live scores, leagues, teams, players
   Data: ESPN public feeds (no key, CORS open)

   Note on player photos: ESPN publishes no headshots for soccer
   (every /i/headshots/soccer/... path 404s), so players are shown
   with a jersey-number avatar and their country flag instead.
   ============================================================ */

const API = 'https://site.api.espn.com/apis/site/v2/sports/soccer';
const API2 = 'https://site.api.espn.com/apis/v2/sports/soccer';
const WEB = 'https://site.web.api.espn.com/apis/common/v3/sports/soccer';
const CORE = 'https://sports.core.api.espn.com/v2/sports/soccer/leagues';

const LEAGUES = [
  { id: 'uefa.champions', name: 'Champions League', region: 'Europe', logoId: 2 },
  { id: 'eng.1', name: 'Premier League', region: 'England', logoId: 23 },
  { id: 'esp.1', name: 'LaLiga', region: 'Spain', logoId: 15 },
  { id: 'ita.1', name: 'Serie A', region: 'Italy', logoId: 12 },
  { id: 'ger.1', name: 'Bundesliga', region: 'Germany', logoId: 10 },
  { id: 'fra.1', name: 'Ligue 1', region: 'France', logoId: 9 },
  { id: 'uefa.europa', name: 'Europa League', region: 'Europe', logoId: 2310 },
  { id: 'uefa.europa.conf', name: 'Conference League', region: 'Europe', logoId: 20296 },
  { id: 'eng.2', name: 'Championship', region: 'England', logoId: 24 },
  { id: 'por.1', name: 'Primeira Liga', region: 'Portugal', logoId: 14 },
  { id: 'ned.1', name: 'Eredivisie', region: 'Netherlands', logoId: 11 },
  { id: 'tur.1', name: 'Süper Lig', region: 'Turkey', logoId: 18 },
  { id: 'bel.1', name: 'Pro League', region: 'Belgium', logoId: 6 },
  { id: 'sco.1', name: 'Premiership', region: 'Scotland', logoId: 45 },
  { id: 'ksa.1', name: 'Saudi Pro League', region: 'Saudi Arabia', logoId: 2488 },
  { id: 'usa.1', name: 'MLS', region: 'USA', logoId: 19 },
  { id: 'mex.1', name: 'Liga MX', region: 'Mexico', logoId: 22 },
  { id: 'bra.1', name: 'Brasileirão', region: 'Brazil', logoId: 85 },
  { id: 'arg.1', name: 'Liga Profesional', region: 'Argentina', logoId: 1 },
];
const LG_BY_ID = Object.fromEntries(LEAGUES.map(l => [l.id, l]));
const UEFA = ['uefa.champions', 'uefa.europa', 'uefa.europa.conf'];

/* ---------------- helpers ---------------- */
const $ = (sel, root = document) => root.querySelector(sel);
const pad = n => String(n).padStart(2, '0');
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ymd = d => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
const ym = d => `${d.getFullYear()}${pad(d.getMonth() + 1)}`;
const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const addMonths = (d, n) => new Date(d.getFullYear(), d.getMonth() + n, 1);
const parseYmd = s => new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
const isToday = d => ymd(d) === ymd(new Date());
const fmtTime = iso => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const fmtDayLong = d => d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
const fmtDayShort = d => d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
const initials = name => String(name || '?').split(/\s+/).map(w => w[0]).join('').slice(0, 3).toUpperCase();
function hexA(hex, a) {
  const h = String(hex || '').replace('#', '');
  if (h.length !== 6) return `rgba(61,220,132,${a})`;
  return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${a})`;
}
function tzLabel() {
  try {
    const z = new Intl.DateTimeFormat([], { timeZoneName: 'short' }).formatToParts(new Date()).find(x => x.type === 'timeZoneName');
    return z ? `All times in your local time (${z.value})` : '';
  } catch (e) { return ''; }
}
const refId = url => { const m = String(url || '').match(/\/(\d+)(?:\?|$)/); return m ? m[1] : null; };

/* ---------------- icons ---------------- */
const sv = inner => `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
const ICON = {
  ball: sv('<circle cx="12" cy="12" r="9"/><path d="m12 7.4 3.6 2.6-1.4 4.3h-4.4L8.4 10z"/><path d="M12 3.3v4.1M20.4 9.8 15.6 10M3.6 9.8l4.8.2M17.7 19.1l-3.1-4.2M6.3 19.1l3.1-4.2"/>'),
  chevL: sv('<path d="m15 18-6-6 6-6"/>'),
  chevR: sv('<path d="m9 18 6-6-6-6"/>'),
  cal: sv('<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M8 3v4M16 3v4M3 10h18"/>'),
  clock: sv('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  star: sv('<path d="m12 3.6 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 9.8l5.9-.9z"/>'),
  starOn: '<svg class="ic" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><path d="m12 3.6 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 9.8l5.9-.9z"/></svg>',
  stadium: sv('<ellipse cx="12" cy="9" rx="9" ry="4"/><path d="M3 9v6c0 2.2 4 4 9 4s9-1.8 9-4V9"/><path d="M8 11.4V19M16 11.4V19"/>'),
  users: sv('<circle cx="9" cy="8" r="3.2"/><path d="M3.5 19.5a5.8 5.8 0 0 1 11 0"/><path d="M16.5 5.2a3.2 3.2 0 0 1 0 5.9M17.5 14.4a5.6 5.6 0 0 1 3.2 5.1"/>'),
  whistle: sv('<path d="M14.5 8.5A5.5 5.5 0 1 0 9 19h3.2l6.3-3.6a3 3 0 0 0 1.5-2.6V10a1.5 1.5 0 0 0-1.5-1.5z"/><circle cx="9" cy="13.5" r="1.6"/>'),
  swap: sv('<path d="M4 8h12l-3-3M20 16H8l3 3"/>'),
  arrowUp: sv('<path d="M12 19V5M6 11l6-6 6 6"/>'),
  arrowDown: sv('<path d="M12 5v14M18 13l-6 6-6-6"/>'),
  chart: sv('<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>'),
  list: sv('<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>'),
  shirt: sv('<path d="M8 3 5 5 3 9l3 1.5V21h12V10.5L21 9l-2-4-3-2a4 4 0 0 1-8 0z"/>'),
  person: sv('<circle cx="12" cy="8" r="3.6"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/>'),
  x: sv('<path d="M18 6 6 18M6 6l12 12"/>'),
  play: sv('<path d="M8 5.5v13l10-6.5z"/>'),
  tv: sv('<rect x="2.5" y="6" width="19" height="13" rx="2.5"/><path d="M8 2.8 12 6l4-3.2"/>'),
  heart: sv('<path d="M12 20s-7-4.6-7-9.4A3.9 3.9 0 0 1 12 8a3.9 3.9 0 0 1 7 2.6C19 15.4 12 20 12 20z"/>'),
  heartOn: '<svg class="ic" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><path d="M12 20s-7-4.6-7-9.4A3.9 3.9 0 0 1 12 8a3.9 3.9 0 0 1 7 2.6C19 15.4 12 20 12 20z"/></svg>',
  info: sv('<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>'),
  refresh: sv('<path d="M20 11a8 8 0 0 0-13.7-5.3L3 9M4 13a8 8 0 0 0 13.7 5.3L21 15"/><path d="M3 4v5h5M21 20v-5h-5"/>'),
  trophy: sv('<path d="M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M7 6H4.5A2.5 2.5 0 0 0 7 9.5M17 6h2.5A2.5 2.5 0 0 1 17 9.5"/><path d="M12 14v3M9 20h6l-.5-3h-5z"/>'),
  pin: sv('<path d="M12 21s7-5.7 7-11a7 7 0 1 0-14 0c0 5.3 7 11 7 11z"/><circle cx="12" cy="10" r="2.6"/>'),
};
const cardIcon = k => `<span class="card ${k}" role="img" aria-label="${k === 'y' ? 'Yellow card' : 'Red card'}"></span>`;

function crest(team, cls = 'crest') {
  if (!team || !team.logo) return `<span class="${cls === 'crest' ? 'crest-fb' : cls + ' crest-fb'}">${esc(initials(team && (team.abbr || team.name)))}</span>`;
  const url = `https://a.espncdn.com/combiner/i?img=${encodeURIComponent(team.logo.replace('https://a.espncdn.com', ''))}&w=120&h=120`;
  return `<img class="${cls}" src="${esc(url)}" alt="" loading="lazy">`;
}
function lgLogo(lgId, cls = 'lg-logo') {
  const lg = LG_BY_ID[lgId] || {};
  const url = (S.lgMeta[lgId] && S.lgMeta[lgId].logo) || (lg.logoId ? `https://a.espncdn.com/i/leaguelogos/soccer/500-dark/${lg.logoId}.png` : '');
  const name = lg.name || lgId;
  if (!url) return `<span class="lg-fallback">${esc(initials(name))}</span>`;
  return `<img class="${cls}" src="${esc(url)}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'lg-fallback',textContent:'${esc(initials(name))}'}))">`;
}
/* portrait when Wikipedia has one, shirt number underneath as the fallback */
function avatar(p, size = '') {
  const num = p && p.jersey ? esc(p.jersey) : (p && p.name ? esc(initials(p.name)) : '');
  const photo = p && p.name ? photoOf(p.name) : '';
  return `<span class="avatar ${size}${photo ? ' has-photo' : ''}">
    <span class="av-num">${num}</span>
    ${photo ? `<img class="av-img" src="${esc(photo)}" alt="" loading="lazy" onerror="this.remove()">` : ''}
    ${p && p.flag ? `<img class="av-flag" src="${esc(p.flag)}" alt="" loading="lazy">` : ''}
  </span>`;
}

/* ---------------- request layer ---------------- */
const cache = new Map();
const inflight = new Map();
let active = 0;
const waiting = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
function pump() {
  while (active < 6 && waiting.length) {
    const job = waiting.shift();
    active++;
    job().finally(() => { active--; pump(); });
  }
}
function request(url, { ttl = 30000, force = false } = {}) {
  const hit = cache.get(url);
  if (!force && hit && Date.now() - hit.t < ttl) return Promise.resolve(hit.data);
  if (inflight.has(url)) return inflight.get(url);
  const p = new Promise((resolve, reject) => {
    waiting.push(async () => {
      let lastErr;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await fetch(url);
          if (!res.ok) throw new Error('HTTP ' + res.status);
          const data = await res.json();
          cache.set(url, { t: Date.now(), data });
          resolve(data);
          return;
        } catch (err) {
          lastErr = err;
          if (attempt < 2) await sleep(350 * Math.pow(2, attempt) + Math.random() * 150);
        }
      }
      reject(lastErr);
    });
    pump();
  }).finally(() => inflight.delete(url));
  inflight.set(url, p);
  return p;
}

/* persistent small caches (names/teams resolve instantly on revisit) */
function loadLS(key, fallback) { try { return JSON.parse(localStorage.getItem(key) || '') || fallback; } catch (e) { return fallback; } }
const LS = {
  people: loadLS('pitchside.people', {}),
  teams: loadLS('pitchside.teams', {}),
  meta: loadLS('pitchside.lgmeta', {}),
  pins: loadLS('pitchside.pins', []),
  photos: loadLS('pitchside.photos', {}),
  clubs: loadLS('pitchside.clubs', {}),
  favs: loadLS('pitchside.favs', []),
};
let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem('pitchside.people', JSON.stringify(LS.people));
      localStorage.setItem('pitchside.teams', JSON.stringify(LS.teams));
      localStorage.setItem('pitchside.lgmeta', JSON.stringify(LS.meta));
      localStorage.setItem('pitchside.pins', JSON.stringify(LS.pins));
      localStorage.setItem('pitchside.photos', JSON.stringify(LS.photos));
      localStorage.setItem('pitchside.clubs', JSON.stringify(LS.clubs));
      localStorage.setItem('pitchside.favs', JSON.stringify(LS.favs));
    } catch (e) { /* storage may be unavailable */ }
  }, 400);
}

/* ---------------- player photos ----------------
   ESPN has no headshots for soccer, so portraits come from Wikipedia
   (CORS-open). Exact titles only, batched up to 40 names per request —
   a fuzzy search returns the wrong person for common names, and a wrong
   face is worse than none. Misses are cached too, so we ask once. */
const PHOTO_TTL = 7 * 86400000;
const photoOf = name => {
  const e = LS.photos[name];
  return e && e.src ? e.src : '';
};
async function fetchPhotos(names) {
  const need = [...new Set((names || []).filter(Boolean))]
    .filter(n => { const e = LS.photos[n]; return !e || Date.now() - e.t > PHOTO_TTL; });
  if (!need.length) return;
  for (let i = 0; i < need.length; i += 40) {
    const batch = need.slice(i, i + 40);
    // 400px keeps portraits sharp on retina at every size we render them
    const url = 'https://en.wikipedia.org/w/api.php?action=query&titles=' +
      encodeURIComponent(batch.join('|')) +
      '&redirects=1&prop=pageimages&piprop=thumbnail&pithumbsize=400&format=json&origin=*';
    try {
      const data = await request(url, { ttl: PHOTO_TTL });
      const q = data.query || {};
      const back = {};
      (q.normalized || []).forEach(n => { back[n.to] = n.from; });
      (q.redirects || []).forEach(r => { back[r.to] = back[r.from] || r.from; });
      const found = {};
      Object.keys(q.pages || {}).forEach(k => {
        const p = q.pages[k];
        found[back[p.title] || p.title] = (p.thumbnail && p.thumbnail.source) || null;
      });
      batch.forEach(n => { LS.photos[n] = { t: Date.now(), src: found[n] || null }; });
    } catch (err) {
      batch.forEach(n => { LS.photos[n] = { t: Date.now(), src: null }; });
    }
  }
  // Some players sit at a disambiguated title ("Ben White (footballer)").
  // Retry a few misses by search, accepting ONLY an exact name match once
  // parentheses and accents are stripped — never a merely similar person.
  const misses = need.filter(n => !LS.photos[n] || !LS.photos[n].src).slice(0, 8);
  for (const name of misses) {
    const src = await searchPhoto(name);
    if (src) LS.photos[name] = { t: Date.now(), src };
  }
  persist();
}
const flatten = s => String(s || '').replace(/\s*\([^)]*\)\s*$/, '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
async function searchPhoto(name) {
  try {
    const data = await request('https://en.wikipedia.org/w/api.php?action=query&generator=search&gsrsearch=' +
      encodeURIComponent(`"${name}" footballer`) +
      '&gsrlimit=3&prop=pageimages&piprop=thumbnail&pithumbsize=400&format=json&origin=*', { ttl: PHOTO_TTL });
    const pages = Object.keys(((data.query || {}).pages) || {}).map(k => data.query.pages[k]);
    const hit = pages.find(p => p.thumbnail && flatten(p.title) === flatten(name));
    return hit ? hit.thumbnail.source : null;
  } catch (err) { return null; }
}

/* club background: ESPN has no founding date or stadium capacity, so the
   prose comes from Wikipedia — validated to be a football club, because a
   bare name lands on a weapons depot ("Arsenal") or a town ("Como"). */
const IS_FOOTBALL = /football|soccer/i;
async function clubSummary(name) {
  // Guard: a blank name would search " football club" and confidently return
  // an unrelated club's history. Better to show no prose than the wrong club.
  if (String(name || '').trim().length < 3) return { title: '', extract: '' };
  const key = `c|${name}`;
  if (LS.clubs[key]) return LS.clubs[key];
  let out = null;
  try {
    const s = await request(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(name)}`, { ttl: PHOTO_TTL });
    if (s && IS_FOOTBALL.test(`${s.description || ''} ${String(s.extract || '').slice(0, 220)}`)) {
      out = { title: s.title, extract: s.extract || '' };
    }
  } catch (err) { /* fall through to search */ }
  if (!out) {
    try {
      const data = await request('https://en.wikipedia.org/w/api.php?action=query&generator=search&gsrsearch=' +
        encodeURIComponent(`${name} football club`) +
        '&gsrlimit=3&prop=extracts&exintro=1&explaintext=1&exsentences=3&format=json&origin=*', { ttl: PHOTO_TTL });
      const pages = Object.keys(((data.query || {}).pages) || {}).map(k => data.query.pages[k]).sort((a, b) => a.index - b.index);
      const hit = pages.find(p => IS_FOOTBALL.test(p.extract || ''));
      if (hit) out = { title: hit.title, extract: hit.extract || '' };
    } catch (err) { /* give up quietly */ }
  }
  LS.clubs[key] = out || { title: '', extract: '' };
  persist();
  return LS.clubs[key];
}
async function getClubDetail(lgId, teamId) {
  const season = await ensureSeason(lgId);
  const t = await request(`${CORE}/${lgId}/seasons/${season.year}/teams/${teamId}?lang=en`, { ttl: 86400000 });
  const v = t.venue || {};
  return {
    name: t.displayName || '', nickname: t.nickname || '', location: t.location || '',
    venue: v.fullName || '', city: (v.address && v.address.city) || '', country: (v.address && v.address.country) || '',
    color: t.color || '', alt: t.alternateColor || '',
  };
}
const countryCode = flag => {
  const m = /countries\/\d+\/([a-z]{2,3})\.png/i.exec(flag || '');
  return m ? m[1].toUpperCase() : '';
};

/* ---------------- normalising ---------------- */
function normTeam(c) {
  const t = (c && c.team) || {};
  return {
    id: t.id, name: t.shortDisplayName || t.displayName || t.name || 'TBC',
    full: t.displayName || t.name || 'TBC', abbr: t.abbreviation || '',
    logo: t.logo || (t.logos && t.logos[0] && t.logos[0].href) || '',
    color: t.color || '', score: c && c.score != null ? String(c.score) : '',
    winner: !!(c && c.winner), form: (c && c.form) || '',
    shootout: c && c.shootoutScore != null ? c.shootoutScore : null,
  };
}
function normEvent(e, lgId) {
  const comp = (e.competitions && e.competitions[0]) || {};
  const st = e.status || comp.status || {};
  const cs = comp.competitors || [];
  return {
    id: e.id, lg: lgId, date: e.date,
    state: (st.type && st.type.state) || 'pre', status: st,
    home: normTeam(cs.find(c => c.homeAway === 'home') || cs[0]),
    away: normTeam(cs.find(c => c.homeAway === 'away') || cs[1]),
    details: comp.details || [], venue: (comp.venue && comp.venue.fullName) || '',
  };
}
function absorbMeta(lgId, data) {
  const meta = data && data.leagues && data.leagues[0];
  if (!meta) return;
  const logos = meta.logos || [];
  const dark = logos.find(l => (l.rel || []).includes('dark')) || logos[0];
  LS.meta[lgId] = Object.assign({}, LS.meta[lgId], {
    logo: dark ? dark.href : '', name: meta.name || (LG_BY_ID[lgId] || {}).name,
    season: meta.season ? { year: meta.season.year, type: meta.season.type && meta.season.type.id, label: meta.season.displayName,
                            start: meta.season.startDate, end: meta.season.endDate } : (LS.meta[lgId] || {}).season,
  });
  persist();
}

/* ---------------- state ---------------- */
const S = {
  date: startOfDay(new Date()), filter: 'all', q: '',
  days: new Map(), months: new Map(),
  lgMeta: LS.meta, pins: LS.pins,
  route: { name: 'scores' },
  matchTab: 'summary', playerSide: 'home', leagueTab: 'fixtures', teamTab: 'overview',
  monthOffset: 0, loading: 0, token: 0, current: null,
};
const savePins = () => { LS.pins = S.pins; persist(); };
const orderedLeagues = () => [...LEAGUES.filter(l => S.pins.includes(l.id)), ...LEAGUES.filter(l => !S.pins.includes(l.id))];
const lgName = id => (S.lgMeta[id] && S.lgMeta[id].name) || (LG_BY_ID[id] || {}).name || id;

const painted = new WeakMap();
function paint(el, html) {
  if (!el) return;
  if (painted.get(el) === html) return;
  painted.set(el, html);
  el.innerHTML = html;
}

/* ---------------- day + month loading ---------------- */
function dayMap(date) {
  const key = ymd(date);
  if (!S.days.has(key)) S.days.set(key, new Map());
  return S.days.get(key);
}
function espnDays(date) {
  const offset = -new Date().getTimezoneOffset();
  const days = [date];
  if (offset > 0) days.push(addDays(date, -1));
  else if (offset < 0) days.push(addDays(date, 1));
  return days;
}
async function loadLeagueDay(lg, date, force) {
  const key = ymd(date);
  const ttl = isToday(date) ? 25000 : 600000;
  const found = new Map();
  let ok = false;
  for (const d of espnDays(date)) {
    try {
      const data = await request(`${API}/${lg.id}/scoreboard?dates=${ymd(d)}`, { ttl, force });
      ok = true;
      absorbMeta(lg.id, data);
      (data.events || []).forEach(e => {
        if (!found.has(e.id) && ymd(new Date(e.date)) === key) found.set(e.id, normEvent(e, lg.id));
      });
    } catch (err) { /* neighbour day may still work */ }
  }
  dayMap(date).set(lg.id, ok ? { events: [...found.values()].sort((a, b) => new Date(a.date) - new Date(b.date)) } : { events: [], error: true });
}
async function loadDay(date, opts = {}) {
  const token = ++S.token;
  S.loading = LEAGUES.length;
  if (!opts.silent) renderScoresBody();
  const queue = orderedLeagues().slice();
  const worker = async () => {
    while (queue.length) {
      const lg = queue.shift();
      await loadLeagueDay(lg, date, !!opts.force);
      if (token !== S.token) return;
      S.loading--;
      scheduleRender();
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  if (token === S.token) { S.loading = 0; scheduleRender(); }
}
async function loadMonth(lgId, monthDate, force) {
  const key = `${lgId}|${ym(monthDate)}`;
  if (!force && S.months.has(key)) return S.months.get(key);
  const data = await request(`${API}/${lgId}/scoreboard?dates=${ym(monthDate)}&limit=400`, { ttl: 900000, force });
  absorbMeta(lgId, data);
  const events = (data.events || []).map(e => normEvent(e, lgId)).sort((a, b) => new Date(a.date) - new Date(b.date));
  S.months.set(key, events);
  return events;
}

let rafId = null;
function scheduleRender() {
  if (rafId) return;
  rafId = requestAnimationFrame(() => {
    rafId = null;
    if (S.route.name === 'scores') { renderScoresBody(); renderSidebar(); renderRail(); }
    updateLivePill();
  });
}

/* ---------------- status + goals ---------------- */
function statusOf(m) {
  const t = (m.status && m.status.type) || {};
  const name = t.name || '';
  if (/POSTPONED|CANCEL|ABANDON|SUSPEND|DELAY/.test(name)) return { kind: 'off', label: (t.shortDetail || 'PPD').toUpperCase() };
  if (t.state === 'in') {
    if (/HALFTIME/.test(name)) return { kind: 'live', label: 'HT' };
    return { kind: 'live', label: (m.status && m.status.displayClock) || t.shortDetail || 'LIVE' };
  }
  if (t.state === 'post') return { kind: 'post', label: t.shortDetail || 'FT' };
  return { kind: 'pre', label: fmtTime(m.date) };
}
function goalsOf(m) {
  const out = { home: [], away: [], redHome: 0, redAway: 0 };
  (m.details || []).forEach(d => {
    const side = d.team && String(d.team.id) === String(m.home.id) ? 'home' : 'away';
    if (d.scoringPlay && !d.shootout) {
      const who = (d.athletesInvolved && d.athletesInvolved[0]) || {};
      const mark = d.penaltyKick ? ' (pen)' : d.ownGoal ? ' (og)' : '';
      out[side].push(`${who.shortName || who.displayName || 'Goal'}${mark} ${(d.clock && d.clock.displayValue) || ''}`.trim());
    }
    if (d.redCard) out[side === 'home' ? 'redHome' : 'redAway']++;
  });
  return out;
}

/* ---------------- match row ---------------- */
function matchRow(m, opts = {}) {
  const st = statusOf(m);
  const g = goalsOf(m);
  const played = st.kind === 'live' || st.kind === 'post';
  let score;
  if (played) score = `<div class="score"><span class="box">${esc(m.home.score || '0')}</span><span class="box">${esc(m.away.score || '0')}</span></div>`;
  else if (st.kind === 'off') score = `<div class="score off">${esc(st.label)}</div>`;
  else score = `<div class="score pre"><span class="vs">${esc(fmtTime(m.date))}</span></div>`;
  const pens = (m.home.shootout != null && m.away.shootout != null && (+m.home.shootout || +m.away.shootout))
    ? `<div class="pens">Penalties ${esc(m.home.shootout)}–${esc(m.away.shootout)}</div>` : '';
  const scorers = !opts.compact && (g.home.length || g.away.length) ? `
    <div class="scorers"><div class="h">${g.home.map(esc).join('<br>')}</div><div class="mid">${ICON.ball}</div><div class="a">${g.away.map(esc).join('<br>')}</div></div>` : '';
  const red = n => n ? `<span class="redc" role="img" aria-label="${n} red card"></span>` : '';
  const cls = (t, o) => played ? (t.winner ? ' win' : o.winner ? ' lose' : '') : '';
  const meta = opts.showDate ? `<div class="m-date">${esc(fmtDayShort(new Date(m.date)))}</div>` : '';
  return `<a class="match${st.kind === 'live' ? ' live' : ''}" href="#/match/${esc(m.lg)}/${esc(m.id)}">
    <div class="st ${st.kind}">${st.kind === 'live' ? '<span class="dot"></span>' : ''}${esc(st.label)}${meta}</div>
    <div class="tm home${cls(m.home, m.away)}"><span class="nm">${esc(m.home.name)}</span>${red(g.redHome)}${crest(m.home)}</div>
    <div>${score}${pens}</div>
    <div class="tm away${cls(m.away, m.home)}">${crest(m.away)}<span class="nm">${esc(m.away.name)}</span>${red(g.redAway)}</div>
    <span class="chev">${ICON.chevR}</span>${scorers}</a>`;
}

/* ---------------- scores view ---------------- */
function visibleGroups() {
  const map = dayMap(S.date);
  const q = S.q.trim().toLowerCase();
  const groups = [];
  orderedLeagues().forEach(lg => {
    const bucket = map.get(lg.id);
    if (!bucket) return;
    let events = bucket.events;
    if (S.filter === 'live') events = events.filter(m => statusOf(m).kind === 'live');
    else if (S.filter === 'upcoming') events = events.filter(m => statusOf(m).kind === 'pre');
    else if (S.filter === 'finished') events = events.filter(m => statusOf(m).kind === 'post');
    if (q) events = events.filter(m => (`${m.home.full} ${m.away.full}`).toLowerCase().includes(q));
    if (events.length) groups.push({ lg, events });
  });
  return groups;
}
function countsFor(date) {
  const map = dayMap(date);
  const per = {};
  let all = 0, live = 0, pre = 0, post = 0;
  map.forEach((bucket, id) => {
    let l = 0;
    bucket.events.forEach(m => {
      const k = statusOf(m).kind;
      all++;
      if (k === 'live') { live++; l++; } else if (k === 'pre') pre++; else if (k === 'post') post++;
    });
    per[id] = { total: bucket.events.length, live: l };
  });
  return { all, live, pre, post, per };
}
function renderScores() {
  paint($('#main'), `
    <section class="panel" id="datebar"></section>
    <div class="toolbar">
      <div><h1 class="page-title" id="dayTitle">Matches</h1><p class="page-sub" id="daySub"></p></div>
      <div class="chips" id="filters" role="tablist"></div>
    </div>
    <div id="list" class="groups"></div>`);
  renderDatebar(); renderScoresBody(); renderSidebar(); renderRail();
}
function renderDatebar() {
  const bar = $('#datebar');
  if (!bar) return;
  const today = startOfDay(new Date());
  const days = [];
  for (let i = -5; i <= 5; i++) days.push(addDays(S.date, i));
  paint(bar, `<div class="datebar">
    <button class="icon-btn" data-shift="-1" aria-label="Previous day">${ICON.chevL}</button>
    <div class="days">${days.map(d => {
      const diff = Math.round((d - today) / 86400000);
      const dow = diff === 0 ? 'Today' : diff === -1 ? 'Yest' : diff === 1 ? 'Tom' : d.toLocaleDateString([], { weekday: 'short' });
      return `<button class="day${ymd(d) === ymd(S.date) ? ' active' : ''}${diff === 0 ? ' today' : ''}" data-date="${ymd(d)}">
        <span class="dow">${esc(dow)}</span><span class="dnum">${d.getDate()}</span></button>`;
    }).join('')}</div>
    <button class="icon-btn" data-shift="1" aria-label="Next day">${ICON.chevR}</button>
    <button class="icon-btn" id="calBtn" aria-label="Pick a date">${ICON.cal}
      <input type="date" id="calInput" value="${ymd(S.date).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3')}" tabindex="-1"></button>
  </div>`);
  const active = bar.querySelector('.day.active');
  if (active) active.scrollIntoView({ block: 'nearest', inline: 'center' });
}
function groupHTML(g) {
  return `<header class="group-head">${lgLogo(g.lg.id)}
      <div class="t"><b>${esc(lgName(g.lg.id))}</b><span>${esc(g.lg.region)} · ${g.events.length} match${g.events.length === 1 ? '' : 'es'}</span></div>
      <a class="link" href="#/league/${esc(g.lg.id)}">League ${ICON.chevR}</a>
    </header>${g.events.map(m => matchRow(m)).join('')}`;
}
function paintGroups(container, groups) {
  const keep = new Set();
  groups.forEach((g, i) => {
    keep.add(g.lg.id);
    let node = container.querySelector(`section[data-lg="${g.lg.id}"]`);
    if (!node) { node = document.createElement('section'); node.className = 'group'; node.dataset.lg = g.lg.id; }
    paint(node, groupHTML(g));
    if (container.children[i] !== node) container.insertBefore(node, container.children[i] || null);
  });
  [...container.children].forEach(ch => { if (ch.dataset.lg && !keep.has(ch.dataset.lg)) ch.remove(); });
}
function renderScoresBody() {
  const list = $('#list');
  if (!list) return;
  const c = countsFor(S.date);
  const diff = Math.round((S.date - startOfDay(new Date())) / 86400000);
  const title = $('#dayTitle');
  if (title) title.textContent = diff === 0 ? "Today's matches" : diff === 1 ? "Tomorrow's matches" : diff === -1 ? "Yesterday's matches" : fmtDayLong(S.date);
  const sub = $('#daySub');
  if (sub) sub.textContent = S.loading && !c.all ? 'Loading fixtures…' : `${c.all} match${c.all === 1 ? '' : 'es'} · ${c.live} live · ${c.pre} to play · ${c.post} finished`;
  const filters = $('#filters');
  if (filters) paint(filters, [['all', 'All', c.all], ['live', 'Live', c.live], ['upcoming', 'Upcoming', c.pre], ['finished', 'Finished', c.post]]
    .map(([id, label, n]) => `<button class="chip${S.filter === id ? ' active' : ''}" data-filter="${id}" role="tab" aria-selected="${S.filter === id}">
      ${id === 'live' && n ? '<span class="dot"></span>' : ''}${label}<span class="n">${n}</span></button>`).join(''));

  const groups = visibleGroups();
  if (groups.length) {
    if (list.dataset.mode !== 'groups') { list.innerHTML = ''; list.dataset.mode = 'groups'; }
    paintGroups(list, groups);
    return;
  }
  if (list.dataset.mode !== 'state') { list.dataset.mode = 'state'; painted.delete(list); list.innerHTML = ''; }
  if (S.loading) {
    paint(list, `<div class="loading-line"></div>` + Array.from({ length: 3 }, () =>
      `<div class="panel skel section">${Array.from({ length: 4 }, () => '<div class="skel-row"></div>').join('')}</div>`).join(''));
    return;
  }
  const failed = [...dayMap(S.date).values()].filter(b => b.error).length >= LEAGUES.length;
  const filtered = S.filter !== 'all' || S.q;
  let heading, message;
  if (failed) { heading = 'Live data is unavailable'; message = 'The score feed did not respond. Check your connection and try again.'; }
  else if (filtered) { heading = 'Nothing matches this filter'; message = `No ${S.filter === 'all' ? '' : S.filter + ' '}matches${S.q ? ` for “${esc(S.q)}”` : ''} on ${esc(fmtDayLong(S.date))}.`; }
  else {
    heading = diff === 0 ? 'No matches today' : diff === 1 ? 'No matches tomorrow' : `No matches on ${esc(fmtDayShort(S.date))}`;
    message = 'None of the leagues we follow are playing. This is normal during international breaks and between matchdays.';
  }
  paint(list, `<div class="panel empty">
      <div class="empty-ic">${failed ? ICON.info : ICON.cal}</div>
      <h3>${heading}</h3><p>${message}</p>
      <div class="empty-actions">
        ${failed ? `<button class="btn" data-act="reload">${ICON.refresh} Try again</button>` : ''}
        ${filtered ? '<button class="btn ghost" data-act="clear">Clear filters</button>' : ''}
        <div id="nextHint"></div>
      </div></div>`);
  if (!failed) maybeShowNext();
}
async function nextMatchday(from) {
  const days = [];
  await Promise.all(orderedLeagues().slice(0, 8).map(async lg => {
    try {
      const data = await request(`${API}/${lg.id}/scoreboard`, { ttl: 900000 });
      absorbMeta(lg.id, data);
      (data.events || []).forEach(e => { const d = startOfDay(new Date(e.date)); if (d > from) days.push(d); });
    } catch (err) { /* ignore */ }
  }));
  days.sort((a, b) => a - b);
  return days[0] || null;
}
let nextToken = 0;
async function maybeShowNext() {
  const token = ++nextToken;
  const day = await nextMatchday(S.date);
  const host = $('#nextHint');
  if (token !== nextToken || !day || !host) return;
  paint(host, `<button class="btn" data-act="next-day" data-day="${ymd(day)}">${ICON.cal} Next matchday · ${esc(fmtDayShort(day))}</button>`);
}

/* ---------------- sidebar + rail ---------------- */
function renderSidebar() {
  const el = $('#sidebar');
  if (!el) return;
  el.className = 'sidebar panel';
  const c = countsFor(S.date);
  const activeLg = S.route.name === 'league' ? S.route.lg : null;
  paint(el, `${LS.favs.length ? `<div class="side-head"><span class="label">My clubs</span></div>
      <div class="lg-list">${LS.favs.map(f => `<a class="lg-item" href="#/team/${esc(f.lg)}/${esc(f.id)}">
        ${crest({ logo: f.logo, name: f.name }, 'lg-logo')}<span class="name">${esc(f.name)}</span></a>`).join('')}</div>` : ''}
    <div class="side-head"><span class="label">Competitions</span></div>
    <div class="lg-list">${orderedLeagues().map(lg => {
      const n = c.per[lg.id] || { total: 0, live: 0 };
      const pinned = S.pins.includes(lg.id);
      return `<a class="lg-item${activeLg === lg.id ? ' active' : ''}" href="#/league/${esc(lg.id)}">
        ${lgLogo(lg.id)}<span class="name">${esc(lg.name)}</span>
        ${n.live ? `<span class="count live">${n.live}</span>` : n.total ? `<span class="count">${n.total}</span>` : ''}
        <span class="pin${pinned ? ' on' : ''}" data-pin="${esc(lg.id)}" role="button" tabindex="0" aria-label="${pinned ? 'Unpin' : 'Pin'} ${esc(lg.name)}">${pinned ? ICON.starOn : ICON.star}</span>
      </a>`;
    }).join('')}</div>`);
}
function spotlightMatch() {
  const all = [];
  orderedLeagues().forEach(lg => { const b = dayMap(S.date).get(lg.id); if (b) all.push(...b.events); });
  return all.find(m => statusOf(m).kind === 'live') || all.find(m => statusOf(m).kind === 'pre') || all[0] || null;
}
function renderRail() {
  const el = $('#rail');
  if (!el) return;
  const m = spotlightMatch();
  const tableLg = S.pins[0] || 'eng.1';
  let html = '';
  if (m) {
    const st = statusOf(m);
    const played = st.kind === 'live' || st.kind === 'post';
    html += `<section class="panel spot">
      <div class="spot-bg" style="background:radial-gradient(380px 200px at 0% 0%, ${hexA(m.home.color, .26)}, transparent 68%),radial-gradient(380px 200px at 100% 0%, ${hexA(m.away.color, .26)}, transparent 68%)"></div>
      <div class="spot-label">${st.kind === 'live' ? '<span class="live-tag"><span class="dot"></span><span class="label" style="color:inherit">Live now</span></span>' : `<span class="label">${st.kind === 'pre' ? 'Up next' : 'Match of the day'}</span>`}</div>
      <div class="spot-lg">${esc(lgName(m.lg))}</div>
      <div class="spot-main">
        <div class="spot-team">${crest(m.home)}<span>${esc(m.home.name)}</span></div>
        <div class="spot-score"><b>${played ? `${esc(m.home.score || '0')}–${esc(m.away.score || '0')}` : esc(fmtTime(m.date))}</b>
          <small class="${st.kind === 'live' ? 'live' : ''}">${esc(st.kind === 'pre' ? (m.venue || 'Kick-off') : st.label)}</small></div>
        <div class="spot-team">${crest(m.away)}<span>${esc(m.away.name)}</span></div>
      </div>
      <a class="btn" href="#/match/${esc(m.lg)}/${esc(m.id)}">Match centre</a></section>`;
  }
  html += `<section class="panel" data-rail-table="${esc(tableLg)}">
    <div class="rail-head"><span class="label">${esc(lgName(tableLg))} table</span><a class="link" href="#/league/${esc(tableLg)}/table">Full table</a></div>
    <div class="note">Loading…</div></section>`;
  paint(el, html);
  fillMiniTable(tableLg);
}
async function fillMiniTable(lgId) {
  const host = $(`[data-rail-table="${lgId}"]`);
  if (!host) return;
  try {
    const data = await getStandings(lgId);
    const entries = (data.groups[0] && data.groups[0].entries) || [];
    if (!entries.length) throw new Error('empty');
    const body = host.querySelector('.note') || host.querySelector('.table-wrap');
    if (!body) return;
    body.outerHTML = `<div class="table-wrap"><table class="tbl mini">
      <thead><tr><th>#</th><th class="team">Team</th><th>P</th><th>GD</th><th>Pts</th></tr></thead>
      <tbody>${entries.slice(0, 8).map(e => `<tr data-href="#/team/${esc(lgId)}/${esc(e.id)}">
        <td><span class="pos"${e.note ? ` style="background:${esc(e.note.color)}22;color:${esc(e.note.color)}"` : ''}>${e.rank}</span></td>
        <td class="team"><div class="team-cell">${crest(e)}<span>${esc(e.short)}</span></div></td>
        <td>${esc(e.p)}</td><td>${esc(e.gd)}</td><td class="pts">${esc(e.pts)}</td></tr>`).join('')}</tbody></table></div>`;
  } catch (err) {
    const body = host.querySelector('.note');
    if (body) body.textContent = 'No table for this competition.';
  }
}

/* ---------------- standings ---------------- */
async function getStandings(lgId) {
  const data = await request(`${API2}/${lgId}/standings`, { ttl: 900000 });
  const kids = data.children && data.children.length ? data.children : (data.standings ? [{ name: data.name, standings: data.standings }] : []);
  const groups = kids.map(ch => ({
    name: ch.name || '',
    entries: ((ch.standings && ch.standings.entries) || []).map(en => {
      const st = {};
      (en.stats || []).forEach(s => { st[s.name] = s; });
      const v = k => (st[k] ? (st[k].displayValue != null ? st[k].displayValue : st[k].value) : '–');
      const team = en.team || {};
      return {
        id: team.id, name: team.displayName || '', short: team.shortDisplayName || team.displayName || '',
        abbr: team.abbreviation || '', logo: (team.logos && team.logos[0] && team.logos[0].href) || '',
        rank: Number((st.rank && st.rank.value) || 0),
        p: v('gamesPlayed'), w: v('wins'), d: v('ties'), l: v('losses'),
        gf: v('pointsFor'), ga: v('pointsAgainst'), gd: v('pointDifferential'), pts: v('points'), note: en.note || null,
      };
    }).sort((a, b) => a.rank - b.rank),
  })).filter(g => g.entries.length);
  return { name: data.name || '', groups };
}
function standingsTable(group, lgId, highlight = []) {
  return `${group.name ? `<div class="group-name">${esc(group.name)}</div>` : ''}
  <div class="table-wrap"><table class="tbl">
    <thead><tr><th>#</th><th class="team">Team</th><th>P</th><th>W</th><th>D</th><th>L</th><th>GF</th><th>GA</th><th>GD</th><th>Pts</th></tr></thead>
    <tbody>${group.entries.map(e => `<tr class="clickable ${highlight.map(String).includes(String(e.id)) ? 'hl' : ''}" data-href="#/team/${esc(lgId)}/${esc(e.id)}">
      <td><span class="pos"${e.note ? ` style="background:${esc(e.note.color)}22;color:${esc(e.note.color)}"` : ''}>${e.rank}</span></td>
      <td class="team"><div class="team-cell">${crest(e)}<span>${esc(e.name)}</span></div></td>
      <td>${esc(e.p)}</td><td>${esc(e.w)}</td><td>${esc(e.d)}</td><td>${esc(e.l)}</td>
      <td>${esc(e.gf)}</td><td>${esc(e.ga)}</td><td class="key">${esc(e.gd)}</td><td class="pts">${esc(e.pts)}</td>
    </tr>`).join('')}</tbody></table></div>`;
}
function standingsLegend(groups) {
  const seen = new Map();
  groups.forEach(g => g.entries.forEach(e => { if (e.note) seen.set(e.note.description, e.note.color); }));
  if (!seen.size) return '';
  return `<div class="legend">${[...seen].map(([d, c]) => `<span><i style="background:${esc(c)}"></i>${esc(d)}</span>`).join('')}</div>`;
}

/* ---------------- shared lookups ---------------- */
function seasonOf(lgId) {
  const m = S.lgMeta[lgId];
  return (m && m.season) || null;
}
async function ensureSeason(lgId) {
  let s = seasonOf(lgId);
  // refetch when the cached copy predates season start/end being stored,
  // otherwise returning visitors keep the old unbounded window
  if (s && s.year && s.start) return s;
  const sb = await request(`${API}/${lgId}/scoreboard`, { ttl: 900000 });
  absorbMeta(lgId, sb);
  return seasonOf(lgId);
}
async function getCoreTeam(lgId, year, teamId) {
  const key = `t|${teamId}`;
  if (LS.teams[key]) return LS.teams[key];
  const t = await request(`${CORE}/${lgId}/seasons/${year}/teams/${teamId}?lang=en`, { ttl: 86400000 });
  const out = { id: t.id, name: t.shortDisplayName || t.displayName, abbr: t.abbreviation || '', logo: (t.logos && t.logos[0] && t.logos[0].href) || '', color: t.color || '' };
  LS.teams[key] = out; persist();
  return out;
}
async function getPerson(lgId, year, athleteId) {
  const key = `p|${athleteId}`;
  if (LS.people[key]) return LS.people[key];
  const a = await request(`${CORE}/${lgId}/seasons/${year}/athletes/${athleteId}?lang=en`, { ttl: 86400000 });
  const out = {
    id: a.id, name: a.displayName || a.shortName || '', short: a.shortName || '',
    jersey: a.jersey || '', pos: (a.position && a.position.abbreviation) || '',
    posFull: (a.position && a.position.displayName) || '', flag: (a.flag && a.flag.href) || '',
    country: a.citizenship || '', age: a.age || null, height: a.displayHeight || '', weight: a.displayWeight || '',
  };
  LS.people[key] = out; persist();
  return out;
}

/* ---------------- league leaders ---------------- */
async function getLeadersRaw(lgId) {
  const season = await ensureSeason(lgId);
  if (!season || !season.year) throw new Error('no season');
  const data = await request(`${CORE}/${lgId}/seasons/${season.year}/types/${season.type || 1}/leaders?lang=en`, { ttl: 1800000 });
  const cat = names => (data.categories || []).find(c => names.includes(c.name));
  const take = c => (c ? (c.leaders || []).slice(0, 10) : []).map((l, i) => ({
    rank: i + 1,
    value: l.value != null ? Math.round(l.value) : '–',
    matches: (/Matches:\s*(\d+)/.exec(l.displayValue || '') || [])[1] || '–',
    athleteId: refId(l.athlete && l.athlete.$ref),
    teamId: refId(l.team && l.team.$ref),
  }));
  return { season, scorers: take(cat(['goalsLeaders', 'goals'])), assists: take(cat(['assistsLeaders', 'assists'])) };
}
function leaderTable(rows, label, lgId, resolved) {
  if (!rows.length) return `<div class="note">Not published for this competition.</div>`;
  return `<div class="table-wrap"><table class="tbl leaders-tbl">
    <thead><tr><th>#</th><th class="team">Player</th><th class="team">Club</th><th>MP</th><th>${esc(label)}</th></tr></thead>
    <tbody>${rows.map(r => {
      const p = resolved.people[r.athleteId];
      const t = resolved.teams[r.teamId];
      return `<tr class="clickable" data-href="#/player/${esc(lgId)}/${esc(r.athleteId || '')}">
        <td><span class="pos">${r.rank}</span></td>
        <td class="team"><div class="team-cell">
          ${avatar({ jersey: p && p.jersey, name: p && p.name, flag: p && p.flag }, 'sm')}
          <span>${p ? esc(p.name) : '<span class="ghost-text">Loading…</span>'}${p && p.pos ? `<small>${esc(p.pos)}</small>` : ''}</span>
        </div></td>
        <td class="team">${t ? `<div class="team-cell">${crest(t)}<span>${esc(t.name)}</span></div>` : '<span class="ghost-text">…</span>'}</td>
        <td>${esc(r.matches)}</td><td class="pts">${esc(r.value)}</td></tr>`;
    }).join('')}</tbody></table></div>`;
}

/* ---------------- league hub ---------------- */
function renderLeague(lgId, tab) {
  const lg = LG_BY_ID[lgId];
  if (!lg) { location.hash = '#/'; return; }
  S.leagueTab = tab || 'fixtures';
  const season = (seasonOf(lgId) || {}).label || '';
  const tabs = [['schedule', 'Schedule'], ['fixtures', 'Fixtures'], ['results', 'Results'], ['table', 'Table'], ['stats', 'Stats'], ['teams', 'Clubs'], ['news', 'News']];
  paint($('#main'), `
    <a class="back" href="#/">${ICON.chevL} All scores</a>
    <section class="panel lg-hero">
      <div class="lg-hero-bg" style="background:radial-gradient(520px 200px at 0% 0%, rgba(61,220,132,.10), transparent 70%)"></div>
      ${lgLogo(lgId, 'big')}
      <div class="t"><h1>${esc(lgName(lgId))}</h1><p>${esc(lg.region)}${season ? ' · ' + esc(season) : ''}</p></div>
    </section>
    <nav class="tabs" role="tablist">${tabs.map(([id, label]) =>
      `<a class="tab${S.leagueTab === id ? ' active' : ''}" href="#/league/${esc(lgId)}/${id}" role="tab" aria-selected="${S.leagueTab === id}">${label}</a>`).join('')}</nav>
    <div id="lgBody"></div>`);
  $('#rail').innerHTML = '';
  renderSidebar();
  const body = $('#lgBody');
  if (S.leagueTab === 'table') return fillLeagueTable(lgId, body);
  if (S.leagueTab === 'stats') return fillLeagueStats(lgId, body);
  if (S.leagueTab === 'teams') return fillLeagueTeams(lgId, body);
  if (S.leagueTab === 'news') return fillLeagueNews(lgId, body);
  if (S.leagueTab === 'schedule') return fillLeagueSchedule(lgId, body);
  return fillLeagueMatches(lgId, body, S.leagueTab);
}
/* Whole season on one page: everything played and everything still to come. */
async function fillLeagueSchedule(lgId, body) {
  paint(body, `<div class="panel skel section">${Array.from({ length: 8 }, () => '<div class="skel-row"></div>').join('')}</div>`);
  // A 13-month window straddles two seasons and inflates the count (424 for a
  // 380-match league), so use the season window the feed itself reports.
  const season = await ensureSeason(lgId).catch(() => null);
  const now = new Date();
  const start = season && season.start ? new Date(season.start) : addMonths(now, -8);
  const end = season && season.end ? new Date(season.end) : addMonths(now, 4);
  const months = [];
  for (let cur = new Date(start.getFullYear(), start.getMonth(), 1); cur <= end && months.length < 15; cur = addMonths(cur, 1)) {
    months.push(new Date(cur));
  }
  const all = new Map();
  await Promise.all(months.map(async m => {
    try {
      (await loadMonth(lgId, m)).forEach(e => {
        const d = new Date(e.date);
        if (d >= start && d <= end) all.set(e.id, e);
      });
    } catch (err) { /* empty month */ }
  }));
  if (S.route.name !== 'league' || S.route.lg !== lgId) return;
  const events = [...all.values()].sort((a, b) => new Date(a.date) - new Date(b.date));
  if (!events.length) {
    paint(body, `<section class="panel empty"><div class="empty-ic">${ICON.cal}</div>
      <h3>No schedule published</h3><p>This competition has no fixtures in the feed yet.</p></section>`);
    return;
  }
  const played = events.filter(e => statusOf(e).kind === 'post');
  const upcoming = events.filter(e => statusOf(e).kind !== 'post');
  const filter = S.scheduleFilter || 'all';
  const shown = filter === 'played' ? played : filter === 'upcoming' ? upcoming : events;

  const byDay = new Map();
  shown.forEach(e => {
    const k = ymd(new Date(e.date));
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(e);
  });
  const todayKey = ymd(new Date());
  let anchored = false;

  paint(body, `
    <section class="panel section sched-head">
      <div class="card-title"><span class="label">${esc((season && season.label) || 'Full season')}</span>
        <span class="label">${events.length} matches · ${played.length} played · ${upcoming.length} to play</span></div>
      <div class="chips sched-chips">
        ${[['all', 'Everything', events.length], ['played', 'Played', played.length], ['upcoming', 'To come', upcoming.length]]
          .map(([id, label, n]) => `<button class="chip${filter === id ? ' active' : ''}" data-sched="${id}">${label}<span class="n">${n}</span></button>`).join('')}
        ${upcoming.length ? '<button class="chip" data-sched-jump="1">Jump to next</button>' : ''}
      </div>
    </section>
    ${[...byDay.entries()].map(([k, ms]) => {
      const future = k >= todayKey;
      const anchor = (!anchored && future) ? (anchored = true, ' id="nextFixture"') : '';
      return `<section class="group section"${anchor}>
        <div class="day-head${k === todayKey ? ' today' : ''}">${esc(fmtDayLong(parseYmd(k)))}${k === todayKey ? ' <span class="today-tag">Today</span>' : ''}</div>
        ${ms.map(m => matchRow(m)).join('')}</section>`;
    }).join('')}`);
}

async function fillLeagueNews(lgId, body) {
  paint(body, `<section class="panel"><div class="note">Loading news…</div></section>`);
  try {
    const data = await request(`${API}/${lgId}/news?limit=12`, { ttl: 600000 });
    const html = articlesHTML(data.articles, `Latest ${lgName(lgId)} news`);
    if (S.route.name !== 'league' || S.route.lg !== lgId) return;
    paint(body, html || `<section class="panel empty"><div class="empty-ic">${ICON.info}</div>
      <h3>No news right now</h3><p>Nothing has been published for this competition today.</p></section>`);
  } catch (err) {
    paint(body, `<section class="panel empty"><div class="empty-ic">${ICON.info}</div>
      <h3>News unavailable</h3><p>The news feed did not respond.</p></section>`);
  }
}
async function fillLeagueTable(lgId, body) {
  paint(body, `<section class="panel"><div class="note">Loading table…</div></section>`);
  try {
    const data = await getStandings(lgId);
    if (!data.groups.length) throw new Error('empty');
    paint(body, `<section class="panel">${data.groups.map(g => standingsTable(g, lgId)).join('')}${standingsLegend(data.groups)}</section>`);
  } catch (err) {
    paint(body, `<section class="panel empty"><div class="empty-ic">${ICON.list}</div>
      <h3>No table for this competition</h3><p>Knockout rounds and cups do not publish a league table.</p></section>`);
  }
}
async function fillLeagueStats(lgId, body) {
  const skeleton = `<div class="grid2">
    ${['Top scorers', 'Most assists'].map(t => `<section class="panel"><div class="card-title"><span class="label">${t}</span></div>
      ${Array.from({ length: 6 }, () => '<div class="skel-row"></div>').join('')}</section>`).join('')}</div>`;
  paint(body, skeleton);
  let raw;
  try { raw = await getLeadersRaw(lgId); } catch (err) {
    paint(body, `<section class="panel empty"><div class="empty-ic">${ICON.chart}</div>
      <h3>Player stats are not published yet</h3>
      <p>This competition has not released season scoring charts. They appear once a few matchdays have been played.</p></section>`);
    return;
  }
  const resolved = { people: {}, teams: {} };
  const draw = () => {
    if (S.route.name !== 'league' || S.route.lg !== lgId || S.leagueTab !== 'stats') return;
    paint(body, `<div class="grid2">
      <section class="panel"><div class="card-title"><span class="label">Top scorers</span><span class="label">Goals</span></div>${leaderTable(raw.scorers, 'G', lgId, resolved)}</section>
      <section class="panel"><div class="card-title"><span class="label">Most assists</span><span class="label">Assists</span></div>${leaderTable(raw.assists, 'A', lgId, resolved)}</section>
    </div>`);
  };
  // paint ranks and totals immediately, then fill names/clubs as they resolve
  const all = [...raw.scorers, ...raw.assists];
  [...new Set(all.map(r => r.athleteId).filter(Boolean))].forEach(id => { if (LS.people[`p|${id}`]) resolved.people[id] = LS.people[`p|${id}`]; });
  [...new Set(all.map(r => r.teamId).filter(Boolean))].forEach(id => { if (LS.teams[`t|${id}`]) resolved.teams[id] = LS.teams[`t|${id}`]; });
  draw();
  const year = raw.season.year;
  await Promise.all([
    ...[...new Set(all.map(r => r.athleteId).filter(id => id && !resolved.people[id]))].map(async id => {
      try { resolved.people[id] = await getPerson(lgId, year, id); } catch (e) {}
    }),
    ...[...new Set(all.map(r => r.teamId).filter(id => id && !resolved.teams[id]))].map(async id => {
      try { resolved.teams[id] = await getCoreTeam(lgId, year, id); } catch (e) {}
    }),
  ]);
  draw();
  await fetchPhotos(Object.keys(resolved.people).map(id => resolved.people[id] && resolved.people[id].name));
  draw();
}
async function fillLeagueTeams(lgId, body) {
  paint(body, `<section class="panel"><div class="note">Loading clubs…</div></section>`);
  try {
    const data = await request(`${API}/${lgId}/teams`, { ttl: 86400000 });
    const teams = ((((data.sports || [])[0] || {}).leagues || [])[0] || {}).teams || [];
    if (!teams.length) throw new Error('empty');
    paint(body, `<section class="panel"><div class="card-title"><span class="label">${teams.length} clubs</span></div>
      <div class="club-grid">${teams.map(({ team: t }) => `<a class="club" href="#/team/${esc(lgId)}/${esc(t.id)}">
        ${crest({ logo: (t.logos && t.logos[0] && t.logos[0].href) || '', name: t.displayName, abbr: t.abbreviation }, 'crest lg')}
        <span class="club-nm">${esc(t.shortDisplayName || t.displayName)}</span></a>`).join('')}</div></section>`);
  } catch (err) {
    paint(body, `<section class="panel empty"><div class="empty-ic">${ICON.shirt}</div>
      <h3>Club list unavailable</h3><p>This competition does not publish a club directory — open a match to reach a club page.</p></section>`);
  }
}
async function fillLeagueMatches(lgId, body, mode) {
  const base = addMonths(new Date(), S.monthOffset);
  const label = base.toLocaleDateString([], { month: 'long', year: 'numeric' });
  paint(body, `<section class="panel section"><div class="month-nav">
      <button class="icon-btn" data-month="-1" aria-label="Previous month">${ICON.chevL}</button>
      <b>${esc(label)}</b>
      <button class="icon-btn" data-month="1" aria-label="Next month">${ICON.chevR}</button>
    </div></section>
    <div id="lgMatches"><div class="panel skel section">${Array.from({ length: 5 }, () => '<div class="skel-row"></div>').join('')}</div></div>`);
  const host = $('#lgMatches');
  let events;
  try { events = await loadMonth(lgId, base); } catch (err) {
    paint(host, `<section class="panel empty"><div class="empty-ic">${ICON.info}</div>
      <h3>Could not load fixtures</h3><p>The fixture feed did not respond.</p>
      <div class="empty-actions"><button class="btn" data-act="reload-month">${ICON.refresh} Try again</button></div></section>`);
    return;
  }
  const list = mode === 'results'
    ? events.filter(m => statusOf(m).kind === 'post').reverse()
    : events.filter(m => statusOf(m).kind !== 'post');
  if (!list.length) {
    paint(host, `<section class="panel empty"><div class="empty-ic">${ICON.cal}</div>
      <h3>No ${mode === 'results' ? 'results' : 'fixtures'} in ${esc(label)}</h3>
      <p>Use the arrows above to browse another month.</p></section>`);
    return;
  }
  const byDay = new Map();
  list.forEach(m => { const k = ymd(new Date(m.date)); if (!byDay.has(k)) byDay.set(k, []); byDay.get(k).push(m); });
  paint(host, [...byDay.entries()].map(([k, ms]) => `<section class="group section">
    <div class="day-head">${esc(fmtDayLong(parseYmd(k)))}</div>${ms.map(m => matchRow(m)).join('')}</section>`).join(''));
}

/* ---------------- team page ---------------- */
async function renderTeam(lgId, teamId) {
  paint($('#main'), `<a class="back" href="#/league/${esc(lgId)}">${ICON.chevL} ${esc(lgName(lgId))}</a>
    <div class="panel skel">${Array.from({ length: 6 }, () => '<div class="skel-row"></div>').join('')}</div>`);
  $('#rail').innerHTML = '';
  renderSidebar();
  let team;
  try {
    const data = await request(`${API}/${lgId}/teams/${teamId}`, { ttl: 900000 });
    team = data.team;
  } catch (err) {
    paint($('#main'), `<a class="back" href="#/">${ICON.chevL} Back</a>
      <div class="panel empty"><div class="empty-ic">${ICON.info}</div><h3>Club unavailable</h3>
      <p>We couldn't load this club right now.</p></div>`);
    return;
  }
  const rec = ((team.record && team.record.items) || []).find(i => i.type === 'total');
  const next = (team.nextEvent || [])[0];
  // ESPN labels fixtures American-style ("RMA @ ATM" = Real Madrid away at
  // Atlético). Rebuild it the football way: home side first, joined by "v".
  const nextCs = next ? (((next.competitions || [])[0] || {}).competitors || []) : [];
  const nHome = nextCs.length ? normTeam(nextCs.find(x => x.homeAway === 'home') || nextCs[0]) : null;
  const nAway = nextCs.length ? normTeam(nextCs.find(x => x.homeAway === 'away') || nextCs[1]) : null;
  const atHome = nHome && String(nHome.id) === String(teamId);
  const logo = (team.logos && team.logos[0] && team.logos[0].href) || '';
  const t = { id: team.id, name: team.shortDisplayName || team.displayName, full: team.displayName, abbr: team.abbreviation, logo, color: team.color };
  const tabs = [['overview', 'Overview'], ['squad', 'Squad'], ['fixtures', 'Fixtures'], ['results', 'Results'], ['standings', 'Standings']];

  paint($('#main'), `
    <a class="back" href="#/league/${esc(lgId)}">${ICON.chevL} ${esc(lgName(lgId))}</a>
    <section class="panel team-hero">
      <div class="hero-bg" style="background:radial-gradient(560px 240px at 0% 0%, ${hexA(team.color, .30)}, transparent 68%)"></div>
      ${crest(t, 'crest xl')}
      <div class="t">
        <h1>${esc(team.displayName)}</h1>
        <p>${esc(team.standingSummary || lgName(lgId))}${rec ? ` · ${esc(rec.summary)} (W-D-L)` : ''}</p>
      </div>
      <button class="fav-btn${LS.favs.some(f => String(f.id) === String(teamId)) ? ' on' : ''}" data-fav="${esc(teamId)}"
        data-lg="${esc(lgId)}" data-name="${esc(t.name)}" data-logo="${esc(logo)}"
        aria-label="${LS.favs.some(f => String(f.id) === String(teamId)) ? 'Unfollow' : 'Follow'} ${esc(t.name)}">
        ${LS.favs.some(f => String(f.id) === String(teamId)) ? ICON.heartOn : ICON.heart}
        <span>${LS.favs.some(f => String(f.id) === String(teamId)) ? 'Following' : 'Follow'}</span></button>
      ${next ? `<a class="next-card" href="#/match/${esc(lgId)}/${esc(next.id)}">
        <span class="label">Next match</span>
        ${nHome && nAway ? `<span class="nx-teams">
            ${crest(nHome)}<b>${esc(nHome.name)}</b><span class="nx-v">v</span><b>${esc(nAway.name)}</b>${crest(nAway)}
          </span>` : `<b>${esc(next.name || '')}</b>`}
        <span class="nx-meta">${esc(fmtDayShort(new Date(next.date)))} · ${esc(fmtTime(next.date))}${nHome ? ` · ${atHome ? 'Home' : 'Away'}` : ''}</span></a>` : ''}
    </section>
    <nav class="tabs" role="tablist">${tabs.map(([id, label]) =>
      `<a class="tab${S.teamTab === id ? ' active' : ''}" href="#/team/${esc(lgId)}/${esc(teamId)}/${id}" role="tab" aria-selected="${S.teamTab === id}">${label}</a>`).join('')}</nav>
    <div id="teamBody"></div>`);

  const body = $('#teamBody');
  if (S.teamTab === 'squad') return fillSquad(lgId, teamId, body);
  if (S.teamTab === 'standings') return fillTeamStandings(lgId, teamId, body);
  if (S.teamTab === 'fixtures' || S.teamTab === 'results') return fillTeamMatches(lgId, teamId, body, S.teamTab);
  return fillTeamOverview(lgId, teamId, body, t);
}

function teamCompetitions(lgId) {
  return [lgId, ...UEFA.filter(u => u !== lgId)];
}
async function teamMatches(lgId, teamId, monthsBack, monthsForward) {
  const comps = teamCompetitions(lgId);
  const months = [];
  for (let i = -monthsBack; i <= monthsForward; i++) months.push(addMonths(new Date(), i));
  const out = [];
  await Promise.all(comps.map(async comp => {
    await Promise.all(months.map(async mth => {
      try {
        const events = await loadMonth(comp, mth);
        events.forEach(e => {
          if (String(e.home.id) === String(teamId) || String(e.away.id) === String(teamId)) out.push(e);
        });
      } catch (err) { /* competition may not run this month */ }
    }));
  }));
  const seen = new Set();
  return out.filter(e => (seen.has(e.id) ? false : seen.add(e.id))).sort((a, b) => new Date(a.date) - new Date(b.date));
}

async function fillTeamOverview(lgId, teamId, body, t) {
  paint(body, `<div class="grid2">
    <section class="panel"><div class="card-title"><span class="label">Recent form</span></div><div class="note">Loading…</div></section>
    <section class="panel"><div class="card-title"><span class="label">Next fixtures</span></div><div class="note">Loading…</div></section>
  </div>`);
  const [matches, positions] = await Promise.all([
    teamMatches(lgId, teamId, 2, 2).catch(() => []),
    teamPositions(lgId, teamId).catch(() => []),
  ]);
  if (S.route.name !== 'team' || S.route.id !== teamId) return;
  const now = new Date();
  const played = matches.filter(m => statusOf(m).kind === 'post');
  const last5 = played.slice(-5).reverse();
  const nextUp = matches.filter(m => statusOf(m).kind !== 'post').slice(0, 5);
  const resultOf = m => {
    const us = String(m.home.id) === String(teamId) ? m.home : m.away;
    const them = us === m.home ? m.away : m.home;
    const a = +us.score, b = +them.score;
    return a > b ? 'W' : a < b ? 'L' : 'D';
  };
  paint(body, `<div class="grid2">
    <section class="panel">
      <div class="card-title"><span class="label">Recent form</span>
        <span class="form-row">${last5.slice().reverse().map(m => `<i class="${resultOf(m)}">${resultOf(m)}</i>`).join('')}</span></div>
      ${last5.length ? last5.map(m => matchRow(m, { compact: true, showDate: true })).join('') : '<div class="note">No matches played yet.</div>'}
    </section>
    <section class="panel">
      <div class="card-title"><span class="label">Next fixtures</span></div>
      ${nextUp.length ? nextUp.map(m => matchRow(m, { compact: true, showDate: true })).join('') : '<div class="note">No scheduled fixtures found.</div>'}
    </section>
  </div>
  <section class="panel section"><div class="card-title"><span class="label">Position in every competition</span></div>
    ${positions.length ? `<div class="pos-list">${positions.map(p => {
        // standings groups are often just the league name again ("2026-27 Premier League")
        const base = lgName(p.lg);
        const group = p.group && !p.group.includes(base) && !base.includes(p.group) ? p.group : '';
        return `<a class="pos-item" href="#/league/${esc(p.lg)}/table">
          ${lgLogo(p.lg)}
          <span class="nm">${esc(base)}${group ? `<small>${esc(group)}</small>` : ''}</span>
          <span class="played">${esc(p.p)} played</span>
          <span class="rank">${esc(p.rank)}<sup>${esc(ordinal(p.rank))}</sup></span>
          <span class="pts">${esc(p.pts)} pts</span></a>`;
      }).join('')}</div>`
      : '<div class="note">No league table includes this club right now.</div>'}
  </section>
  <section class="panel section" id="clubScorers"></section>
  <section class="panel section" id="clubInfo"></section>`);
  fillClubInfo(lgId, teamId, t);
  fillClubScorers(lgId, teamId);
}

/* club's own scoring charts */
async function fillClubScorers(lgId, teamId) {
  const host = $('#clubScorers');
  if (!host) return;
  try {
    const season = await ensureSeason(lgId);
    const data = await request(`${CORE}/${lgId}/seasons/${season.year}/types/${season.type || 1}/teams/${teamId}/leaders?lang=en`, { ttl: 1800000 });
    const cat = names => (data.categories || []).find(c => names.includes(c.name));
    const take = c => (c ? (c.leaders || []).slice(0, 5) : []).map(l => ({
      id: refId(l.athlete && l.athlete.$ref),
      value: l.value != null ? Math.round(l.value) : 0,
      matches: (/Matches:\s*(\d+)/.exec(l.displayValue || '') || [])[1] || '–',
    })).filter(r => r.value > 0);
    const goals = take(cat(['goalsLeaders', 'goals']));
    const assists = take(cat(['assistsLeaders', 'assists']));
    if (!goals.length && !assists.length) { host.remove(); return; }
    const people = {};
    await Promise.all([...goals, ...assists].map(async r => {
      if (!r.id || people[r.id]) return;
      try { people[r.id] = await getPerson(lgId, season.year, r.id); } catch (e) {}
    }));
    await fetchPhotos(Object.keys(people).map(k => people[k] && people[k].name));
    if (!host.isConnected || (S.route.name === 'team' && S.route.id !== teamId)) return;
    const col = (rows, label) => rows.length ? `<div>
      <div class="card-title"><span class="label">${label}</span></div>
      ${rows.map(r => {
        const p = people[r.id];
        return `<a class="scorer" href="#/player/${esc(lgId)}/${esc(r.id || '')}">
          ${avatar({ jersey: p && p.jersey, name: p && p.name, flag: p && p.flag }, 'sm')}
          <span class="sc-n">${p ? esc(p.name) : 'Player'}</span>
          <span class="sc-m">${esc(r.matches)} apps</span>
          <b>${r.value}</b></a>`;
      }).join('')}</div>` : '';
    paint(host, `<div class="bench">${col(goals, 'Top scorers')}${col(assists, 'Most assists')}</div>`);
  } catch (err) {
    host.remove();
  }
}

async function fillClubInfo(lgId, teamId, t) {
  const host = $('#clubInfo');
  if (!host) return;
  const [detail, wiki] = await Promise.all([
    getClubDetail(lgId, teamId).catch(() => null),
    clubSummary((t && t.full) || (t && t.name) || '').catch(() => null),
  ]);
  if (!host.isConnected || (S.route.name === 'team' && S.route.id !== teamId)) return;
  if (!detail && !(wiki && wiki.extract)) { host.remove(); return; }
  const facts = [
    detail && detail.venue ? ['Stadium', esc(detail.venue)] : null,
    detail && detail.city ? ['Location', esc([detail.city, detail.country].filter(Boolean).join(', '))] : null,
    detail && detail.nickname ? ['Nickname', esc(detail.nickname)] : null,
    ['Competition', esc(lgName(lgId))],
    detail && detail.color ? ['Colours', `<span class="swatch" style="background:#${esc(detail.color)}"></span>${detail.alt ? `<span class="swatch" style="background:#${esc(detail.alt)}"></span>` : ''}`] : null,
  ].filter(Boolean);
  paint(host, `<div class="card-title"><span class="label">Club information</span></div>
    <div class="info-grid">${facts.map(([k, v]) => `<div><i>${k}</i><b>${v}</b></div>`).join('')}</div>
    ${wiki && wiki.extract ? `<p class="club-extract">${esc(wiki.extract)}</p>` : ''}`);
}
const ordinal = n => { const s = ['th', 'st', 'nd', 'rd'], v = Number(n) % 100; return (s[(v - 20) % 10] || s[v] || s[0]); };

async function teamPositions(lgId, teamId) {
  const comps = teamCompetitions(lgId);
  const out = [];
  await Promise.all(comps.map(async comp => {
    try {
      const data = await getStandings(comp);
      data.groups.forEach(g => {
        const hit = g.entries.find(e => String(e.id) === String(teamId));
        if (hit) out.push({ lg: comp, group: g.name, rank: hit.rank, pts: hit.pts, p: hit.p });
      });
    } catch (err) { /* no table */ }
  }));
  return out;
}
async function fillTeamStandings(lgId, teamId, body) {
  paint(body, `<section class="panel"><div class="note">Loading tables…</div></section>`);
  const comps = teamCompetitions(lgId);
  const blocks = [];
  for (const comp of comps) {
    try {
      const data = await getStandings(comp);
      data.groups.forEach(g => {
        if (!g.entries.some(e => String(e.id) === String(teamId))) return;
        blocks.push(`<section class="panel section"><div class="card-title"><span class="label">${esc(lgName(comp))}</span>
          <a class="link" href="#/league/${esc(comp)}/table">Full table</a></div>
          ${standingsTable(g, comp, [teamId])}${standingsLegend([g])}</section>`);
      });
    } catch (err) { /* skip */ }
  }
  if (S.route.name !== 'team' || S.route.id !== teamId) return;
  paint(body, blocks.length ? blocks.join('') : `<section class="panel empty"><div class="empty-ic">${ICON.list}</div>
    <h3>No tables available</h3><p>This club is not in a competition that publishes a table right now.</p></section>`);
}
async function fillTeamMatches(lgId, teamId, body, mode) {
  paint(body, `<div class="panel skel section">${Array.from({ length: 5 }, () => '<div class="skel-row"></div>').join('')}</div>`);
  const matches = await teamMatches(lgId, teamId, mode === 'results' ? 4 : 1, mode === 'results' ? 0 : 4).catch(() => []);
  if (S.route.name !== 'team' || S.route.id !== teamId) return;
  const list = mode === 'results'
    ? matches.filter(m => statusOf(m).kind === 'post').reverse()
    : matches.filter(m => statusOf(m).kind !== 'post');
  if (!list.length) {
    paint(body, `<section class="panel empty"><div class="empty-ic">${ICON.cal}</div>
      <h3>No ${mode} found</h3><p>Nothing scheduled in the months we searched.</p></section>`);
    return;
  }
  const byComp = new Map();
  list.forEach(m => { if (!byComp.has(m.lg)) byComp.set(m.lg, []); byComp.get(m.lg).push(m); });
  paint(body, [...byComp.entries()].map(([comp, ms]) => `<section class="group section">
    <header class="group-head">${lgLogo(comp)}<div class="t"><b>${esc(lgName(comp))}</b><span>${ms.length} match${ms.length === 1 ? '' : 'es'}</span></div></header>
    ${ms.map(m => matchRow(m, { showDate: true })).join('')}</section>`).join(''));
}
async function fillSquad(lgId, teamId, body) {
  paint(body, `<section class="panel"><div class="note">Loading squad…</div></section>`);
  let data;
  try { data = await request(`${API}/${lgId}/teams/${teamId}/roster`, { ttl: 86400000 }); } catch (err) {
    paint(body, `<section class="panel empty"><div class="empty-ic">${ICON.shirt}</div>
      <h3>Squad unavailable</h3><p>This club does not publish a squad list in the feed.</p></section>`);
    return;
  }
  if (S.route.name !== 'team' || S.route.id !== teamId) return;
  const players = (data.athletes || []).map(a => (a.items ? a.items : [a])).flat();
  if (!players.length) {
    paint(body, `<section class="panel empty"><div class="empty-ic">${ICON.shirt}</div><h3>Squad unavailable</h3>
      <p>No squad list published for this club.</p></section>`);
    return;
  }
  const groupOf = p => {
    const a = ((p.position && p.position.abbreviation) || '').toUpperCase();
    return a === 'G' || a === 'GK' ? 'Goalkeepers' : /^(D|CB|CD|LB|RB|SW|WB|LWB|RWB)/.test(a) ? 'Defenders'
      : /^(M|CM|DM|AM|LM|RM|CDM|CAM)/.test(a) ? 'Midfielders' : 'Forwards';
  };
  const order = ['Goalkeepers', 'Defenders', 'Midfielders', 'Forwards'];
  const grouped = new Map(order.map(o => [o, []]));
  players.forEach(p => grouped.get(groupOf(p)).push(p));
  const coach = (data.coach && data.coach[0]) || null;
  const coachName = coach ? `${coach.firstName || ''} ${coach.lastName || ''}`.trim() : '';
  const draw = () => {
    if (S.route.name !== 'team' || S.route.id !== teamId) return;
    paint(body, `${order.filter(o => grouped.get(o).length).map(o => `<section class="panel section">
      <div class="card-title"><span class="label">${o}</span><span class="label">${grouped.get(o).length}</span></div>
      <div class="squad">${grouped.get(o).map(p => {
        const flag = (p.flag && p.flag.href) || '';
        // the group header already says the position, so the second line
        // carries what it doesn't: exact role, nationality, age
        const meta = [(p.position && p.position.abbreviation) || '', countryCode(flag), p.age ? `${p.age} yrs` : '']
          .filter(Boolean).join(' · ');
        return `<a class="squad-row" href="#/player/${esc(lgId)}/${esc(p.id)}">
          ${avatar({ jersey: p.jersey, name: p.displayName, flag })}
          <span class="sq-nm"><b>${esc(p.displayName)}</b><small>${esc(meta)}</small></span>
          <span class="chev">${ICON.chevR}</span></a>`;
      }).join('')}</div>
    </section>`).join('')}
    ${coach ? `<section class="panel section"><div class="card-title"><span class="label">Head coach</span></div>
      <div class="squad"><div class="squad-row">${avatar({ name: coachName })}
        <span class="sq-nm"><b>${esc(coachName)}</b><small>Manager</small></span></div></div></section>` : ''}`);
  };
  draw();
  await fetchPhotos([...players.map(p => p.displayName), coachName]);
  draw();
}

/* ---------------- player page ---------------- */
async function renderPlayer(lgId, athleteId) {
  paint($('#main'), `<a class="back" href="#/league/${esc(lgId)}/stats">${ICON.chevL} Back</a>
    <div class="panel skel">${Array.from({ length: 5 }, () => '<div class="skel-row"></div>').join('')}</div>`);
  $('#rail').innerHTML = '';
  renderSidebar();
  const season = await ensureSeason(lgId).catch(() => null);
  if (!season) { paint($('#main'), `<div class="panel empty"><div class="empty-ic">${ICON.info}</div><h3>Player unavailable</h3></div>`); return; }

  let person = null, profile = null;
  try { person = await getPerson(lgId, season.year, athleteId); } catch (e) {}
  try { profile = await request(`${WEB}/${lgId}/athletes/${athleteId}`, { ttl: 86400000 }); } catch (e) {}
  const ath = (profile && profile.athlete) || {};
  const teamName = ath.team && (ath.team.displayName || ath.team.name);
  const teamId = ath.team && ath.team.id;
  const name = (person && person.name) || ath.displayName || 'Player';
  await fetchPhotos([name]);

  let stats = null;
  try {
    const raw = await request(`${CORE}/${lgId}/seasons/${season.year}/types/${season.type || 1}/athletes/${athleteId}/statistics/0?lang=en`, { ttl: 900000 });
    stats = {};
    ((raw.splits && raw.splits.categories) || []).forEach(c => (c.stats || []).forEach(s => { stats[s.name] = s.displayValue; }));
  } catch (e) {}

  const KEY = [['appearances', 'Appearances'], ['totalGoals', 'Goals'], ['goalAssists', 'Assists'], ['minutes', 'Minutes'],
    ['totalShots', 'Shots'], ['shotsOnTarget', 'On target'], ['yellowCards', 'Yellow'], ['redCards', 'Red'],
    ['saves', 'Saves'], ['foulsCommitted', 'Fouls']];
  const cards = stats ? KEY.filter(([k]) => stats[k] != null && stats[k] !== '0' || k === 'appearances' || k === 'totalGoals' || k === 'goalAssists') : [];

  paint($('#main'), `
    <a class="back" href="${teamId ? `#/team/${esc(lgId)}/${esc(teamId)}/squad` : `#/league/${esc(lgId)}/stats`}">${ICON.chevL} ${esc(teamName || 'Back')}</a>
    <section class="panel player-hero">
      <div class="hero-bg" style="background:radial-gradient(520px 220px at 0% 0%, rgba(61,220,132,.12), transparent 70%)"></div>
      ${avatar({ jersey: (person && person.jersey) || ath.jersey, name, flag: (person && person.flag) || (ath.flag && ath.flag.href) }, 'xl')}
      <div class="t">
        <h1>${esc(name)}</h1>
        <p>${esc([(person && person.posFull) || (ath.position && ath.position.displayName), teamName, (person && person.country) || ath.citizenship].filter(Boolean).join(' · '))}</p>
        <div class="kv">
          ${(person && person.jersey) ? `<span><i>Shirt</i>${esc(person.jersey)}</span>` : ''}
          ${(person && person.age) || ath.age ? `<span><i>Age</i>${esc((person && person.age) || ath.age)}</span>` : ''}
          ${(person && person.height) ? `<span><i>Height</i>${esc(person.height)}</span>` : ''}
          ${teamId ? `<a class="link" href="#/team/${esc(lgId)}/${esc(teamId)}">Club page ${ICON.chevR}</a>` : ''}
        </div>
      </div>
    </section>
    ${cards.length ? `<section class="panel section"><div class="card-title"><span class="label">${esc(season.label || 'Season')} · ${esc(lgName(lgId))}</span></div>
      <div class="stat-cards">${cards.map(([k, label]) => `<div class="stat-card"><b>${esc(stats[k] != null ? stats[k] : '–')}</b><span>${label}</span></div>`).join('')}</div></section>`
      : `<section class="panel"><div class="note">No season statistics published for this player yet.</div></section>`}
    <section class="panel section" id="playerLog"><div class="card-title"><span class="label">Recent matches</span></div><div class="note">Loading…</div></section>
    <p class="fine">Player photographs are not available in this data source, so shirt numbers and national flags are shown instead.</p>`);

  fillPlayerLog(lgId, athleteId, season);
}
async function fillPlayerLog(lgId, athleteId, season) {
  const host = $('#playerLog');
  if (!host) return;
  try {
    const log = await request(`${CORE}/${lgId}/seasons/${season.year}/athletes/${athleteId}/eventlog?lang=en`, { ttl: 900000 });
    const items = ((log.events && log.events.items) || []).filter(i => i.played).slice(-5).reverse();
    if (!items.length) throw new Error('empty');
    const rows = await Promise.all(items.map(async it => {
      const eventId = refId(it.event && it.event.$ref);
      let label = 'Match', date = '', score = '';
      try {
        const sum = await request(`${API}/${lgId}/summary?event=${eventId}`, { ttl: 900000 });
        const comp = (sum.header && sum.header.competitions && sum.header.competitions[0]) || {};
        const cs = comp.competitors || [];
        const h = normTeam(cs.find(c => c.homeAway === 'home') || cs[0]);
        const a = normTeam(cs.find(c => c.homeAway === 'away') || cs[1]);
        label = `${h.name} v ${a.name}`;
        score = `${h.score || 0}–${a.score || 0}`;
        date = comp.date ? fmtDayShort(new Date(comp.date)) : '';
      } catch (e) {}
      let g = '–', as = '–', mins = '–';
      try {
        const st = await request(`${CORE}/${lgId}/events/${eventId}/competitions/${eventId}/competitors/${it.teamId}/roster/${athleteId}/statistics/0?lang=en`, { ttl: 900000 });
        const map = {};
        ((st.splits && st.splits.categories) || []).forEach(c => (c.stats || []).forEach(s => { map[s.name] = s.displayValue; }));
        g = map.totalGoals != null ? map.totalGoals : '–';
        as = map.goalAssists != null ? map.goalAssists : '–';
        mins = map.minutes != null ? map.minutes : '–';
      } catch (e) {}
      return { eventId, label, date, score, g, as, mins };
    }));
    paint(host, `<div class="card-title"><span class="label">Recent matches</span></div>
      <div class="table-wrap"><table class="tbl">
        <thead><tr><th class="team">Match</th><th>Date</th><th>Score</th><th>Min</th><th>G</th><th>A</th></tr></thead>
        <tbody>${rows.map(r => `<tr class="clickable" data-href="#/match/${esc(lgId)}/${esc(r.eventId)}">
          <td class="team">${esc(r.label)}</td><td>${esc(r.date)}</td><td class="key">${esc(r.score)}</td>
          <td>${esc(r.mins)}</td><td class="${+r.g > 0 ? 'hot' : ''}">${esc(r.g)}</td><td class="${+r.as > 0 ? 'hot' : ''}">${esc(r.as)}</td>
        </tr>`).join('')}</tbody></table></div>`);
  } catch (err) {
    paint(host, `<div class="card-title"><span class="label">Recent matches</span></div>
      <div class="note">No match-by-match data published for this player.</div>`);
  }
}

/* ---------------- match centre ---------------- */
function evKind(ev) {
  const slug = (ev && ev.type && ev.type.type) || '';
  const text = (ev && ev.type && ev.type.text) || '';
  if (ev && ev.scoringPlay) return 'goal';
  if (/goal/i.test(slug) && !/no-goal/.test(slug)) return 'goal';
  if (/yellow-red|second-yellow/.test(slug)) return 'red-card';
  if (/red-card/.test(slug)) return 'red-card';
  if (/yellow-card/.test(slug)) return 'yellow-card';
  if (/substitution/.test(slug)) return 'substitution';
  if (/penalty-(missed|saved)/.test(slug) || /Penalty\s*-\s*(Missed|Saved)/i.test(text)) return 'penalty-miss';
  if (/halftime/.test(slug)) return 'marker-ht';
  if (/end-regular-time|end-of-match|full-time/.test(slug)) return 'marker-ft';
  if (/start-2nd-half/.test(slug)) return 'marker-2h';
  if (/kickoff/.test(slug)) return 'marker-ko';
  return 'other';
}
const kindIcon = k => k === 'goal' ? ICON.ball : k === 'red-card' ? cardIcon('r') : k === 'yellow-card' ? cardIcon('y')
  : k === 'substitution' ? ICON.swap : k === 'penalty-miss' ? ICON.x : ICON.clock;

function timelineHTML(sum, homeId) {
  const events = (sum.keyEvents || []).filter(ev => evKind(ev) !== 'other');
  if (!events.length) return `<div class="note">No match events yet.</div>`;
  const row = (isHome, min, icon, main, sub, kind) => {
    const cell = `<div class="side ${isHome ? 'home' : 'away'}">
      ${isHome ? '' : `<span class="ev-ic ${kind === 'goal' ? 'goal' : ''}">${icon}</span>`}
      <span class="who"><b>${main}</b>${sub ? `<small>${sub}</small>` : ''}</span>
      ${isHome ? `<span class="ev-ic ${kind === 'goal' ? 'goal' : ''}">${icon}</span>` : ''}</div>`;
    return `<div class="ev">${isHome ? cell : '<div></div>'}<span class="min">${esc(min)}</span>${isHome ? '<div></div>' : cell}</div>`;
  };
  return `<div class="tl">${events.slice().reverse().map(ev => {
    const kind = evKind(ev);
    const min = (ev.clock && ev.clock.displayValue) || '';
    if (kind.startsWith('marker')) {
      const label = kind === 'marker-ht' ? 'Half time' : kind === 'marker-ft' ? 'Full time' : kind === 'marker-2h' ? 'Second half' : 'Kick off';
      return `<div class="ev marker"><span class="min">${label}</span></div>`;
    }
    const isHome = ev.team && String(ev.team.id) === String(homeId);
    const people = (ev.participants || []).map(p => (p.athlete && p.athlete.displayName) || '').filter(Boolean);
    const typeText = (ev.type && ev.type.text) || '';
    if (kind === 'substitution') {
      return row(isHome, min, ICON.swap, people[0] ? `<span class="sub-in">${esc(people[0])}</span>` : esc(typeText),
        people[1] ? `<span class="sub-out">${esc(people[1])} off</span>` : '', kind);
    }
    const sub = kind === 'goal'
      ? (/penalty/i.test(typeText) ? 'Penalty' : /own/i.test(typeText) ? 'Own goal' : people[1] ? `Assist: ${esc(people[1])}` : esc(typeText))
      : esc(typeText);
    return row(isHome, min, kindIcon(kind), esc(people[0] || typeText), sub, kind);
  }).join('')}</div>`;
}

const STAT_ROWS = [['totalShots', 'Shots'], ['shotsOnTarget', 'Shots on target'], ['wonCorners', 'Corners'], ['saves', 'Saves'],
  ['foulsCommitted', 'Fouls'], ['offsides', 'Offsides'], ['yellowCards', 'Yellow cards'], ['redCards', 'Red cards'],
  ['accuratePasses', 'Accurate passes'], ['totalPasses', 'Passes'], ['totalTackles', 'Tackles'], ['interceptions', 'Interceptions'],
  ['effectiveClearance', 'Clearances']];
function statsHTML(sum, home, away) {
  const teams = sum.boxscore && sum.boxscore.teams;
  if (!teams || teams.length < 2) return `<div class="note">Team stats appear once the match kicks off.</div>`;
  const byId = {};
  teams.forEach(t => { const m = {}; (t.statistics || []).forEach(s => { m[s.name] = s; }); byId[t.team.id] = m; });
  const H = byId[home.id] || {}, A = byId[away.id] || {};
  const val = (m, k) => { const s = m[k]; if (!s) return null; const n = Number(s.displayValue); return { n: isNaN(n) ? 0 : n, d: s.displayValue }; };
  const ph = val(H, 'possessionPct'), pa = val(A, 'possessionPct');
  const poss = (ph && pa) ? `<div class="poss-label">Possession</div>
    <div class="poss"><div class="ph" style="width:${ph.n}%">${esc(ph.d)}%</div><div class="pa" style="width:${pa.n}%">${esc(pa.d)}%</div></div>` : '';
  const rows = STAT_ROWS.map(([k, label]) => {
    const h = val(H, k), a = val(A, k);
    if (!h || !a || (h.n === 0 && a.n === 0)) return '';
    const max = Math.max(h.n, a.n) || 1;
    const hLead = h.n > a.n, aLead = a.n > h.n;
    return `<div class="stat"><div class="stat-top">
        <span class="v h ${hLead ? 'lead' : ''}">${esc(h.d)}</span><span class="l">${esc(label)}</span><span class="v a ${aLead ? 'lead' : ''}">${esc(a.d)}</span></div>
      <div class="bars"><div class="bar h"><i class="${hLead ? 'lead' : ''}" style="width:${(h.n / max) * 100}%"></i></div>
        <div class="bar a"><i class="${aLead ? 'lead' : ''}" style="width:${(a.n / max) * 100}%"></i></div></div></div>`;
  }).join('');
  return `<div class="teams-key"><span>${crest(home)}${esc(home.name)}</span><span>${esc(away.name)}${crest(away)}</span></div>${poss}${rows}<div style="height:8px"></div>`;
}

const posOf = p => ((p.position && (p.position.abbreviation || p.position.displayName)) || '').toUpperCase();
function lineOf(a) {
  if (a === 'G' || a === 'GK') return 0;
  if (/^(CD|CB|LB|RB|SW|LWB|RWB|WB|D)/.test(a)) return 1;
  if (/^(DM|CDM)/.test(a)) return 2;
  if (/^(CM|LM|RM|M)/.test(a)) return 3;
  if (/^(AM|CAM)/.test(a)) return 4;
  return 5;
}
function latOf(a) {
  if (/-L$/.test(a) || /^L/.test(a)) return 0;
  if (/-R$/.test(a) || /^R/.test(a)) return 2;
  return 1;
}
function playerMarks(p) {
  let goals = 0, og = 0, y = 0, r = 0, sub = null;
  (p.plays || []).forEach(pl => {
    if (pl.scoringPlay && !pl.ownGoal) goals++;
    if (pl.ownGoal) og++;
    if (pl.yellowCard) y++;
    if (pl.redCard) r++;
    if (pl.substitution) sub = (pl.clock && pl.clock.displayValue) || '';
  });
  return { goals, og, y, r, sub };
}
const pStat = (p, k) => { const s = (p.stats || []).find(x => x.name === k); return s ? s.displayValue : null; };

/* Vertical pitch with both XIs, portraits and match ratings.
   Home occupies the top half attacking down, away the bottom half. */
function ratingClass(r) {
  if (r == null) return '';
  if (r >= 7.5) return 'r-hi';
  if (r >= 7) return 'r-good';
  if (r >= 6.5) return 'r-ok';
  if (r >= 6) return 'r-mid';
  return 'r-low';
}

function pitchPlayer(p, side, lgId, ratings, depth, lateral) {
  const ath = p.athlete || {};
  const mk = playerMarks(p);
  const rating = ratings && ath.id ? ratings[String(ath.id)] : null;
  const portrait = photoOfSafe(ath.displayName);
  const jersey = esc(p.jersey || ath.jersey || '');
  const top = side === 'home' ? 7 + depth * 36 : 93 - depth * 36;
  const left = side === 'home' ? lateral : 100 - lateral;
  const tags = `${mk.goals || mk.og ? `<span class="pt goal">${ICON.ball}</span>` : ''}` +
    `${mk.y ? '<span class="pt card y"></span>' : ''}${mk.r ? '<span class="pt card r"></span>' : ''}` +
    `${mk.sub != null ? `<span class="pt sub">${ICON.arrowDown}</span>` : ''}`;
  return `<a class="pp ${side}" style="--l:${left.toFixed(1)}%;--t:${top.toFixed(1)}%"
      href="#/player/${esc(lgId)}/${esc(ath.id || '')}" title="${esc(ath.displayName || '')}">
    <span class="pp-av">
      ${portrait ? `<img src="${esc(portrait)}" alt="" loading="lazy" onerror="this.remove()">` : ''}
      <span class="pp-num">${jersey}</span>
      ${tags ? `<span class="pp-tags">${tags}</span>` : ''}
      ${rating != null ? `<span class="pp-rating ${ratingClass(rating)}">${rating.toFixed(1)}</span>` : ''}
    </span>
    <span class="pp-name"><i>${jersey}</i>${esc(ath.shortName || ath.displayName || '')}</span>
  </a>`;
}

function photoOfSafe(name) {
  try { return (window.PredictUI && window.PredictUI.photoFor) ? window.PredictUI.photoFor(name) : ''; }
  catch (e) { return ''; }
}

function formationRows(roster) {
  const starters = (roster || []).filter(p => p.starter);
  if (!starters.length) return [];
  const gk = starters.filter(p => lineOf(posOf(p)) === 0);
  const out = starters.filter(p => lineOf(posOf(p)) !== 0)
    .sort((a, b) => lineOf(posOf(a)) - lineOf(posOf(b)) || latOf(posOf(a)) - latOf(posOf(b)) || (+a.formationPlace || 0) - (+b.formationPlace || 0));
  return [gk].concat(chunkRows(out)).filter(r => r.length);
}
function chunkRows(outfield) {
  const m = new Map();
  outfield.forEach(p => { const l = lineOf(posOf(p)); if (!m.has(l)) m.set(l, []); m.get(l).push(p); });
  return [...m.keys()].sort((a, b) => a - b).map(k => m.get(k));
}

function teamBar(team, formation, side) {
  return `<div class="pitch-bar ${side}">
    ${crest(team)}<b>${esc(team.full || team.name)}</b>
    ${formation ? `<span class="pf">${esc(formation)}</span>` : ''}</div>`;
}

function pitchHTML(sum, home, away, lgId, ratings) {
  const rosters = sum.rosters || [];
  const bySide = {};
  rosters.forEach(r => { bySide[r.homeAway || (String(r.team && r.team.id) === String(home.id) ? 'home' : 'away')] = r; });
  const H = bySide.home, A = bySide.away;
  const hasXI = rosters.some(r => (r.roster || []).some(p => p.starter));
  if (!hasXI) return '';

  const draw = (r, side) => {
    if (!r) return '';
    const rows = formationRows(r.roster);
    const R = rows.length;
    // honour the stated formation when the position data agrees on the count
    const f = String(r.formation || '').split('-').map(Number).filter(n => n > 0);
    let use = rows;
    if (f.length) {
      const outfield = rows.slice(1).reduce((a, b) => a.concat(b), []);
      if (f.reduce((s, n) => s + n, 0) === outfield.length) {
        let i = 0;
        use = [rows[0]].concat(f.map(n => outfield.slice(i, i += n)
          .sort((a, b) => latOf(posOf(a)) - latOf(posOf(b)) || (+a.formationPlace || 0) - (+b.formationPlace || 0))));
      }
    }
    const total = use.length;
    return use.map((row, ri) => row.map((p, pi) => {
      const depth = total > 1 ? ri / (total - 1) : 0.2;
      const lateral = 50 + (((pi + 1) / (row.length + 1)) - 0.5) * 80;
      return pitchPlayer(p, side, lgId, ratings, depth, lateral);
    }).join('')).join('');
  };

  const benchRow = (r, side) => {
    if (!r) return '<div></div>';
    const subs = (r.roster || []).filter(p => !p.starter);
    const team = side === 'home' ? home : away;
    return `<div><div class="card-title"><span class="label">${esc(team.name)} bench</span></div>
      ${subs.length ? subs.map(p => {
        const mk = playerMarks(p);
        const ath = p.athlete || {};
        const on = mk.sub != null || p.subbedIn;
        const rating = ratings && ath.id ? ratings[String(ath.id)] : null;
        return `<a class="bench-row${on ? ' on' : ''}" href="#/player/${esc(lgId)}/${esc(ath.id || '')}">
          <span class="j">${esc(p.jersey || ath.jersey || '')}</span>
          <span class="n">${esc(ath.displayName || '')}</span>
          <span class="p">${esc(posOf(p))}</span>
          ${on ? `<span class="sub-in">${ICON.arrowUp}</span>` : ''}
          ${mk.goals ? ICON.ball : ''}${mk.y ? cardIcon('y') : ''}${mk.r ? cardIcon('r') : ''}
          ${rating != null ? `<span class="bench-rating ${ratingClass(rating)}">${rating.toFixed(1)}</span>` : ''}
        </a>`;
      }).join('') : '<div class="bench-row">No substitutes listed</div>'}</div>`;
  };

  return `<div class="pitch-wrap">
    ${teamBar(home, H && H.formation, 'top')}
    <div class="pitch-v">
      <svg class="lines" viewBox="0 0 680 1050" preserveAspectRatio="none" fill="none" stroke="rgba(255,255,255,.22)" stroke-width="3">
        <rect x="10" y="10" width="660" height="1030" rx="4"/><line x1="10" y1="525" x2="670" y2="525"/>
        <circle cx="340" cy="525" r="84"/><circle cx="340" cy="525" r="4" fill="rgba(255,255,255,.35)"/>
        <rect x="170" y="10" width="340" height="150"/><rect x="170" y="890" width="340" height="150"/>
        <rect x="258" y="10" width="164" height="55"/><rect x="258" y="985" width="164" height="55"/>
        <path d="M258 160a95 95 0 0 0 164 0"/><path d="M258 890a95 95 0 0 1 164 0"/>
      </svg>
      ${draw(H, 'home')}${draw(A, 'away')}
    </div>
    ${teamBar(away, A && A.formation, 'bottom')}
    ${ratings && Object.keys(ratings).length
      ? '<p class="fine">Ratings are calculated by Pitchside from each player’s match statistics — goals, duels, passing, saves and cards. They are not official ratings.</p>'
      : '<p class="fine">Tap a player for their profile. Ratings appear once the match has been played.</p>'}
  </div>
  <div class="bench">${benchRow(H, 'home')}${benchRow(A, 'away')}</div>`;
}

const PCOLS = [['totalGoals', 'G'], ['goalAssists', 'A'], ['totalShots', 'Sh'], ['shotsOnTarget', 'SoT'], ['saves', 'Sv'],
  ['foulsCommitted', 'FC'], ['foulsSuffered', 'FS'], ['offsides', 'Off'], ['yellowCards', 'YC'], ['redCards', 'RC']];
function playersHTML(sum, home, away, lgId) {
  const rosters = sum.rosters || [];
  if (!rosters.length) return `<div class="note">Player data appears once the match kicks off.</div>`;
  const side = S.playerSide;
  const r = rosters.find(x => (x.homeAway || '') === side)
    || rosters.find(x => String(x.team && x.team.id) === String(side === 'home' ? home.id : away.id)) || rosters[0];
  const team = side === 'home' ? home : away;
  const players = (r.roster || []).filter(p => p.starter || p.subbedIn || (p.plays || []).length);
  if (!players.length) return `<div class="note">Player data appears once the match kicks off.</div>`;
  const cols = PCOLS.filter(([k]) => players.some(p => pStat(p, k) != null));
  const sorted = players.slice().sort((a, b) =>
    (+pStat(b, 'totalGoals') || 0) - (+pStat(a, 'totalGoals') || 0) ||
    (+pStat(b, 'goalAssists') || 0) - (+pStat(a, 'goalAssists') || 0) ||
    (+pStat(b, 'totalShots') || 0) - (+pStat(a, 'totalShots') || 0) ||
    (b.starter ? 1 : 0) - (a.starter ? 1 : 0));
  return `<div class="card-title"><span class="label">Player performance</span>
      <span class="seg">
        <button class="${side === 'home' ? 'active' : ''}" data-pside="home">${crest(home)}${esc(home.name)}</button>
        <button class="${side === 'away' ? 'active' : ''}" data-pside="away">${crest(away)}${esc(away.name)}</button>
      </span></div>
    <div class="table-wrap"><table class="tbl">
      <thead><tr><th class="team">${esc(team.name)}</th>${cols.map(([, l]) => `<th>${esc(l)}</th>`).join('')}</tr></thead>
      <tbody>${sorted.map(p => {
        const mk = playerMarks(p);
        const ath = p.athlete || {};
        const marks = `${mk.goals ? ICON.ball : ''}${mk.y ? cardIcon('y') : ''}${mk.r ? cardIcon('r') : ''}${mk.sub != null ? (p.starter ? `<span class="sub-out">${ICON.arrowDown}</span>` : `<span class="sub-in">${ICON.arrowUp}</span>`) : ''}`;
        return `<tr class="clickable" data-href="#/player/${esc(lgId)}/${esc(ath.id || '')}">
          <td class="team"><div class="pname">${avatar({ jersey: p.jersey || ath.jersey, name: ath.displayName }, 'sm')}
            <span><b>${esc(ath.displayName || '')}</b><small>${esc(posOf(p))}</small>${marks ? `<span class="ic-row">${marks}</span>` : ''}</span></div></td>
          ${cols.map(([k]) => {
            const v = pStat(p, k);
            const n = Number(v);
            const hot = n > 0 && (k === 'totalGoals' || k === 'goalAssists');
            return `<td class="${hot ? 'hot' : (!n ? 'zero' : '')}">${esc(v == null ? '–' : v)}</td>`;
          }).join('')}</tr>`;
      }).join('')}</tbody></table></div>`;
}
function topPerformersHTML(sum, home, away) {
  const groups = sum.leaders || [];
  if (groups.length < 2) return '';
  // the feed writes values as "Matches: 4, Goals: 2" — show just the number
  const statNumber = l => {
    if (l.value != null && !isNaN(l.value)) return String(Math.round(l.value * 10) / 10);
    const m = String(l.displayValue || '').match(/(\d[\d.]*)\s*$/);
    return m ? m[1] : String(l.displayValue || '');
  };
  const pick = g => {
    const out = {};
    (g.leaders || []).forEach(cat => {
      const l = (cat.leaders || [])[0];
      if (l) out[cat.name] = { label: cat.displayName, value: statNumber(l), name: (l.athlete && l.athlete.displayName) || '' };
    });
    return out;
  };
  const H = pick(groups.find(g => String(g.team && g.team.id) === String(home.id)) || groups[0]);
  const A = pick(groups.find(g => String(g.team && g.team.id) === String(away.id)) || groups[1]);
  const keys = [...new Set([...Object.keys(H), ...Object.keys(A)])].slice(0, 6);
  if (!keys.length) return '';
  return `<section class="panel section"><div class="card-title"><span class="label">Top performers</span></div>
    <div class="leaders">${keys.map(k => {
      const hv = H[k] ? parseFloat(H[k].value) || 0 : 0;
      const av = A[k] ? parseFloat(A[k].value) || 0 : 0;
      const max = Math.max(hv, av) || 1;
      return `<div class="leader">
        <div class="p h">${H[k] ? `<span>${esc(H[k].name)}</span><b>${esc(H[k].value)}</b>` : ''}</div>
        <div class="cat">${esc((H[k] || A[k]).label)}</div>
        <div class="p a">${A[k] ? `<b>${esc(A[k].value)}</b><span>${esc(A[k].name)}</span>` : ''}</div>
        <div class="lbar h"><i style="width:${(hv / max) * 100}%"></i></div>
        <div></div>
        <div class="lbar a"><i style="width:${(av / max) * 100}%"></i></div>
      </div>`;
    }).join('')}</div></section>`;
}
function commentaryHTML(sum) {
  const list = (sum.commentary || []).slice().reverse();
  if (!list.length) return `<div class="note">Commentary appears once the match kicks off.</div>`;
  return `<ul class="comm">${list.map(c => {
    const kind = evKind(c.play || {});
    return `<li class="${kind === 'goal' ? 'goal' : ''}"><span class="t">${esc((c.time && c.time.displayValue) || '')}</span>
      <span class="i">${kindIcon(kind)}</span><p>${esc(c.text || '')}</p></li>`;
  }).join('')}</ul>`;
}
/* ---------------- match extras: h2h, TV, highlights, news ---------------- */
function h2hHTML(sum, home, away) {
  const series = (sum.seasonseries || [])[0];
  const events = (series && series.events) || [];
  if (!events.length) return '';
  const label = id => String(id) === String(home.id) ? home.name : String(id) === String(away.id) ? away.name : '';
  const rows = events.slice(0, 6).map(ev => {
    const cs = ev.competitors || [];
    const h = cs.find(c => c.homeAway === 'home') || cs[0] || {};
    const a = cs.find(c => c.homeAway === 'away') || cs[1] || {};
    const hn = (h.team && (h.team.shortDisplayName || h.team.displayName)) || label(h.id) || 'Home';
    const an = (a.team && (a.team.shortDisplayName || a.team.displayName)) || label(a.id) || 'Away';
    const when = ev.date ? new Date(ev.date).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }) : '';
    return `<div class="h2h-row"><span class="h">${esc(hn)}</span>
      <span class="s">${esc(h.score != null ? h.score : '–')}–${esc(a.score != null ? a.score : '–')}</span>
      <span class="a">${esc(an)}</span><span class="d">${esc(when)}</span></div>`;
  }).join('');
  return `<section class="panel section"><div class="card-title"><span class="label">Head to head</span>
      ${series.summary ? `<span class="label">${esc(series.summary)}</span>` : ''}</div>${rows}</section>`;
}
function watchHTML(sum) {
  // broadcasts look like { type:{shortName:'TV'}, media:{name:'NBC Sports Network'}, region:'us' }
  const seen = new Set();
  const list = (sum.broadcasts || []).map(b => {
    const m = b.media || {};
    const name = m.name || m.shortName || m.callLetters || '';
    if (!name || seen.has(name)) return null;
    seen.add(name);
    return { name, kind: (b.type && b.type.shortName) || '', region: String(b.region || '').toUpperCase() };
  }).filter(Boolean);
  if (!list.length) return '';
  // ESPN only carries its own market's listings — say so rather than implying local TV
  const regions = [...new Set(list.map(x => x.region).filter(Boolean))];
  return `<section class="panel section"><div class="card-title"><span class="label">Where to watch</span>
      <span class="label">${regions.length ? esc(regions.join(' / ')) + ' listings' : 'Listings'}</span></div>
    <div class="tv-row">${list.map(x => `<span class="tv-chip">${x.kind === 'STREAMING' ? ICON.play : ICON.tv}${esc(x.name)}</span>`).join('')}</div></section>`;
}
const mmss = s => {
  const n = Number(s) || 0;
  return `${Math.floor(n / 60)}:${pad(n % 60)}`;
};
function highlightsHTML(sum) {
  const vids = (sum.videos || []).filter(v => v.thumbnail || v.headline).slice(0, 6);
  if (!vids.length) return '';
  return `<section class="panel section"><div class="card-title"><span class="label">Highlights &amp; video</span></div>
    <div class="media-grid">${vids.map(v => {
      const href = (v.links && v.links.web && v.links.web.href) || (v.links && v.links.api && v.links.api.self && v.links.api.self.href) || '';
      return `<a class="media" href="${esc(href)}" target="_blank" rel="noopener noreferrer">
        <span class="media-thumb">${v.thumbnail ? `<img src="${esc(v.thumbnail)}" alt="" loading="lazy">` : ''}
          <span class="play">${ICON.play}</span>${v.duration ? `<span class="dur">${esc(mmss(v.duration))}</span>` : ''}</span>
        <span class="media-t">${esc(v.headline || 'Video')}</span></a>`;
    }).join('')}</div></section>`;
}
function articlesHTML(list, title) {
  const items = (list || []).filter(a => a.headline).slice(0, 8);
  if (!items.length) return '';
  return `<section class="panel section"><div class="card-title"><span class="label">${esc(title)}</span></div>
    <div class="news-list">${items.map(a => {
      const href = (a.links && a.links.web && a.links.web.href) || '';
      const img = (a.images && a.images[0] && (a.images[0].url || a.images[0].href)) || '';
      const when = a.published ? new Date(a.published).toLocaleDateString([], { day: 'numeric', month: 'short' }) : '';
      return `<a class="news" href="${esc(href)}" target="_blank" rel="noopener noreferrer">
        ${img ? `<img class="news-img" src="${esc(img)}" alt="" loading="lazy">` : '<span class="news-img ph"></span>'}
        <span class="news-t"><b>${esc(a.headline)}</b>
          ${a.description ? `<small>${esc(String(a.description).slice(0, 120))}</small>` : ''}
          <i>${esc(when)}${a.byline ? ' · ' + esc(a.byline) : ''}</i></span></a>`;
    }).join('')}</div></section>`;
}
const matchNewsHTML = sum => articlesHTML((sum.news && sum.news.articles) || [], 'Match reports');

function heroScorers(sum, home) {
  const evs = (sum.keyEvents || []).filter(e => e.scoringPlay);
  const line = isHome => evs.filter(e => (String(e.team && e.team.id) === String(home.id)) === isHome).map(e => {
    const who = ((e.participants || [])[0] || {}).athlete;
    const t = (e.type && e.type.text) || '';
    const mark = /penalty/i.test(t) ? ' (pen)' : /own/i.test(t) ? ' (og)' : '';
    return `${esc((who && who.displayName) || 'Goal')}${mark} ${esc((e.clock && e.clock.displayValue) || '')}`;
  }).join('<br>');
  const h = line(true), a = line(false);
  if (!h && !a) return '';
  return `<div class="h-scorers"><div class="home">${h}</div><div class="mid">${ICON.ball}</div><div class="away">${a}</div></div>`;
}

async function renderMatch(lgId, matchId) {
  paint($('#main'), `<a class="back" href="#/d/${ymd(S.date)}">${ICON.chevL} Back to scores</a>
    <div class="panel skel">${Array.from({ length: 6 }, () => '<div class="skel-row"></div>').join('')}</div>`);
  $('#rail').innerHTML = '';
  renderSidebar();
  let sum;
  try { sum = await request(`${API}/${lgId}/summary?event=${encodeURIComponent(matchId)}`, { ttl: 25000 }); } catch (err) {
    paint($('#main'), `<a class="back" href="#/">${ICON.chevL} Back to scores</a>
      <div class="panel empty"><div class="empty-ic">${ICON.info}</div><h3>Match unavailable</h3>
      <p>We couldn't load this match right now.</p>
      <div class="empty-actions"><a class="btn" href="#/">Back to scores</a></div></div>`);
    return;
  }
  drawMatch(sum, lgId, matchId);
  const names = (sum.rosters || []).map(r => (r.roster || []).map(p => (p.athlete || {}).displayName)).flat().filter(Boolean);
  if (names.length) {
    await fetchPhotos(names);
    if (S.route.name === 'match' && S.route.id === matchId) drawMatch(sum, lgId, matchId);
  }
}
function drawMatch(sum, lgId, matchId) {
  const comp = (sum.header && sum.header.competitions && sum.header.competitions[0]) || {};
  const cs = comp.competitors || [];
  const home = normTeam(cs.find(c => c.homeAway === 'home') || cs[0]);
  const away = normTeam(cs.find(c => c.homeAway === 'away') || cs[1]);
  const st = statusOf({ status: comp.status || {}, date: comp.date });
  const played = st.kind === 'live' || st.kind === 'post';
  const gi = sum.gameInfo || {};
  const venue = gi.venue || {};
  const ref = (gi.officials || []).find(o => /referee/i.test((o.position && o.position.name) || '')) || (gi.officials || [])[0];
  const league = (sum.header && sum.header.league && sum.header.league.name) || lgName(lgId);
  const tabs = [['summary', 'Summary'], ['stats', 'Stats'], ['lineups', 'Line-ups'], ['players', 'Players'], ['commentary', 'Commentary'], ['table', 'Table']];

  paint($('#main'), `
    <a class="back" href="#/d/${ymd(S.date)}">${ICON.chevL} Back to scores</a>
    <section class="hero">
      <div class="hero-bg" style="background:radial-gradient(520px 260px at 0% 0%, ${hexA(home.color, .26)}, transparent 66%),radial-gradient(520px 260px at 100% 0%, ${hexA(away.color, .26)}, transparent 66%)"></div>
      <div class="hero-top">
        <a class="lg" href="#/league/${esc(lgId)}">${lgLogo(lgId)}${esc(league)}</a>
        <span>${esc(fmtDayShort(new Date(comp.date)))} · ${esc(fmtTime(comp.date))}</span>
      </div>
      <div class="hero-main">
        <a class="h-team" href="#/team/${esc(lgId)}/${esc(home.id)}">${crest(home)}<b>${esc(home.full)}</b></a>
        <div class="h-score">
          ${played ? `<div class="big">${esc(home.score || '0')}<span class="sep">–</span>${esc(away.score || '0')}</div>`
                   : `<div class="kick">${esc(fmtTime(comp.date))}</div>`}
          <div class="badge ${st.kind === 'live' ? 'live' : ''}">${st.kind === 'live' ? '<span class="dot"></span>' : ''}${esc(st.kind === 'pre' ? 'Kick-off' : st.label)}</div>
          ${(home.shootout != null && away.shootout != null && (+home.shootout || +away.shootout)) ? `<div class="h-note">Penalties ${esc(home.shootout)}–${esc(away.shootout)}</div>` : ''}
        </div>
        <a class="h-team" href="#/team/${esc(lgId)}/${esc(away.id)}">${crest(away)}<b>${esc(away.full)}</b></a>
      </div>
      ${heroScorers(sum, home)}
      <div class="h-meta">
        ${venue.fullName ? `<span>${ICON.stadium}${esc(venue.fullName)}${venue.address && venue.address.city ? ', ' + esc(venue.address.city) : ''}</span>` : ''}
        ${gi.attendance ? `<span>${ICON.users}${esc(Number(gi.attendance).toLocaleString())}</span>` : ''}
        ${ref ? `<span>${ICON.whistle}${esc(ref.displayName || ref.fullName)}</span>` : ''}
      </div>
    </section>
    <nav class="tabs" role="tablist">${tabs.map(([id, label]) =>
      `<button class="tab${S.matchTab === id ? ' active' : ''}" data-tab="${id}" role="tab" aria-selected="${S.matchTab === id}">${label}</button>`).join('')}</nav>
    <div id="tabBody"></div>`);

  const body = $('#tabBody');
  if (S.matchTab === 'summary') {
    paint(body, `<section class="panel section predict" id="predictBox"></section>
      <section class="panel section"><div class="card-title"><span class="label">Match events</span></div>${timelineHTML(sum, home.id)}</section>
      ${topPerformersHTML(sum, home, away)}${h2hHTML(sum, home, away)}${watchHTML(sum)}${highlightsHTML(sum)}${matchNewsHTML(sum)}`);
    if (window.PredictUI) {
      const reds = (sum.keyEvents || []).filter(e => evKind(e) === 'red-card');
      const sideReds = id => reds.filter(e => String(e.team && e.team.id) === String(id)).length;
      window.PredictUI.renderMatchPrediction($('#predictBox'), {
        lgId, matchId, home, away, date: comp.date, statusKind: st.kind,
        hg: Number(home.score) || 0, ag: Number(away.score) || 0,
        minute: parseInt(String((comp.status || {}).displayClock || '0'), 10) || 0,
        redH: sideReds(home.id), redA: sideReds(away.id),
      });
    }
  }
  else if (S.matchTab === 'stats') paint(body, `<section class="panel section">${statsHTML(sum, home, away)}</section>`);
  else if (S.matchTab === 'lineups') {
    const cached = window.PredictUI && window.PredictUI.cachedRatings ? window.PredictUI.cachedRatings(matchId) : null;
    const pitch = pitchHTML(sum, home, away, lgId, cached);
    if (pitch) {
      paint(body, `<section class="panel section">${pitch}</section>`);
      if (!cached && st.kind !== 'pre' && window.PredictUI && window.PredictUI.loadRatings) {
        window.PredictUI.loadRatings(lgId, matchId, sum).then(map => {
          if (!map || S.matchTab !== 'lineups' || S.route.name !== 'match' || S.route.id !== matchId) return;
          paint($('#tabBody'), `<section class="panel section">${pitchHTML(sum, home, away, lgId, map)}</section>`);
        }).catch(() => {});
      }
    } else {
      paint(body, '<section class="panel section" id="probableXI"></section>');
      if (window.PredictUI && window.PredictUI.renderProbableXI) {
        window.PredictUI.renderProbableXI($('#probableXI'), { lgId, home, away });
      } else {
        paint($('#probableXI'), '<div class="note">Line-ups are published about an hour before kick-off.</div>');
      }
    }
  }
  else if (S.matchTab === 'players') paint(body, `<section class="panel section">${playersHTML(sum, home, away, lgId)}</section>`);
  else if (S.matchTab === 'commentary') paint(body, `<section class="panel section"><div class="card-title"><span class="label">Commentary</span></div>${commentaryHTML(sum)}</section>`);
  else {
    paint(body, `<section class="panel section" id="matchTable"><div class="note">Loading table…</div></section>`);
    getStandings(lgId).then(data => {
      const host = $('#matchTable');
      if (!host) return;
      paint(host, data.groups.length ? data.groups.map(g => standingsTable(g, lgId, [home.id, away.id])).join('') + standingsLegend(data.groups)
        : '<div class="note">No table for this competition.</div>');
    }).catch(() => { const h = $('#matchTable'); if (h) paint(h, '<div class="note">No table for this competition.</div>'); });
  }

  const bucket = dayMap(S.date).get(lgId);
  const others = bucket ? bucket.events.filter(m => m.id !== matchId) : [];
  paint($('#rail'), `${others.length ? `<section class="panel other">
    <div class="rail-head"><span class="label">More in ${esc(league)}</span></div>
    ${others.map(m => {
      const s = statusOf(m);
      const p = s.kind === 'live' || s.kind === 'post';
      return `<a href="#/match/${esc(m.lg)}/${esc(m.id)}"><span class="h">${esc(m.home.name)}</span>
        <span class="s ${s.kind === 'live' ? 'live' : ''}">${p ? `${esc(m.home.score || '0')}–${esc(m.away.score || '0')}` : esc(fmtTime(m.date))}</span>
        <span class="a">${esc(m.away.name)}</span></a>`;
    }).join('')}</section>` : ''}
    <section class="panel"><div class="rail-head"><span class="label">Clubs</span></div>
      <a class="pos-item" href="#/team/${esc(lgId)}/${esc(home.id)}">${crest(home)}<span class="nm">${esc(home.full)}</span>${ICON.chevR}</a>
      <a class="pos-item" href="#/team/${esc(lgId)}/${esc(away.id)}">${crest(away)}<span class="nm">${esc(away.full)}</span>${ICON.chevR}</a>
    </section>`);
  S.current = { sum, lgId, matchId, state: st.kind };
}

/* ---------------- live pill + routing ---------------- */
function updateLivePill() {
  const pill = $('#livePill');
  if (!pill) return;
  const c = countsFor(new Date());
  pill.hidden = c.live === 0;
  if (c.live) $('#liveCount').textContent = c.live;
}
function parseHash() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (!parts.length) return { name: 'scores', date: startOfDay(new Date()) };
  if (parts[0] === 'd' && parts[1]) return { name: 'scores', date: parseYmd(parts[1]) };
  if (parts[0] === 'match' && parts[2]) return { name: 'match', lg: parts[1], id: parts[2] };
  if (parts[0] === 'league' && parts[1]) return { name: 'league', lg: parts[1], tab: parts[2] || 'fixtures' };
  if (parts[0] === 'team' && parts[2]) return { name: 'team', lg: parts[1], id: parts[2], tab: parts[3] || 'overview' };
  if (parts[0] === 'player' && parts[2]) return { name: 'player', lg: parts[1], id: parts[2] };
  if (parts[0] === 'predictions') return { name: 'predictions' };
  if (parts[0] === 'table' && parts[1]) return { name: 'league', lg: parts[1], tab: 'table' };
  return { name: 'scores', date: startOfDay(new Date()) };
}
function setNav(name) {
  document.querySelectorAll('.nav a').forEach(a => a.classList.toggle('active', a.dataset.nav === name));
}
async function route() {
  const r = parseHash();
  const prev = S.route;
  S.route = r;
  window.scrollTo({ top: 0 });
  if (r.name === 'match') {
    setNav('scores');
    if (!dayMap(S.date).size) loadDay(S.date, { silent: true });
    await renderMatch(r.lg, r.id);
  } else if (r.name === 'league') {
    setNav('leagues');
    if (!prev || prev.name !== 'league' || prev.lg !== r.lg) S.monthOffset = 0;
    renderLeague(r.lg, r.tab);
  } else if (r.name === 'team') {
    setNav('leagues');
    S.teamTab = r.tab || 'overview';
    await renderTeam(r.lg, r.id);
  } else if (r.name === 'player') {
    setNav('leagues');
    await renderPlayer(r.lg, r.id);
  } else if (r.name === 'predictions') {
    setNav('predictions');
    renderSidebar();
    if (window.PredictUI) await window.PredictUI.renderHub($('#main'), $('#rail'));
  } else {
    setNav('scores');
    S.date = r.date || startOfDay(new Date());
    renderScores();
    await loadDay(S.date);
  }
  updateLivePill();
}
function goDate(date) {
  S.date = startOfDay(date);
  const hash = isToday(S.date) ? '#/' : `#/d/${ymd(S.date)}`;
  if (location.hash === hash || (!location.hash && hash === '#/')) { renderScores(); loadDay(S.date); }
  else location.hash = hash;
}

/* ---------------- events ---------------- */
document.addEventListener('click', e => {
  const pin = e.target.closest('[data-pin]');
  if (pin) {
    e.preventDefault(); e.stopPropagation();
    const id = pin.dataset.pin;
    S.pins = S.pins.includes(id) ? S.pins.filter(x => x !== id) : [id, ...S.pins];
    savePins(); renderSidebar();
    if (S.route.name === 'scores') { renderScoresBody(); renderRail(); }
    return;
  }
  const fav = e.target.closest('[data-fav]');
  if (fav) {
    e.preventDefault();
    const id = fav.dataset.fav;
    const has = LS.favs.some(f => String(f.id) === String(id));
    LS.favs = has ? LS.favs.filter(f => String(f.id) !== String(id))
      : [{ id, lg: fav.dataset.lg, name: fav.dataset.name, logo: fav.dataset.logo }, ...LS.favs].slice(0, 12);
    persist();
    renderSidebar();
    if (S.route.name === 'team') renderTeam(S.route.lg, S.route.id);
    return;
  }
  const rowLink = e.target.closest('[data-href]');
  if (rowLink && !e.target.closest('a')) { location.hash = rowLink.dataset.href; return; }
  const shift = e.target.closest('[data-shift]');
  if (shift) { goDate(addDays(S.date, +shift.dataset.shift)); return; }
  const day = e.target.closest('[data-date]');
  if (day) { goDate(parseYmd(day.dataset.date)); return; }
  const filter = e.target.closest('[data-filter]');
  if (filter) { S.filter = filter.dataset.filter; renderScoresBody(); return; }
  const tab = e.target.closest('[data-tab]');
  if (tab && S.current) { S.matchTab = tab.dataset.tab; drawMatch(S.current.sum, S.current.lgId, S.current.matchId); return; }
  const pside = e.target.closest('[data-pside]');
  if (pside && S.current) { S.playerSide = pside.dataset.pside; drawMatch(S.current.sum, S.current.lgId, S.current.matchId); return; }
  const sched = e.target.closest('[data-sched]');
  if (sched && S.route.name === 'league') { S.scheduleFilter = sched.dataset.sched; renderLeague(S.route.lg, S.route.tab); return; }
  const jump = e.target.closest('[data-sched-jump]');
  if (jump) { const el = $('#nextFixture'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
  const month = e.target.closest('[data-month]');
  if (month && S.route.name === 'league') { S.monthOffset += +month.dataset.month; renderLeague(S.route.lg, S.route.tab); return; }
  const cal = e.target.closest('#calBtn');
  if (cal) {
    const input = $('#calInput');
    if (input) { if (input.showPicker) { try { input.showPicker(); } catch (err) { input.click(); } } else input.click(); }
    return;
  }
  const act = e.target.closest('[data-act]');
  if (act) {
    const a = act.dataset.act;
    if (a === 'reload') loadDay(S.date, { force: true });
    if (a === 'reload-month' && S.route.name === 'league') renderLeague(S.route.lg, S.route.tab);
    if (a === 'clear') { S.filter = 'all'; S.q = ''; const s = $('#search'); if (s) s.value = ''; renderScoresBody(); }
    if (a === 'next-day' && act.dataset.day) goDate(parseYmd(act.dataset.day));
  }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') {
    const pin = e.target.closest('[data-pin]');
    if (pin) { e.preventDefault(); pin.click(); }
    return;
  }
  // arrow keys step through days, but never while typing in the search box
  if (/^(INPUT|TEXTAREA|SELECT)$/.test((e.target.tagName || '')) || e.metaKey || e.ctrlKey || e.altKey) return;
  if (S.route.name !== 'scores') return;
  if (e.key === 'ArrowLeft') { e.preventDefault(); goDate(addDays(S.date, -1)); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); goDate(addDays(S.date, 1)); }
  else if (e.key.toLowerCase() === 't') { e.preventDefault(); goDate(new Date()); }
});
document.addEventListener('change', e => {
  if (e.target.id === 'calInput' && e.target.value) {
    const [y, m, d] = e.target.value.split('-').map(Number);
    goDate(new Date(y, m - 1, d));
  }
});
let searchTimer = null;
document.addEventListener('input', e => {
  if (e.target.id !== 'search') return;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    S.q = e.target.value;
    if (S.route.name !== 'scores') location.hash = isToday(S.date) ? '#/' : `#/d/${ymd(S.date)}`;
    else renderScoresBody();
  }, 200);
});
$('#livePill').addEventListener('click', () => { S.filter = 'live'; goDate(new Date()); });
window.addEventListener('hashchange', route);

setInterval(() => {
  if (document.hidden) return;
  if (S.route.name === 'scores') {
    const c = countsFor(S.date);
    if (isToday(S.date) || c.live) loadDay(S.date, { silent: true, force: true });
  } else if (S.route.name === 'match' && S.current && S.current.state !== 'post') {
    request(`${API}/${S.current.lgId}/summary?event=${S.current.matchId}`, { ttl: 0, force: true })
      .then(sum => { if (S.route.name === 'match') drawMatch(sum, S.current.lgId, S.current.matchId); })
      .catch(() => {});
  }
}, 30000);
setInterval(() => { if (!document.hidden && !isToday(S.date)) loadDay(new Date(), { silent: true, force: true }); }, 180000);

/* everything predict-ui.js needs — one explicit surface rather than
   reaching into internals, so refactors here break loudly not silently */
window.PS = {
  API, API2, CORE, WEB, LEAGUES, LG_BY_ID,
  request, loadMonth, statusOf, normTeam, normEvent, lgName,
  ensureSeason, getStandings, getPerson,
  paint, esc, ICON, crest, lgLogo, avatar,
  fmtTime, fmtDayShort, fmtDayLong, ymd, addDays, addMonths, startOfDay, parseYmd,
  orderedLeagues, dayMap, S,
};

const tzEl = $('#tzNote');
if (tzEl) tzEl.textContent = tzLabel();
route();
