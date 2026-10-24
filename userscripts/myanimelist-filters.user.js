// ==UserScript==
// @name         MyAnimeList - Genre, Type, Score, Members, Episodes & Runtime Filters
// @namespace    mal-custom-filters
// @version      1.2.1
// @description  Hide anime by genre/theme/demographic, type, minimum MAL score, members range (min & max), maximum episodes and maximum total runtime. Export filtered results and their metadata to CSV or JSON.
// @author       Marco
// @match        https://myanimelist.net/*
// @updateURL    https://raw.githubusercontent.com/mromanode/GoingAlternative/main/userscripts/myanimelist-filters.user.js
// @downloadURL  https://raw.githubusercontent.com/mromanode/GoingAlternative/main/userscripts/myanimelist-filters.user.js
// @supportURL   https://github.com/mromanode/GoingAlternative/issues
// @homepageURL  https://github.com/mromanode/GoingAlternative
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';

  if (window.top !== window.self) return;

  const GENRES = [
    'Hentai', 'Erotica', 'Ecchi', 'Boys Love', 'Girls Love', 'Harem',
    'Reverse Harem', 'Isekai', 'Kids', 'Idols (Female)', 'Idols (Male)',
    'Mecha', 'Sports', 'Slice of Life'
  ];

  const TYPES = ['TV', 'Movie', 'OVA', 'ONA', 'Special', 'TV Special', 'Music', 'CM', 'PV'];

  const TYPE_IDS = { 1: 'TV', 2: 'OVA', 3: 'Movie', 4: 'Special', 5: 'ONA', 6: 'Music', 7: 'CM', 8: 'PV', 9: 'TV Special' };

  const SCORES = [0, 6, 6.5, 7, 7.25, 7.5, 7.75, 8, 8.25, 8.5, 8.75, 9];
  const MEMBERS = [0, 1000, 5000, 10000, 25000, 50000, 100000, 250000, 500000, 1000000, 2000000, 3000000];
  const EPISODES = [0, 1, 6, 12, 13, 24, 26, 50, 100];
  const RUNTIMES = [0, 30, 60, 90, 120, 180, 300, 600, 1200];

  const SETTINGS_KEY = 'mal-filter-v1-settings';
  const CACHE_PREFIX = 'mal-filter-v1:';
  const TTL = 24 * 60 * 60 * 1000;
  const MAX_FETCH = 2;
  const MIN_GAP_MS = 400; // Keep requests spaced to avoid MAL rate limits.

  const CONTAINER_SELECTOR = [
    'tr.ranking-list',
    'div.seasonal-anime',
    'div.js-categories-seasonal tr',
    'li.btn-anime',
    '.related-entries .entry',
    '.related-entries .entries li'
  ].join(',');

  const EXPORT_DATA_FIELDS = ['score', 'members', 'episodes', 'duration', 'type', 'genres'];

  const PAGE_ID = location.pathname.match(/^\/anime\/(\d+)/)?.[1] || null;

  const clampIdx = (v, arr) => Math.max(0, Math.min(arr.length - 1, Number(v) || 0));

  function loadSettings() {
    let s = {};
    try { s = JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { s = {}; }
    return {
      genres: new Set(Array.isArray(s.genres) ? s.genres.filter(g => GENRES.includes(g)) : []),
      types: new Set(Array.isArray(s.types) ? s.types.filter(t => TYPES.includes(t)) : []),
      scoreIndex: clampIdx(s.scoreIndex, SCORES),
      minMembersIndex: clampIdx(s.minMembersIndex, MEMBERS),
      maxMembersIndex: clampIdx(s.maxMembersIndex, MEMBERS),
      episodesIndex: clampIdx(s.episodesIndex, EPISODES),
      runtimeIndex: clampIdx(s.runtimeIndex, RUNTIMES)
    };
  }

  const state = loadSettings();

  function saveSettings() {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      ...state,
      genres: [...state.genres],
      types: [...state.types]
    }));
  }

  const fresh = ts => Number.isFinite(ts) && Date.now() - ts < TTL;

  function getCache(id) {
    try { return JSON.parse(localStorage.getItem(CACHE_PREFIX + id)) || null; } catch { return null; }
  }

  function setCache(id, data) {
    const value = JSON.stringify({ ...data, at: Date.now() });
    try {
      localStorage.setItem(CACHE_PREFIX + id, value);
    } catch {
      // Retry after clearing script-owned entries when the storage quota is full.
      pruneCache(true);
      try { localStorage.setItem(CACHE_PREFIX + id, value); } catch {}
    }
  }

  function pruneCache(all = false) {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(CACHE_PREFIX)) continue;
      if (all) { localStorage.removeItem(key); continue; }
      try {
        const v = JSON.parse(localStorage.getItem(key));
        if (!v || !fresh(v.at)) localStorage.removeItem(key);
      } catch {
        localStorage.removeItem(key);
      }
    }
  }

  function parseIntSafe(text) {
    const m = String(text ?? '').replace(/,/g, '').match(/\d+/);
    return m ? Number(m[0]) : null;
  }

  function parseScore(text) {
    const v = parseFloat(String(text ?? '').trim());
    return Number.isFinite(v) && v > 0 ? v : null;
  }

  function parseDuration(text) {
    if (!text) return null;
    const h = Number(text.match(/(\d+)\s*hr/)?.[1] || 0);
    const m = Number(text.match(/(\d+)\s*min/)?.[1] || 0);
    const s = Number(text.match(/(\d+)\s*sec/)?.[1] || 0);
    const total = h * 60 + m + s / 60;
    return total > 0 ? total : null;
  }

  function formatCount(value) {
    if (!value) return 'OFF';
    if (value >= 1000000) { const n = value / 1000000; return (Number.isInteger(n) ? n : n.toFixed(1)) + 'M'; }
    if (value >= 1000) { const n = value / 1000; return (Number.isInteger(n) ? n : n.toFixed(1)) + 'K'; }
    return String(value);
  }

  function formatRuntime(minutes) {
    if (!minutes) return 'OFF';
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    if (h && m) return `${h}h ${m}m`;
    if (h) return `${h}h`;
    return `${m}m`;
  }

  function formatScore(v) {
    return v ? v.toFixed(2).replace(/0$/, '') : 'OFF';
  }

  function infoValue(doc, label) {
    for (const el of doc.querySelectorAll('.leftside .spaceit_pad')) {
      const dt = el.querySelector('.dark_text');
      if (!dt || dt.textContent.trim() !== label + ':') continue;
      const full = el.textContent;
      const idx = full.indexOf(dt.textContent);
      return full.slice(idx + dt.textContent.length).replace(/\s+/g, ' ').trim();
    }
    return null;
  }

  function parseAnimePage(doc) {
    const scoreText =
      doc.querySelector('[itemprop="ratingValue"]')?.textContent ||
      doc.querySelector('.anime-detail-header-stats .score-label')?.textContent;
    const eps = parseInt(infoValue(doc, 'Episodes'), 10);

    return {
      score: parseScore(scoreText),
      members: parseIntSafe(infoValue(doc, 'Members')),
      episodes: Number.isFinite(eps) && eps > 0 ? eps : null,
      duration: parseDuration(infoValue(doc, 'Duration')),
      type: infoValue(doc, 'Type') || null,
      genres: [...new Set(
        [...doc.querySelectorAll('.leftside span[itemprop="genre"]')].map(s => s.textContent.trim())
      )]
    };
  }

  function inlineData(box) {
    if (box.matches('div.seasonal-anime')) return seasonalData(box);
    if (!box.matches('tr.ranking-list')) return {};
    const d = {};
    const scoreEl = box.querySelector('td.score .score-label');
    if (scoreEl) d.score = parseScore(scoreEl.textContent);

    const info = box.querySelector('.information')?.textContent || '';
    const t = info.match(/([A-Za-z][A-Za-z ]*?)\s*\((\d+|\?)\s*eps?\)/);
    if (t) {
      d.type = t[1].trim();
      d.episodes = t[2] === '?' ? null : Number(t[2]);
    }
    const mm = info.match(/([\d,]+)\s+members/i);
    if (mm) d.members = Number(mm[1].replace(/,/g, ''));
    return d;
  }

  function seasonalData(box) {
    const d = {};
    const sc = box.querySelector('.js-score');
    if (sc) d.score = parseScore(sc.textContent);
    const mem = box.querySelector('.js-members');
    if (mem) d.members = parseIntSafe(mem.textContent);

    const info = (box.querySelector('.prodsrc .info')?.textContent || '').replace(/\s+/g, ' ');
    const ep = info.match(/(\d+|\?)\s*eps?\b/);
    if (ep) d.episodes = ep[1] === '?' ? null : Number(ep[1]);
    if (/\d+\s*(?:hr|min|sec)/.test(info)) d.duration = parseDuration(info);

    const typeId = box.className.match(/\bjs-anime-type-(\d+)\b/)?.[1];
    if (typeId && TYPE_IDS[typeId]) d.type = TYPE_IDS[typeId];

    if (box.querySelector('.js-genre, .properties')) {
      d.genres = [...new Set([...box.querySelectorAll('a[href*="/anime/genre/"]')]
        .map(a => (a.getAttribute('title') || a.textContent).trim())
        .filter(Boolean))];
    }
    return d;
  }

  function idFrom(box) {
    for (const a of box.querySelectorAll('a[href]')) {
      let path;
      try { path = new URL(a.getAttribute('href'), location.origin).pathname; } catch { continue; }
      let m = path.match(/^\/anime\/(\d+)(?:\/|$)/);
      if (m) return m[1];
      m = path.match(/^\/recommendations\/anime\/(\d+)-(\d+)/);
      if (m) return m[1] === PAGE_ID ? m[2] : m[1];
    }
    return null;
  }

  let fetchActive = 0;
  let lastFetchAt = 0;
  let pauseUntil = 0;
  let pending = 0;
  const inFlight = new Map();
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  async function acquireSlot() {
    for (;;) {
      const now = Date.now();
      const wait = Math.max(pauseUntil - now, lastFetchAt + MIN_GAP_MS - now, 0);
      if (fetchActive < MAX_FETCH && wait === 0) {
        fetchActive++;
        lastFetchAt = now;
        return;
      }
      await sleep(Math.max(wait, 60));
    }
  }

  async function fetchAnime(id) {
    let lastErr = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      await acquireSlot();
      let html = null;
      let status = 0;
      try {
        const res = await fetch(`${location.origin}/anime/${id}`, { credentials: 'same-origin' });
        status = res.status;
        if (res.ok) html = await res.text();
      } catch (err) {
        lastErr = err;
      } finally {
        fetchActive--;
        updateStatus();
      }

      if (html) {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        if (doc.querySelector('.leftside')) {
          const data = parseAnimePage(doc);
          setCache(id, data);
          return data;
        }
        lastErr = new Error('unexpected page (captcha / block?)');
      } else if (status === 404) {
        throw new Error('HTTP 404');
      } else if (!lastErr) {
        lastErr = new Error(`HTTP ${status}`);
      }

      pauseUntil = Math.max(pauseUntil, Date.now() + 2000 * 2 ** attempt);
      updateStatus();
    }
    throw lastErr;
  }

  function getAnime(id) {
    if (inFlight.has(id)) return inFlight.get(id);
    const p = fetchAnime(id).finally(() => inFlight.delete(id));
    inFlight.set(id, p);
    return p;
  }

  let filterRevision = 1;
  let refreshTimer;
  let scanTimer;
  let statusEl;

  function filtersOff() {
    return !state.genres.size && !state.types.size && !state.scoreIndex &&
      !state.minMembersIndex && !state.maxMembersIndex && !state.episodesIndex && !state.runtimeIndex;
  }

  function currentFilters() {
    return {
      revision: filterRevision,
      genres: new Set(state.genres),
      types: new Set(state.types),
      minScore: SCORES[state.scoreIndex],
      minMembers: MEMBERS[state.minMembersIndex],
      maxMembers: MEMBERS[state.maxMembersIndex],
      maxEpisodes: EPISODES[state.episodesIndex],
      maxRuntime: RUNTIMES[state.runtimeIndex]
    };
  }

  function requiredFields(f) {
    const need = [];
    if (f.genres.size) need.push('genres');
    if (f.types.size) need.push('type');
    if (f.minScore) need.push('score');
    if (f.minMembers || f.maxMembers) need.push('members');
    if (f.maxEpisodes) need.push('episodes');
    if (f.maxRuntime) need.push('episodes', 'duration');
    return need;
  }

  function mustHide(d, f) {
    if (f.genres.size && Array.isArray(d.genres) && d.genres.some(g => f.genres.has(g))) return true;
    if (f.types.size && d.type && f.types.has(d.type)) return true;
    if (f.minScore && 'score' in d && (d.score == null || d.score < f.minScore)) return true;
    if (f.minMembers && d.members != null && d.members < f.minMembers) return true;
    if (f.maxMembers && d.members != null && d.members > f.maxMembers) return true;
    if (f.maxEpisodes && d.episodes != null && d.episodes > f.maxEpisodes) return true;
    if (f.maxRuntime && d.episodes != null && d.duration != null && d.episodes * d.duration > f.maxRuntime) return true;
    return false;
  }

  // A class leaves MAL's native R18, type, and sorting toggles in control of inline display styles.
  const HIDDEN_CLASS = 'mal-filter-hidden';
  const hideStyle = document.createElement('style');
  hideStyle.textContent = `.${HIDDEN_CLASS}{display:none !important}`;
  (document.head || document.documentElement).appendChild(hideStyle);

  function show(el) {
    el.classList.remove(HIDDEN_CLASS);
  }

  function hide(el) {
    el.classList.add(HIDDEN_CLASS);
  }

  function apply(box, data, f) {
    mustHide(data, f) ? hide(box) : show(box);
  }

  function evaluate(box) {
    const id = idFrom(box);
    if (!id || id === PAGE_ID) return;

    const rev = String(filterRevision);
    if (box.dataset.malFilterRev === rev) return;
    box.dataset.malFilterRev = rev;

    if (filtersOff()) { show(box); return; }

    const f = currentFilters();
    const inline = inlineData(box);
    const cached = getCache(id);
    const data = { ...(cached && fresh(cached.at) ? cached : {}), ...inline };

    if (requiredFields(f).every(k => k in data)) {
      apply(box, data, f);
      return;
    }

    pending++;
    updateStatus();
    getAnime(id)
      .then(full => ({ ...full, ...inline }))
      .catch(err => { console.warn('[MAL filter]', id, err); return data; })
      .then(d => { if (f.revision === filterRevision) apply(box, d, f); })
      .finally(() => { pending--; updateStatus(); });
  }

  function scan() {
    document.querySelectorAll(CONTAINER_SELECTOR).forEach(evaluate);
  }

  function scheduleRefresh() {
    filterRevision++;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      saveSettings();
      scan();
    }, 180);
  }

  function updateStatus() {
    if (!statusEl) return;
    const waiting = pauseUntil > Date.now() ? ` · rate limit, attendo ${Math.ceil((pauseUntil - Date.now()) / 1000)}s` : '';
    statusEl.textContent = pending
      ? `Checking ${pending} anime…${waiting}`
      : 'Ready';
  }

  function createUI() {
    if (document.getElementById('mal-filter-panel')) return;

    const wrapper = document.createElement('div');
    wrapper.id = 'mal-filter-panel';
    Object.assign(wrapper.style, {
      position: 'fixed',
      bottom: '84px',
      right: '16px',
      zIndex: '999999',
      font: '13px Arial, sans-serif',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'flex-end'
    });

    const button = document.createElement('button');
    button.type = 'button';
    Object.assign(button.style, {
      padding: '10px 14px',
      border: '1px solid rgba(255,255,255,.16)',
      borderRadius: '6px',
      color: '#fff',
      fontWeight: '700',
      cursor: 'pointer',
      boxShadow: '0 2px 10px rgba(0,0,0,.4)'
    });

    const panel = document.createElement('div');
    Object.assign(panel.style, {
      display: 'none',
      width: '290px',
      boxSizing: 'border-box',
      maxHeight: 'calc(100vh - 160px)',
      overflowY: 'auto',
      marginBottom: '6px',
      padding: '14px',
      background: '#14181c',
      color: '#d8e0e8',
      border: '1px solid rgba(255,255,255,.14)',
      borderRadius: '7px',
      boxShadow: '0 6px 22px rgba(0,0,0,.55)',
      textAlign: 'left'
    });

    const title = document.createElement('div');
    title.textContent = 'MYANIMELIST FILTERS';
    Object.assign(title.style, { color: '#fff', fontSize: '12px', fontWeight: '800', letterSpacing: '.08em', marginBottom: '12px' });
    panel.appendChild(title);

    const sectionLabel = text => {
      const el = document.createElement('div');
      el.textContent = text;
      Object.assign(el.style, { color: '#9ab', fontSize: '11px', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '.05em', margin: '10px 0 7px' });
      return el;
    };

    const divider = () => {
      const el = document.createElement('div');
      el.style.cssText = 'border-top:1px solid rgba(255,255,255,.10);margin:12px 0';
      return el;
    };

    const checkboxes = [];
    const makeCheckboxGrid = (items, set) => {
      const grid = document.createElement('div');
      grid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:2px 8px';
      items.forEach(name => {
        const row = document.createElement('label');
        row.style.cssText = 'display:flex;align-items:center;gap:6px;margin:3px 0;cursor:pointer;user-select:none;color:#d8e0e8;font-size:12px';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = set.has(name);
        cb.style.accentColor = '#2e51a2';
        cb.addEventListener('change', () => {
          cb.checked ? set.add(name) : set.delete(name);
          updateButton();
          scheduleRefresh();
        });
        checkboxes.push(cb);
        const text = document.createElement('span');
        text.textContent = name;
        row.append(cb, text);
        grid.appendChild(row);
      });
      return grid;
    };

    panel.appendChild(sectionLabel('Hide genres / themes'));
    panel.appendChild(makeCheckboxGrid(GENRES, state.genres));
    panel.appendChild(divider());
    panel.appendChild(sectionLabel('Hide types'));
    panel.appendChild(makeCheckboxGrid(TYPES, state.types));
    panel.appendChild(divider());

    const sliderSyncs = [];
    const makeSlider = ({ name, arr, key, fmt, scale }) => {
      const heading = document.createElement('div');
      heading.style.cssText = 'display:flex;justify-content:space-between;align-items:baseline;margin-bottom:5px';
      const label = document.createElement('strong');
      label.textContent = name;
      label.style.color = '#fff';
      const output = document.createElement('span');
      output.style.cssText = 'color:#6f9cff;font-weight:700';
      heading.append(label, output);
      panel.appendChild(heading);

      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = '0';
      slider.max = String(arr.length - 1);
      slider.step = '1';
      slider.style.cssText = 'display:block;width:100%;box-sizing:border-box;margin:0;accent-color:#2e51a2';
      panel.appendChild(slider);

      const scaleEl = document.createElement('div');
      scaleEl.style.cssText = 'display:flex;justify-content:space-between;margin-top:1px;color:#678;font-size:10px';
      scale.forEach(t => {
        const span = document.createElement('span');
        span.textContent = t;
        scaleEl.appendChild(span);
      });
      panel.appendChild(scaleEl);

      const sync = () => {
        slider.value = String(state[key]);
        output.textContent = fmt(arr[state[key]]);
      };
      slider.addEventListener('input', () => {
        state[key] = Number(slider.value);
        sync();
        updateButton();
        scheduleRefresh();
      });
      sync();
      sliderSyncs.push(sync);
    };

    makeSlider({ name: 'Minimum score', arr: SCORES, key: 'scoreIndex', fmt: formatScore, scale: ['OFF', '9.0'] });
    panel.appendChild(divider());
    makeSlider({ name: 'Minimum members', arr: MEMBERS, key: 'minMembersIndex', fmt: formatCount, scale: ['OFF', '3M'] });
    panel.appendChild(divider());
    makeSlider({ name: 'Maximum members', arr: MEMBERS, key: 'maxMembersIndex', fmt: formatCount, scale: ['OFF', '3M'] });
    panel.appendChild(divider());
    makeSlider({ name: 'Maximum episodes', arr: EPISODES, key: 'episodesIndex', fmt: v => (v ? String(v) : 'OFF'), scale: ['OFF', '100'] });
    panel.appendChild(divider());
    makeSlider({ name: 'Maximum total runtime', arr: RUNTIMES, key: 'runtimeIndex', fmt: formatRuntime, scale: ['OFF', '20h'] });
    panel.appendChild(divider());

    statusEl = document.createElement('div');
    statusEl.textContent = 'Ready';
    statusEl.style.cssText = 'min-height:18px;color:#789;font-size:11px;margin-bottom:8px';
    panel.appendChild(statusEl);

    const makeButton = (text, onClick) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = text;
      b.style.cssText = 'display:block;width:100%;box-sizing:border-box;margin:0 0 6px;padding:8px;border:1px solid rgba(255,255,255,.12);border-radius:5px;background:#27313a;color:#d8e0e8;font-size:11px;font-weight:700;cursor:pointer';
      b.addEventListener('click', onClick);
      panel.appendChild(b);
      return b;
    };

    makeButton('CLEAR ALL FILTERS', () => {
      state.genres.clear();
      state.types.clear();
      state.scoreIndex = 0;
      state.minMembersIndex = 0;
      state.maxMembersIndex = 0;
      state.episodesIndex = 0;
      state.runtimeIndex = 0;
      checkboxes.forEach(cb => { cb.checked = false; });
      sliderSyncs.forEach(s => s());
      updateButton();
      scheduleRefresh();
    });

    makeButton('CLEAR CACHE', () => {
      pruneCache(true);
      scheduleRefresh();
    });

    function collectSelection() {
      const tasks = [];
      document.querySelectorAll(CONTAINER_SELECTOR).forEach(box => {
        if (box.classList.contains(HIDDEN_CLASS)) return;
        const id = idFrom(box);
        if (!id) return;
        const a = box.querySelector('a[href]');
        let href = '';
        if (a) { try { href = new URL(a.getAttribute('href'), location.origin).href; } catch { href = a.getAttribute('href') || ''; } }
        const titleEl = box.querySelector('.anime-info a, .detail .title, .fl-l.score a, .title a, a.hoverinfo_trigger');
        const title = (titleEl?.getAttribute('title') || titleEl?.textContent || a?.textContent || '').trim();
        const cached = getCache(id) || {};
        const inline = inlineData(box);
        const hasInlineData = EXPORT_DATA_FIELDS.every(key => key in inline);

        tasks.push((async () => {
          let data = { ...cached, ...inline };
          if (!fresh(cached.at) && !hasInlineData) {
            pending++;
            updateStatus();
            try {
              const full = await getAnime(id);
              data = { ...full, ...inline };
            } catch (error) {
              console.warn('[MAL export]', id, error);
            } finally {
              pending--;
              updateStatus();
            }
          }
          const d = data;
          const totalRuntime = d.episodes != null && d.duration != null
            ? Math.round(d.episodes * d.duration * 100) / 100
            : null;
          return {
            id,
            title,
            url: href || `${location.origin}/anime/${id}`,
            score: d.score ?? null,
            members: d.members ?? null,
            episodes: d.episodes ?? null,
            duration: d.duration ?? null,
            totalRuntime,
            type: d.type ?? null,
            genres: Array.isArray(d.genres) ? d.genres : []
          };
        })());
      });
      return Promise.all(tasks);
    }

    let exporting = false;
    const exportButtons = [];

    async function downloadSelection(format) {
      if (exporting) return;
      exporting = true;
      exportButtons.forEach(b => { b.disabled = true; });
      try {
        const rows = await collectSelection();
        let content, filename;
        if (format === 'JSON') {
          content = JSON.stringify(rows, null, 2);
          filename = 'mal-selection.json';
        } else {
          const esc = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
          const header = ['id', 'title', 'url', 'score', 'members', 'episodes', 'duration', 'totalRuntime', 'type', 'genres'];
          content = [header.join(',')].concat(rows.map(r => [
            r.id, r.title, r.url, r.score, r.members, r.episodes, r.duration, r.totalRuntime, r.type, (r.genres || []).join(' | ')
          ].map(esc).join(','))).join('\r\n');
          filename = 'mal-selection.csv';
        }
        const blob = new Blob([content], { type: (format === 'JSON' ? 'application/json' : 'text/csv') + ';charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch (error) {
        console.warn('[MAL export]', error);
      } finally {
        exporting = false;
        exportButtons.forEach(b => { b.disabled = false; });
      }
    }
    exportButtons.push(
      makeButton('EXPORT SELECTION (CSV)', () => downloadSelection('CSV')),
      makeButton('EXPORT SELECTION (JSON)', () => downloadSelection('JSON'))
    );

    function updateButton() {
      const activeGroups =
        (state.genres.size ? 1 : 0) +
        (state.types.size ? 1 : 0) +
        (state.scoreIndex ? 1 : 0) +
        (state.minMembersIndex || state.maxMembersIndex ? 1 : 0) +
        (state.episodesIndex ? 1 : 0) +
        (state.runtimeIndex ? 1 : 0);
      button.textContent = activeGroups ? `FILTERS · ${activeGroups} ACTIVE` : 'FILTERS · OFF';
      button.style.background = activeGroups ? '#2e51a2' : '#445566';
    }

    button.addEventListener('click', () => {
      panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
    });

    updateButton();
    wrapper.append(panel, button);
    document.body.appendChild(wrapper);
    updateStatus();
  }

  pruneCache();
  createUI();
  scan();
  setInterval(updateStatus, 1000);

  new MutationObserver(() => {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      createUI();
      scan();
    }, 300);
  }).observe(document.body, { childList: true, subtree: true });
})();
