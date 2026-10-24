// ==UserScript==
// @name         Letterboxd - Country, Rating, Watched & Runtime Filters
// @namespace    letterboxd-custom-filters
// @version      5.6.1
// @description  Hide films by country, minimum Letterboxd rating, watched range (min & max) and maximum runtime. Export filtered results and their metadata to CSV or JSON.
// @author       Marco
// @match        https://letterboxd.com/*
// @updateURL    https://raw.githubusercontent.com/mromanode/GoingAlternative/main/userscripts/letterboxd-filters.user.js
// @downloadURL  https://raw.githubusercontent.com/mromanode/GoingAlternative/main/userscripts/letterboxd-filters.user.js
// @supportURL   https://github.com/mromanode/GoingAlternative/issues
// @homepageURL  https://github.com/mromanode/GoingAlternative
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  if (window.top !== window.self) return;

  const COUNTRIES = {
    india: 'India',
    thailand: 'Thailand',
    indonesia: 'Indonesia',
    malaysia: 'Malaysia',
    mexico: 'Mexico',
    japan: 'Japan',
    'south-korea': 'South Korea',
    usa: 'USA',
    canada: 'Canada'
  };

  const WATCHED = [
    0,
    3000,
    5000,
    10000,
    25000,
    50000,
    100000,
    250000,
    500000,
    1000000,
    2000000,
    5000000
  ];

  const RUNTIMES = [
    0,
    80,
    90,
    100,
    110,
    120,
    130,
    140,
    150
  ];

  const SETTINGS_KEY = 'lb-filter-v51-settings';
  const CACHE_PREFIX = 'lb-filter-v54:';
  const TTL = 24 * 60 * 60 * 1000;
  const MAX_CONCURRENT = 4;
  const MAX_WATCHED_FRAMES = 2;

  let active = 0;
  const queue = [];
  let watchedFrameActive = 0;
  const watchedFrameQueue = [];
  const watchedInFlight = new Map();

  let refreshTimer;
  let scanTimer;
  let statusEl;
  let filterRevision = 0;

  const defaults = {
    countries: Object.keys(COUNTRIES),
    rating: 0,
    watchedIndex: 0,
    maxWatchedIndex: 0,
    runtimeIndex: 0
  };

  function loadSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY));
      if (!saved) return { ...defaults };

      return {
        countries: Array.isArray(saved.countries)
          ? saved.countries.filter(c => c in COUNTRIES)
          : defaults.countries,
        rating: Math.max(0, Math.min(50, Number(saved.rating) || 0)),
        watchedIndex: Math.max(0, Math.min(WATCHED.length - 1, Number(saved.watchedIndex) || 0)),
        maxWatchedIndex: Math.max(0, Math.min(WATCHED.length - 1, Number(saved.maxWatchedIndex) || 0)),
        runtimeIndex: Math.max(0, Math.min(RUNTIMES.length - 1, Number(saved.runtimeIndex) || 0))
      };
    } catch {
      return { ...defaults };
    }
  }

  const saved = loadSettings();
  let blocked = new Set(saved.countries);
  let minRating = saved.rating;
  let watchedIndex = saved.watchedIndex;
  let maxWatchedIndex = saved.maxWatchedIndex;
  let runtimeIndex = saved.runtimeIndex;

  function saveSettings() {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        countries: [...blocked],
        rating: minRating,
        watchedIndex,
        maxWatchedIndex,
        runtimeIndex
      })
    );
  }

  function getCache(slug) {
    try {
      return JSON.parse(localStorage.getItem(CACHE_PREFIX + slug)) || {};
    } catch {
      return {};
    }
  }

  function setCache(slug, patch) {
    localStorage.setItem(CACHE_PREFIX + slug, JSON.stringify({ ...getCache(slug), ...patch }));
  }

  function fresh(timestamp) {
    return Number.isFinite(timestamp) && Date.now() - timestamp < TTL;
  }

  function slugFrom(element) {
    if (!element) return null;
    const dataElement = element.matches?.('[data-film-slug]') ? element : element.querySelector?.('[data-film-slug]');
    let slug = dataElement?.getAttribute('data-film-slug');
    if (slug) {
      slug = slug.replace(/^https?:\/\/letterboxd\.com\/film\//i, '').replace(/^\/film\//, '').replace(/^\/+|\/+$/g, '');
      if (slug) return slug;
    }
    const anchor = element.matches?.('a[href*="/film/"]') ? element : element.querySelector?.('a[href*="/film/"]');
    if (!anchor) return null;
    try {
      return new URL(anchor.href, location.origin).pathname.match(/^\/film\/([^/]+)/)?.[1] || null;
    } catch {
      return null;
    }
  }

  function containerFor(element) {
    return element.closest?.('li.poster-container, .poster-container') || element.closest?.('li') || element;
  }

  function formatCount(value) {
    if (!value) return 'OFF';
    if (value >= 1000000) {
      const n = value / 1000000;
      return (Number.isInteger(n) ? n : n.toFixed(1)) + 'M';
    }
    if (value >= 1000) {
      const n = value / 1000;
      return (Number.isInteger(n) ? n : n.toFixed(1)) + 'K';
    }
    return String(value);
  }

  function formatRuntime(minutes) {
    if (!minutes) return 'OFF';
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    if (hours && mins) return `${hours}h ${mins}m`;
    if (hours) return `${hours}h`;
    return `${mins}m`;
  }

  function parseWatchedCount(text) {
    if (!text) return null;
    const cleaned = String(text).replace(/&nbsp;/gi, ' ').replace(/\u00a0/g, ' ').replace(/,/g, '').trim();
    let match = cleaned.match(/Watched by\s+(\d+(?:\.\d+)?)\s*([KMB])?\s+members?/i) || cleaned.match(/(\d+(?:\.\d+)?)\s*([KMB])?/i);
    if (!match) return null;
    const number = Number(match[1]);
    if (!Number.isFinite(number)) return null;
    const suffix = (match[2] || '').toUpperCase();
    const multiplier = suffix === 'K' ? 1000 : suffix === 'M' ? 1000000 : suffix === 'B' ? 1000000000 : 1;
    return Math.round(number * multiplier);
  }

  function extractWatchedFromDocument(doc) {
    if (!doc) return null;
    const candidates = [...doc.querySelectorAll([
      'a.tooltip[href*="/members/"]',
      'li.filmstat-watches a',
      'a[href*="/members/"][data-original-title]',
      'a[href*="/members/"][title]',
      'a[href*="/members/"][aria-label]'
    ].join(','))];

    for (const el of candidates) {
      const texts = [el.getAttribute('data-original-title'), el.getAttribute('title'), el.getAttribute('aria-label'), el.textContent];
      for (const text of texts) {
        if (!text || !/watched by|members?/i.test(text)) continue;
        const value = parseWatchedCount(text);
        if (value !== null) return value;
      }
    }
    return null;
  }

  function extractWatchedFromHTML(html) {
    if (!html) return null;
    const match = html.match(/(?:data-original-title|title|aria-label)=["']([^"']*Watched by[^"']*members?[^"']*)["']/i);
    return match ? parseWatchedCount(match[1]) : null;
  }

  function extractCountries(root) {
    if (!root) return [];
    return [...new Set([...root.querySelectorAll('a[href*="/films/country/"]')].map(link => {
      try {
        return new URL(link.getAttribute('href'), location.origin).pathname.match(/\/films\/country\/([^/]+)/i)?.[1]?.toLowerCase() || null;
      } catch {
        return null;
      }
    }).filter(Boolean))];
  }

  function extractRuntime(doc) {
    const text = doc.body?.textContent || '';
    const match = text.match(/\b(\d{1,4})\s*mins\b\s*More at\b/i) || text.match(/\b(\d{1,4})\s*mins\b/i);
    return match ? Number(match[1]) : null;
  }

  async function fetchMainData(slug) {
    const response = await fetch(`${location.origin}/film/${slug}/`, { credentials: 'same-origin' });
    if (!response.ok) throw new Error(`film page HTTP ${response.status}`);
    const html = await response.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');

    let countries = [];
    const detailsTab = doc.querySelector('#tab-details');
    if (detailsTab) {
      countries = extractCountries(detailsTab);
    } else {
      const detailsResponse = await fetch(`${location.origin}/film/${slug}/details/`, { credentials: 'same-origin' });
      if (detailsResponse.ok) {
        const detailsDoc = new DOMParser().parseFromString(await detailsResponse.text(), 'text/html');
        countries = extractCountries(detailsDoc);
      }
    }

    const runtime = extractRuntime(doc);
    let watched = extractWatchedFromDocument(doc) ?? extractWatchedFromHTML(html);
    const patch = { countries, runtime, mainAt: Date.now() };
    if (watched !== null) {
      patch.watched = watched;
      patch.watchedAt = Date.now();
    }
    setCache(slug, patch);
    return { countries, runtime, watched };
  }

  async function fetchRating(slug) {
    const response = await fetch(`${location.origin}/csi/film/${slug}/rating-histogram/`, { credentials: 'same-origin' });
    if (!response.ok) throw new Error(`rating HTTP ${response.status}`);
    const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
    let rating = null;
    const ratingElement = doc.querySelector([
      '.average-rating [data-original-title]',
      '.average-rating [title]',
      '[data-original-title*="Weighted average"]',
      '[title*="Weighted average"]'
    ].join(','));
    const tooltip = ratingElement?.getAttribute('data-original-title') || ratingElement?.getAttribute('title') || '';
    const exactMatch = tooltip.match(/Weighted average of\s*([0-5](?:\.\d+)?)/i);
    if (exactMatch) rating = Number(exactMatch[1]);
    if (rating === null) {
      const fallbackMatch = (doc.querySelector('.display-rating, .average-rating')?.textContent || '').match(/([0-5](?:\.\d+)?)/);
      if (fallbackMatch) rating = Number(fallbackMatch[1]);
    }
    setCache(slug, { rating, ratingAt: Date.now() });
    return rating;
  }

  function readWatchedWithHiddenFrame(slug) {
    return new Promise(resolve => {
      const frame = document.createElement('iframe');
      frame.setAttribute('aria-hidden', 'true');
      frame.tabIndex = -1;
      frame.style.cssText = 'position:fixed;left:-10000px;top:-10000px;width:1px;height:1px;visibility:hidden;pointer-events:none;border:0;';
      let finished = false;
      let pollTimer = null;

      const finish = value => {
        if (finished) return;
        finished = true;
        clearInterval(pollTimer);
        clearTimeout(timeoutTimer);
        try { frame.remove(); } catch {}
        if (value !== null && Number.isFinite(value)) {
          setCache(slug, { watched: value, watchedAt: Date.now() });
        }
        resolve(value);
      };

      const timeoutTimer = setTimeout(() => finish(null), 8000);
      frame.addEventListener('load', () => {
        let attempts = 0;
        pollTimer = setInterval(() => {
          attempts++;
          try {
            const val = extractWatchedFromDocument(frame.contentDocument);
            if (val !== null) return finish(val);
          } catch {}
          if (attempts >= 50) finish(null);
        }, 120);
      });
      frame.addEventListener('error', () => finish(null));
      frame.src = `${location.origin}/film/${slug}/`;
      document.body.appendChild(frame);
    });
  }

  function pumpWatchedFrames() {
    while (watchedFrameActive < MAX_WATCHED_FRAMES && watchedFrameQueue.length) {
      const item = watchedFrameQueue.shift();
      watchedFrameActive++;
      updateStatus();
      item.task().then(item.resolve, item.reject).finally(() => {
        watchedFrameActive--;
        updateStatus();
        pumpWatchedFrames();
      });
    }
    updateStatus();
  }

  function enqueueWatchedFrame(task) {
    return new Promise((resolve, reject) => {
      watchedFrameQueue.push({ task, resolve, reject });
      updateStatus();
      pumpWatchedFrames();
    });
  }

  function getWatchedCount(slug) {
    const cache = getCache(slug);
    if (Number.isFinite(cache.watched) && fresh(cache.watchedAt)) return Promise.resolve(cache.watched);
    if (watchedInFlight.has(slug)) return watchedInFlight.get(slug);
    const promise = enqueueWatchedFrame(() => readWatchedWithHiddenFrame(slug)).finally(() => watchedInFlight.delete(slug));
    watchedInFlight.set(slug, promise);
    return promise;
  }

  function currentFilters() {
    return {
      revision: filterRevision,
      countries: new Set(blocked),
      minRating: minRating / 10,
      minWatched: WATCHED[watchedIndex],
      maxWatched: WATCHED[maxWatchedIndex],
      maxRuntime: RUNTIMES[runtimeIndex]
    };
  }

  async function filmData(slug, filters, loadAll = false) {
    let cache = getCache(slug);
    let countries = Array.isArray(cache.countries) ? cache.countries : [];
    let runtime = cache.runtime ?? null;
    let rating = cache.rating ?? null;
    let watched = Number.isFinite(cache.watched) && fresh(cache.watchedAt) ? cache.watched : null;
    let mainOK = true;
    let ratingOK = true;

    const needMain = loadAll || filters.countries.size > 0 || filters.maxRuntime > 0 || filters.minWatched > 0 || filters.maxWatched > 0;
    const needRating = loadAll || filters.minRating > 0;

    if (needMain && !fresh(cache.mainAt)) {
      try {
        const main = await fetchMainData(slug);
        countries = main.countries;
        runtime = main.runtime;
        if (main.watched !== null) watched = main.watched;
      } catch (err) {
        mainOK = false;
      }
    }

    if (needRating && !fresh(cache.ratingAt)) {
      try {
        rating = await fetchRating(slug);
      } catch (err) {
        ratingOK = false;
      }
    }

    if ((loadAll || filters.minWatched > 0 || filters.maxWatched > 0) && watched === null) {
      try {
        watched = await getWatchedCount(slug);
      } catch (err) {
        watched = null;
      }
    }

    return { countries, runtime, rating, watched, mainOK, ratingOK };
  }

  function mustHide(data, filters) {
    if (filters.countries.size > 0 && data.mainOK && data.countries.some(c => filters.countries.has(c))) return true;
    if (filters.minRating > 0 && data.ratingOK && (data.rating === null || data.rating < filters.minRating)) return true;
    if (filters.minWatched > 0 && data.watched !== null && data.watched < filters.minWatched) return true;
    if (filters.maxWatched > 0 && data.watched !== null && data.watched > filters.maxWatched) return true;
    if (filters.maxRuntime > 0 && data.mainOK && data.runtime !== null && data.runtime > filters.maxRuntime) return true;
    return false;
  }

  function show(element) {
    if (element.dataset.lbFilterHidden === '1') {
      element.style.display = '';
      element.dataset.lbFilterHidden = '0';
    }
  }

  function hide(element) {
    element.style.display = 'none';
    element.dataset.lbFilterHidden = '1';
  }

  function updateStatus() {
    if (!statusEl) return;
    const pending = active + queue.length + watchedFrameActive + watchedFrameQueue.length;
    statusEl.textContent = pending ? `Checking ${pending} film${pending === 1 ? '' : 's'}…` : 'Ready';
  }

  function pump() {
    while (active < MAX_CONCURRENT && queue.length) {
      const job = queue.shift();
      active++;
      updateStatus();
      job().catch(console.error).finally(() => {
        active--;
        updateStatus();
        pump();
      });
    }
    updateStatus();
  }

  function enqueue(job) {
    queue.push(job);
    updateStatus();
    pump();
  }

  function enqueueResult(job) {
    return new Promise((resolve, reject) => {
      enqueue(async () => {
        try {
          resolve(await job());
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  function filtersOff() {
    return blocked.size === 0 && minRating === 0 && watchedIndex === 0 && maxWatchedIndex === 0 && runtimeIndex === 0;
  }

  function processPoster(element) {
    const box = containerFor(element);
    const slug = slugFrom(box) || slugFrom(element);
    if (!box || !slug) return;
    if (filtersOff()) return void show(box);
    if (box.dataset.lbFilterChecking === '1') return;

    const filters = currentFilters();
    box.dataset.lbFilterChecking = '1';

    enqueue(async () => {
      try {
        if (filters.revision !== filterRevision) return;
        const data = await filmData(slug, filters);
        if (filters.revision !== filterRevision) return;
        mustHide(data, filters) ? hide(box) : show(box);
      } finally {
        box.dataset.lbFilterChecking = '0';
        if (filters.revision !== filterRevision) {
          setTimeout(() => processPoster(element), 0);
        }
      }
    });
  }

  function scan() {
    const seen = new Set();
    document.querySelectorAll('.poster-container, .film-poster, [data-film-slug]').forEach(el => {
      const box = containerFor(el);
      if (!box || seen.has(box)) return;
      seen.add(box);
      processPoster(el);
    });
  }

  function refresh() {
    document.querySelectorAll('[data-lb-filter-hidden="1"]').forEach(show);
    scan();
  }

  function scheduleRefresh() {
    filterRevision++;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      saveSettings();
      refresh();
    }, 180);
  }

  function createUI() {
    if (document.getElementById('lb-filter-panel')) return;

    const wrapper = document.createElement('div');
    wrapper.id = 'lb-filter-panel';
    Object.assign(wrapper.style, {
      position: 'fixed',
      top: '50px',
      right: '12px',
      zIndex: '999999',
      font: '13px Arial, sans-serif'
    });

    const button = document.createElement('button');
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
      width: '250px',
      boxSizing: 'border-box',
      maxHeight: 'calc(100vh - 70px)',
      overflowY: 'auto',
      marginTop: '6px',
      padding: '14px',
      background: '#14181c',
      color: '#d8e0e8',
      border: '1px solid rgba(255,255,255,.14)',
      borderRadius: '7px',
      boxShadow: '0 6px 22px rgba(0,0,0,.55)'
    });

    const title = document.createElement('div');
    title.textContent = 'LETTERBOXD FILTERS';
    Object.assign(title.style, { color: '#fff', fontSize: '12px', fontWeight: '800', letterSpacing: '.08em', marginBottom: '12px' });
    panel.appendChild(title);

    const makeSectionLabel = text => {
      const el = document.createElement('div');
      el.textContent = text;
      Object.assign(el.style, { color: '#9ab', fontSize: '11px', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '.05em', margin: '10px 0 7px' });
      return el;
    };

    const makeDivider = () => {
      const el = document.createElement('div');
      el.style.cssText = 'border-top:1px solid rgba(255,255,255,.10);margin:12px 0';
      return el;
    };

    panel.appendChild(makeSectionLabel('Hide countries'));
    Object.entries(COUNTRIES).forEach(([slug, name]) => {
      const row = document.createElement('label');
      row.style.cssText = 'display:flex;align-items:center;gap:8px;margin:7px 0;cursor:pointer;user-select:none';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = blocked.has(slug);
      checkbox.style.accentColor = '#00e054';
      checkbox.addEventListener('change', () => {
        checkbox.checked ? blocked.add(slug) : blocked.delete(slug);
        updateButton();
        scheduleRefresh();
      });
      const text = document.createElement('span');
      text.textContent = name;
      row.append(checkbox, text);
      panel.appendChild(row);
    });

    panel.appendChild(makeDivider());

    const makeSlider = ({ name, min, max, value, valueText, onInput, scale }) => {
      const heading = document.createElement('div');
      heading.style.cssText = 'display:flex;justify-content:space-between;align-items:baseline;margin-bottom:5px';
      const label = document.createElement('strong');
      label.textContent = name;
      label.style.color = '#fff';
      const output = document.createElement('span');
      output.style.cssText = 'color:#00e054;font-weight:700';
      heading.append(label, output);
      panel.appendChild(heading);

      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = String(min);
      slider.max = String(max);
      slider.step = '1';
      slider.value = String(value);
      slider.style.cssText = 'display:block;width:100%;box-sizing:border-box;margin:0;accent-color:#00e054';
      panel.appendChild(slider);

      const scaleElement = document.createElement('div');
      scaleElement.style.cssText = 'display:flex;justify-content:space-between;margin-top:1px;color:#678;font-size:10px';
      scale.forEach(t => {
        const span = document.createElement('span');
        span.textContent = t;
        scaleElement.appendChild(span);
      });
      panel.appendChild(scaleElement);

      const updateOutput = () => { output.textContent = valueText(Number(slider.value)); };
      slider.addEventListener('input', () => {
        onInput(Number(slider.value));
        updateOutput();
        updateButton();
        scheduleRefresh();
      });
      updateOutput();
      return slider;
    };

    const ratingSlider = makeSlider({
      name: 'Minimum rating',
      min: 0,
      max: 50,
      value: minRating,
      valueText: val => val === 0 ? 'OFF' : (val / 10).toFixed(1),
      onInput: val => { minRating = val; },
      scale: ['OFF', '5.0']
    });

    panel.appendChild(makeDivider());

    const watchedSlider = makeSlider({
      name: 'Minimum watched',
      min: 0,
      max: WATCHED.length - 1,
      value: watchedIndex,
      valueText: val => formatCount(WATCHED[val]),
      onInput: val => { watchedIndex = val; },
      scale: ['OFF', '5M']
    });

    panel.appendChild(makeDivider());

    const maxWatchedSlider = makeSlider({
      name: 'Maximum watched',
      min: 0,
      max: WATCHED.length - 1,
      value: maxWatchedIndex,
      valueText: val => formatCount(WATCHED[val]),
      onInput: val => { maxWatchedIndex = val; },
      scale: ['OFF', '5M']
    });

    panel.appendChild(makeDivider());

    const runtimeSlider = makeSlider({
      name: 'Maximum runtime',
      min: 0,
      max: RUNTIMES.length - 1,
      value: runtimeIndex,
      valueText: val => formatRuntime(RUNTIMES[val]),
      onInput: val => { runtimeIndex = val; },
      scale: ['OFF', '2h 30m']
    });

    panel.appendChild(makeDivider());

    statusEl = document.createElement('div');
    statusEl.textContent = 'Ready';
    statusEl.style.cssText = 'min-height:18px;color:#789;font-size:11px;margin-bottom:8px';
    panel.appendChild(statusEl);

    const clearButton = document.createElement('button');
    clearButton.textContent = 'CLEAR ALL FILTERS';
    clearButton.style.cssText = 'display:block;width:100%;box-sizing:border-box;margin:0;padding:8px;border:1px solid rgba(255,255,255,.12);border-radius:5px;background:#27313a;color:#d8e0e8;font-size:11px;font-weight:700;cursor:pointer';
    clearButton.addEventListener('click', () => {
      blocked.clear();
      minRating = 0;
      watchedIndex = 0;
      maxWatchedIndex = 0;
      runtimeIndex = 0;
      panel.querySelectorAll('input[type="checkbox"]').forEach(cb => { cb.checked = false; });
      ratingSlider.value = '0';
      watchedSlider.value = '0';
      maxWatchedSlider.value = '0';
      runtimeSlider.value = '0';
      panel.querySelectorAll('input[type="range"]').forEach(s => s.dispatchEvent(new Event('input')));
      saveSettings();
      updateButton();
      refresh();
    });
    panel.appendChild(clearButton);

    const exportButtons = [];
    let exporting = false;

    function collectSelection() {
      const tasks = [];
      const seen = new Set();
      const filters = currentFilters();
      document.querySelectorAll('.poster-container, .film-poster, [data-film-slug]').forEach(el => {
        const box = containerFor(el);
        if (!box || seen.has(box)) return;
        seen.add(box);
        if (box.dataset.lbFilterHidden === '1') return;
        const slug = slugFrom(box) || slugFrom(el);
        if (!slug) return;
        const img = box.querySelector('img');
        const anchor = box.querySelector('a[href*="/film/"]');
        const title = (img?.getAttribute('alt') || box.querySelector('[data-film-name]')?.getAttribute('data-film-name') || anchor?.textContent || '').trim();
        let href = '';
        if (anchor) { try { href = new URL(anchor.href, location.origin).href; } catch { href = anchor.href; } }

        tasks.push((async () => {
          const cached = getCache(slug);
          let data = cached;
          try {
            data = await enqueueResult(() => filmData(slug, filters, true));
          } catch (error) {
            console.warn('[Letterboxd export]', slug, error);
          }
          const c = { ...cached, ...data };
          return {
            slug,
            title,
            url: href || `${location.origin}/film/${slug}/`,
            countries: Array.isArray(c.countries) ? c.countries : [],
            runtime: c.runtime ?? null,
            rating: c.rating ?? null,
            watched: c.watched ?? null
          };
        })());
      });
      return Promise.all(tasks);
    }

    async function downloadSelection(format) {
      if (exporting) return;
      exporting = true;
      exportButtons.forEach(b => { b.disabled = true; });
      try {
        const rows = await collectSelection();
        let content, filename;
        if (format === 'JSON') {
          content = JSON.stringify(rows, null, 2);
          filename = 'letterboxd-selection.json';
        } else {
          const esc = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
          const header = ['slug', 'title', 'url', 'runtime', 'rating', 'watched', 'countries'];
          content = [header.join(',')].concat(rows.map(r => [
            r.slug, r.title, r.url, r.runtime, r.rating, r.watched, (r.countries || []).join(' | ')
          ].map(esc).join(','))).join('\r\n');
          filename = 'letterboxd-selection.csv';
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
        console.warn('[Letterboxd export]', error);
      } finally {
        exporting = false;
        exportButtons.forEach(b => { b.disabled = false; });
      }
    }

    const makeExportButton = (text, format) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = text;
      b.style.cssText = 'display:block;width:100%;box-sizing:border-box;margin:6px 0 0;padding:8px;border:1px solid rgba(255,255,255,.12);border-radius:5px;background:#27313a;color:#d8e0e8;font-size:11px;font-weight:700;cursor:pointer';
      b.addEventListener('click', () => downloadSelection(format));
      panel.appendChild(b);
      exportButtons.push(b);
    };

    makeExportButton('EXPORT SELECTION (CSV)', 'CSV');
    makeExportButton('EXPORT SELECTION (JSON)', 'JSON');

    function updateButton() {
      const activeGroups =
        (blocked.size > 0 ? 1 : 0) +
        (minRating > 0 ? 1 : 0) +
        (watchedIndex > 0 || maxWatchedIndex > 0 ? 1 : 0) +
        (runtimeIndex > 0 ? 1 : 0);

      button.textContent = activeGroups ? `FILTERS · ${activeGroups} ACTIVE` : 'FILTERS · OFF';
      button.style.background = activeGroups ? '#00a11b' : '#445566';
    }

    button.addEventListener('click', () => {
      panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
    });

    updateButton();
    wrapper.append(button, panel);
    document.body.appendChild(wrapper);
    updateStatus();
  }

  createUI();
  scan();

  new MutationObserver(() => {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      createUI();
      scan();
    }, 250);
  }).observe(document.body, { childList: true, subtree: true });
})();
