const el = (id) => document.getElementById(id);

const GROUP_ORDER = ['Broad', 'Sectoral', 'Thematic', 'Industry'];

const GROUP_BLURB = {
  Broad: 'Benchmarks to measure everything else against.',
  Sectoral: 'NSE sectoral indices — the classic sector view.',
  Thematic: 'Cross-sector themes such as defence, railways or manufacturing.',
  Industry: 'Every industry in the NIFTY 500, including ones with no index of their own.',
};

let state = {
  data: null,
  filter: 'all',
  sortBy: 'rs',
  search: '',
  colourStep: 5,
  period: '1M',
  activeSector: null,
  stockSearch: '',
  stockFilter: 'all',
  stockSort: 'strength',
  capFilter: 'all',
  watchOnly: false,
  rrgView: 'board',
  selected: [],        // indexNames chosen for comparison
  selectedStocks: [],  // symbols chosen for comparison
  lastView: 'overview',
};

let stockBook = null;    // {symbol: {returns, rs, rangePos, ...}} from /api/stocks

/* ---------------------------------------------------------------- watchlists
 * Several named lists rather than one, each holding sectors and stocks, kept in
 * the browser so nothing has to be set up server-side. Research is only worth
 * the effort if what you found is still there next week.
 */

const WATCHLIST_KEY = 'watchlists';

function loadWatchlists() {
  try {
    const raw = JSON.parse(localStorage.getItem(WATCHLIST_KEY));
    if (raw && Array.isArray(raw.lists) && raw.lists.length) return raw;
  } catch (e) { /* corrupt or absent: start fresh */ }
  return { active: 0, lists: [{ name: 'My list', sectors: [], stocks: [] }] };
}

function saveWatchlists() {
  localStorage.setItem(WATCHLIST_KEY, JSON.stringify(watchlists));
}

let watchlists = loadWatchlists();

const activeList = () => watchlists.lists[watchlists.active] || watchlists.lists[0];

function inWatchlist(kind, key) {
  const list = activeList();
  return (kind === 'stock' ? list.stocks : list.sectors).includes(key);
}

/** Present in any list, not just the active one — worth showing on a card. */
function watchedAnywhere(kind, key) {
  return watchlists.lists.some(l => (kind === 'stock' ? l.stocks : l.sectors).includes(key));
}

function toggleWatch(kind, key) {
  const list = activeList();
  const bucket = kind === 'stock' ? list.stocks : list.sectors;
  const i = bucket.indexOf(key);
  if (i >= 0) bucket.splice(i, 1);
  else bucket.push(key);
  saveWatchlists();
  renderWatchBar();
  renderWatchStocks();
  renderSections();
  if (state.activeSector) renderDetail();
}

const stockBy = (symbol) =>
  stockBook && stockBook.stocks ? stockBook.stocks[symbol] || null : null;

const stockRs = (symbol) => {
  const s = stockBy(symbol);
  return s ? (s.rs || {})[state.period] ?? null : null;
};

const stockRet = (symbol) => {
  const s = stockBy(symbol);
  return s ? (s.returns || {})[state.period] ?? null : null;
};

/*
 * Ranking a sector's names for "which one is actually breaking out".
 *
 * Two things have to be true at once, so they are multiplied rather than added:
 * a stock has to be beating the market *and* be up near its own 52-week high.
 * Either alone is a common and much weaker setup -- a laggard bouncing off the
 * floor beats the market for a week, and a stock can sit at its high while the
 * whole market runs harder. A high set recently counts for more than one set
 * eleven months ago, which is the difference between breaking out and drifting.
 */
function stockStrength(symbol) {
  const s = stockBy(symbol);
  if (!s) return null;

  const rs = (s.rs || {})[state.period];
  const range = s.rangePos;
  if (rs === null || rs === undefined || range === null || range === undefined) return null;

  const beating = Math.max(0, Math.min(rs, 40)) / 40;      // 0..1
  const nearHigh = Math.max(0, Math.min(range, 100)) / 100; // 0..1

  let freshness = 0.6;
  if (s.daysSinceHigh !== null && s.daysSinceHigh !== undefined) {
    freshness = s.daysSinceHigh <= 10 ? 1 : s.daysSinceHigh <= 45 ? 0.85 : 0.6;
  }

  return Math.round(beating * nearHigh * freshness * 100);
}

// The signal: how far a sector's return sits above or below the benchmark's over
// the selected window. Same reading as two lines on one same-% chart.
const rsOf = (s) => (s.rs || {})[state.period] ?? null;
const retOf = (s) => (s.returns || {})[state.period] ?? null;
const benchmarkReturn = () =>
  state.data && state.data.benchmark ? state.data.benchmark.returns[state.period] ?? null : null;

/* ---------------------------------------------------------------- theming */

const root = document.documentElement;
if (localStorage.getItem('theme') === 'light') {
  root.setAttribute('data-theme', 'light');
  el('themeToggle').textContent = '☀️';
}
el('themeToggle').addEventListener('click', () => {
  const goingLight = root.getAttribute('data-theme') !== 'light';
  if (goingLight) root.setAttribute('data-theme', 'light');
  else root.removeAttribute('data-theme');
  el('themeToggle').textContent = goingLight ? '☀️' : '🌙';
  localStorage.setItem('theme', goingLight ? 'light' : 'dark');
  render();
});

const isLight = () => root.getAttribute('data-theme') === 'light';

/* ------------------------------------------------------------ colour scale
 * One band per `colourStep` percent, shading from dark red through yellow to
 * dark green. Nothing is hard-coded to a fixed number of levels: change the
 * step and the whole scale re-bands itself.
 */

const MAX_BAND = 4;   // bands each side before the colour saturates

function bandOf(pct, step = state.colourStep) {
  if (pct === null || pct === undefined) return null;
  const raw = Math.trunc(pct / step);
  return Math.max(-MAX_BAND, Math.min(MAX_BAND, raw));
}

function bandColour(band) {
  if (band === null) return { fg: 'var(--text-dim)', bg: 'transparent', border: 'var(--border)' };

  const t = band / MAX_BAND;              // -1 .. 1
  const light = isLight();

  // Hue sweeps red (0) -> yellow (50) -> green (145).
  let hue, lightness;
  if (t >= 0) {
    hue = 50 + t * 95;
    lightness = light ? 42 - t * 14 : 62 - t * 20;
  } else {
    hue = 50 + t * 50;
    lightness = light ? 46 + t * 6 : 66 + t * 8;
  }
  const sat = light ? 72 : 68;

  return {
    fg: `hsl(${hue} ${sat}% ${lightness}%)`,
    bg: `hsl(${hue} ${sat}% ${lightness}% / ${light ? 0.13 : 0.16})`,
    border: `hsl(${hue} ${sat}% ${lightness}%)`,
  };
}

function colourFor(pct) {
  return bandColour(bandOf(pct));
}

function bandLabel(band, step) {
  if (band === null) return 'no data';
  if (band === MAX_BAND) return `≥ +${MAX_BAND * step}%`;
  if (band === -MAX_BAND) return `≤ ${-MAX_BAND * step}%`;
  if (band === 0) return `±${step}%`;
  const edge = band * step;
  return band > 0 ? `+${edge}%` : `${edge}%`;
}

function renderScaleLegend() {
  const step = state.colourStep;
  const bands = [];
  for (let b = MAX_BAND; b >= -MAX_BAND; b--) bands.push(b);
  el('scaleLegend').innerHTML = bands.map(b => {
    const c = bandColour(b);
    return `<span class="scale-chip" style="background:${c.bg};color:${c.fg};border-color:${c.border}">
      ${bandLabel(b, step)}
    </span>`;
  }).join('');
}

/* ----------------------------------------------------------------- helpers */

function fmt(n, digits = 2) {
  if (n === null || n === undefined) return '—';
  return n.toLocaleString('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function signedPct(n) {
  if (n === null || n === undefined) return '—';
  return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
}

function sectorBy(indexName) {
  return state.data ? state.data.sectors.find(s => s.indexName === indexName) : null;
}

function showStatus(message, kind) {
  const bar = el('statusBar');
  bar.textContent = message;
  bar.className = 'status-bar' + (kind ? ' ' + kind : '');
  if (kind === 'success') setTimeout(() => bar.classList.add('hidden'), 4000);
}

/* ------------------------------------------------------------ data loading */

async function loadCached() {
  // Standalone snapshot builds inline the data and have no server to talk to.
  if (window.EMBEDDED_DATA) {
    applyData(window.EMBEDDED_DATA);
    el('statusBar').classList.add('hidden');
    return;
  }
  try {
    const res = await fetch('/api/sectors');
    if (res.status === 404) {
      el('emptyState').classList.remove('hidden');
      showStatus("No data cached yet — click 'Update Data' to fetch live figures from NSE.", null);
      return;
    }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    applyData(await res.json());
    el('statusBar').classList.add('hidden');
  } catch (e) {
    showStatus('Could not load cached data: ' + e.message, 'error');
  }
}

async function refreshData() {
  const btn = el('refreshBtn');
  if (window.EMBEDDED_DATA) {
    showStatus('This is a standalone snapshot. Run "python app.py" and open '
      + 'http://127.0.0.1:5000 to pull fresh data from NSE.', 'error');
    return;
  }
  btn.disabled = true;
  btn.classList.add('loading');
  showStatus('Fetching latest data from NSE… this usually takes a minute.', null);

  try {
    const res = await fetch('/api/refresh', { method: 'POST' });
    const body = await res.json();
    if (!res.ok) throw new Error(body.message || body.error || 'Refresh failed');
    applyData(body.data);
    showStatus('Data updated successfully from NSE.', 'success');
  } catch (e) {
    showStatus('Update failed: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.classList.remove('loading');
  }
}

function applyData(data) {
  state.data = data;
  el('emptyState').classList.add('hidden');
  el('marketDate').textContent = 'Market date: ' + (data.bhavDate || '—');
  el('updatedAt').textContent = 'Updated ' + new Date(data.updatedAt).toLocaleString('en-IN');

  const periods = data.periods || ['1M'];
  if (!periods.includes(state.period)) state.period = data.defaultPeriod || periods[0];
  el('periodSelect').innerHTML = periods
    .map(p => `<option value="${p}" ${p === state.period ? 'selected' : ''}>${p}</option>`)
    .join('');
  if (data.benchmark) el('bmName').textContent = data.benchmark.name;
  renderTicker();
  renderChanges();
  renderFreshness();

  // Drop selections that no longer exist.
  state.selected = state.selected.filter(sectorBy);

  // Same for starred sectors, so a retired index stops inflating the watchlist
  // count. Guarded on a full payload -- a partial fetch must not empty a list.
  if (data.sectors && data.sectors.length > 50) {
    const live = new Set(data.sectors.map(s => s.indexName));
    let pruned = false;
    for (const l of watchlists.lists) {
      const kept = l.sectors.filter(n => live.has(n));
      if (kept.length !== l.sectors.length) { l.sectors = kept; pruned = true; }
    }
    if (pruned) { saveWatchlists(); renderWatchBar(); }
  }

  render();
  if (state.activeSector) {
    const fresh = sectorBy(state.activeSector.indexName);
    if (fresh) { state.activeSector = fresh; renderDetail(); }
  } else {
    restoreFromUrl();
  }
}

/* -------------------------------------------------------------- rendering */

/**
 * The stocks in the active list.
 *
 * Starring a stock used to file it somewhere with no way back to it: the list
 * filter only trimmed the sector grid, so a starred name was only visible if you
 * happened to open the sector it belongs to.
 */
let watchShut = localStorage.getItem('watchCollapsed') === '1';

function toggleWatchStocks() {
  watchShut = !watchShut;
  localStorage.setItem('watchCollapsed', watchShut ? '1' : '0');
  renderWatchStocks();
}

function renderWatchStocks() {
  const box = el('watchStocks');
  const list = activeList();

  if (!list.stocks.length) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');

  // The table can run long enough to bury the sector grid, so it folds away
  // like the grid's own sections do, and remembers the choice.
  box.classList.toggle('collapsed', watchShut);
  el('watchStocksToggle').setAttribute('aria-expanded', String(!watchShut));

  el('watchStocksName').textContent = list.name;
  el('watchRetHead').textContent = `${state.period} return`;
  el('watchRsHead').textContent = `vs bench (${state.period})`;

  const rows = list.stocks
    .map(symbol => ({ symbol, s: stockBy(symbol) }))
    .sort((a, b) => (stockStrength(b.symbol) ?? -1) - (stockStrength(a.symbol) ?? -1));

  el('watchStocksCount').textContent =
    `${rows.length} stock${rows.length === 1 ? '' : 's'}`;

  el('watchStockBody').innerHTML = rows.map(({ symbol, s }) => {
    if (!s) {
      const why = stockBook ? 'not in the current universe' : 'loading…';
      return `<tr><td class="pick-cell">
          <button class="watch-star on" data-watch-stock="${symbol}" title="Remove">★</button>
        </td><td class="sym">${symbol}</td>
        <td colspan="9" class="dim">${why}</td></tr>`;
    }
    const c = colourFor(s.pChange);
    const rs = (s.rs || {})[state.period] ?? null;
    const ret = (s.returns || {})[state.period] ?? null;
    const rsC = colourFor(rs);
    const fh = colourFor(s.fromHigh === null ? null : s.fromHigh + 5);
    const score = stockStrength(symbol);

    return `
      <tr class="${s.nearHigh ? 'near-high' : ''}" style="border-left:3px solid ${c.border}">
        <td class="pick-cell">
          <button class="watch-star on" data-watch-stock="${symbol}" title="Remove from list">★</button>
        </td>
        <td class="sym">
          ${symbol}${s.nearHigh ? ' <span class="near-flag">⚡</span>' : ''}
          ${score !== null ? `<span class="score">${score}</span>` : ''}
        </td>
        <td>${s.company}</td>
        <td class="right">${fmt(s.close)}</td>
        <td class="pchange" style="color:${c.fg}">${signedPct(s.pChange)}</td>
        <td class="right">${signedPct(ret)}</td>
        <td class="right" style="color:${rsC.fg};font-weight:700">${signedPct(rs)}</td>
        <td class="right">${s.rangePos === null || s.rangePos === undefined ? '—' : s.rangePos + '%'}</td>
        <td class="right" style="color:${fh.fg};font-weight:700">${signedPct(s.fromHigh)}</td>
        ${maCell(s)}
        <td class="dim">${s.capBand || '—'}</td>
      </tr>`;
  }).join('');

  el('watchStockBody').querySelectorAll('.watch-star').forEach(btn => {
    btn.addEventListener('click', () => toggleWatch('stock', btn.dataset.watchStock));
  });
}

function renderWatchBar() {
  const select = el('watchSelect');
  select.innerHTML = watchlists.lists
    .map((l, i) => `<option value="${i}" ${i === watchlists.active ? 'selected' : ''}>${l.name}</option>`)
    .join('');

  const list = activeList();
  const total = list.sectors.length + list.stocks.length;
  el('watchCount').textContent = total
    ? `${list.sectors.length} sectors · ${list.stocks.length} stocks`
    : 'empty — star a sector or stock to add it';

  el('watchDelete').disabled = watchlists.lists.length < 2;
  el('watchOnly').classList.toggle('active', state.watchOnly);
  el('watchOnly').setAttribute('aria-pressed', String(state.watchOnly));
}

function render() {
  renderWatchBar();
  renderWatchStocks();
  renderRrg();
  renderBenchmarkStrip();
  renderScaleLegend();
  renderSections();
  renderTray();
}

function renderBenchmarkStrip() {
  const bm = state.data.benchmark;
  const r = benchmarkReturn();
  const node = el('bmReturn');
  if (r === null) { node.textContent = 'no data for this window'; node.style.color = ''; }
  else {
    node.textContent = `${bm.name} ${signedPct(r)} over ${state.period}`;
    node.style.color = colourFor(r).fg;
  }

  // Where the benchmark itself sits in its 52-week range decides whether a
  // sector at its own high is genuinely leading or just moving with the market.
  const rp = bm.rangePos;
  el('bmRange').textContent = rp === null || rp === undefined
    ? ''
    : `· ${bm.name} is ${rp}% up its own 52-week range (${signedPct(bm.fromHigh)} from its high)`;
}


/**
 * Every typed word has to appear somewhere in the name or the index name.
 *
 * Word-by-word rather than one substring, so order and spacing stop mattering:
 * "defence india", "india  defence" and "nifty defence" all find the same
 * sector, which a plain includes() would not.
 */
function matchesSearch(sector, query) {
  const haystack = `${sector.name} ${sector.indexName} ${sector.group}`.toLowerCase();
  return query.split(/\s+/).filter(Boolean).every(word => haystack.includes(word));
}

function visibleSectors() {
  if (!state.data) return [];
  return state.data.sectors.filter(s => {
    const rs = rsOf(s);
    if (state.filter === 'bull' && !(rs > 0)) return false;
    if (state.filter === 'bear' && !(rs < 0)) return false;
    if (state.filter === 'breakout' && !(s.lead && s.lead.breakingOut)) return false;
    if (state.watchOnly && !inWatchlist('sector', s.indexName)) return false;
    if (state.search && !matchesSearch(s, state.search)) return false;
    return true;
  });
}

function sortSectors(list) {
  if (state.sortBy === 'name') return [...list].sort((a, b) => a.name.localeCompare(b.name));
  const get = state.sortBy === 'ret' ? retOf : rsOf;
  return [...list].sort((a, b) => {
    const av = get(a), bv = get(b);
    if (av === null || av === undefined) return 1;
    if (bv === null || bv === undefined) return -1;
    return bv - av;
  });
}

/* Sections collapse so the page opens as an index rather than a wall of cards.
   Which ones are open is remembered. */
function collapsedGroups() {
  try {
    const raw = JSON.parse(localStorage.getItem('collapsedGroups'));
    if (Array.isArray(raw)) return new Set(raw);
  } catch (e) { /* fall through */ }
  return new Set(GROUP_ORDER);          // start closed
}

let collapsed = collapsedGroups();

function toggleGroup(group) {
  if (collapsed.has(group)) collapsed.delete(group);
  else collapsed.add(group);
  localStorage.setItem('collapsedGroups', JSON.stringify([...collapsed]));
  renderSections();
}

function renderSections() {
  const container = el('sectionsContainer');
  if (!state.data) { container.innerHTML = ''; return; }

  const visible = visibleSectors();
  el('resultCount').textContent = `${visible.length} of ${state.data.sectors.length}`;

  const narrowing = Boolean(state.search) || state.filter !== 'all' || state.watchOnly;

  const html = GROUP_ORDER.map(group => {
    const list = sortSectors(visible.filter(s => s.group === group));
    if (!list.length) return '';
    // A narrowed list has to be visible to be a result. Searching found three
    // matches across three sections and showed one, because the other two were
    // folded -- which reads as the search being broken. Any active narrowing
    // opens the sections without disturbing what was collapsed by choice.
    const shut = collapsed.has(group) && !narrowing;
    return `
      <section class="group-section ${shut ? 'collapsed' : ''}">
        <button class="group-header" data-group="${group}" aria-expanded="${!shut}"
                title="${narrowing && collapsed.has(group)
                  ? 'Opened to show matches; clears when you reset the filters' : ''}">
          <span class="group-caret">▾</span>
          <h2>${group}</h2>
          <span class="group-count">${list.length}</span>
          <span class="group-blurb dim">${GROUP_BLURB[group]}</span>
        </button>
        ${shut ? '' : `<div class="sector-grid">${list.map(sectorCard).join('')}</div>`}
      </section>`;
  }).join('');

  container.innerHTML = html || '<div class="empty-state"><p>Nothing matches this filter.</p></div>';

  container.querySelectorAll('.group-header').forEach(head => {
    head.addEventListener('click', () => toggleGroup(head.dataset.group));
  });

  container.querySelectorAll('.sector-card').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.compare-toggle')) return;
      openSector(card.dataset.sector);
    });
  });
  container.querySelectorAll('.compare-toggle').forEach(box => {
    box.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleCompare(box.dataset.sector);
    });
  });
  container.querySelectorAll('.watch-star').forEach(star => {
    star.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleWatch('sector', star.dataset.watchSector);
    });
  });
}


/**
 * Whether the gap against the benchmark is opening or closing.
 *
 * A sector 8% ahead and slipping is a different proposition from one 8% ahead
 * and pulling away, and the ranking alone cannot tell them apart.
 */
function momentumArrow(s) {
  const m = s.rsMomentum;
  if (m === null || m === undefined) return '';
  const rising = m > 0;
  const title = rising
    ? `Lead widening (${signedPct(m)} vs its 3-month pace)`
    : `Lead narrowing (${signedPct(m)} vs its 3-month pace)`;
  return `<span class="mom ${rising ? 'up' : 'down'}" title="${title}">${rising ? '▲' : '▼'}</span>`;
}

function sectorCard(s) {
  const rs = rsOf(s);
  const ret = retOf(s);
  const c = colourFor(rs);
  const adv = s.advances || 0;
  const dec = s.declines || 0;
  const total = adv + dec || 1;
  const picked = state.selected.includes(s.indexName);
  const verdict = rs === null ? 'no data' : rs > 0 ? 'above' : rs < 0 ? 'below' : 'level';
  const lead = s.lead || {};

  return `
    <div class="sector-card ${s.isBenchmark ? 'is-benchmark' : ''} ${lead.breakingOut ? 'breaking-out' : ''}"
         data-sector="${s.indexName}" style="border-left-color:${c.border}">
      <div class="sector-card-top">
        <div>
          <div class="sector-name">${s.name}</div>
          <div class="sector-index">${s.indexName}</div>
        </div>
        <div class="card-actions">
          <button class="watch-star ${watchedAnywhere('sector', s.indexName) ? 'on' : ''}"
                  data-watch-sector="${s.indexName}" title="Add to watchlist">★</button>
          <button class="compare-toggle ${picked ? 'on' : ''}" data-sector="${s.indexName}"
                  title="Add to comparison">${picked ? '✓' : '+'}</button>
        </div>
      </div>
      ${lead.breakingOut ? '<div class="breakout-badge">⚡ Leading breakout</div>' : ''}
      <div class="sector-figures">
        <span class="sector-value" style="color:${c.fg}">${signedPct(rs)}</span>
        <span class="rs-tag" style="color:${c.fg}">${verdict} benchmark</span>
        ${momentumArrow(s)}
      </div>
      <div class="trend-row">
        <span>${state.period} return <b>${signedPct(ret)}</b></span>
        <span>today <b>${signedPct(s.pChange)}</b></span>
      </div>
      ${rangeBar(lead)}
      <div class="breadth">
        <div class="breadth-adv" style="width:${(adv / total) * 100}%"></div>
        <div class="breadth-dec" style="width:${(dec / total) * 100}%"></div>
      </div>
      <div class="sector-foot">
        <span>${adv} adv · ${dec} dec</span>
        <span>${s.stocks.length} stocks →</span>
      </div>
    </div>`;
}

// Where the sector sits in its own 52-week range, with the benchmark's position
// marked on the same bar — the gap between the two is the leadership.
function rangeBar(lead) {
  if (lead.rangePos === null || lead.rangePos === undefined) return '';
  const bmPos = state.data.benchmark.rangePos;
  const near = lead.nearHighPct;
  return `
    <div class="range-block">
      <div class="range-bar" title="0% = at 52-week low, 100% = at 52-week high">
        <div class="range-fill" style="width:${lead.rangePos}%"></div>
        ${bmPos === null || bmPos === undefined ? ''
          : `<div class="range-bm" style="left:${bmPos}%" title="Benchmark at ${bmPos}%"></div>`}
      </div>
      <div class="range-caption">
        <span>${lead.rangePos}% of 52w range</span>
        ${near === null || near === undefined ? '' : `<span>${near}% of stocks near high</span>`}
      </div>
    </div>`;
}

/* ---------------------------------------------------------- sector detail */

function openSector(indexName, push = true) {
  const sector = sectorBy(indexName);
  if (!sector) return;
  state.activeSector = sector;
  state.stockSearch = '';
  el('stockSearch').value = '';
  if (push) pushView('detail', indexName);
  showView('detail');
  renderDetail();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function renderDetail() {
  const s = state.activeSector;
  el('detailName').textContent = s.name;
  el('detailIndex').textContent = s.indexName;
  el('detailLast').textContent = s.last === null || s.last === undefined ? '—' : fmt(s.last);

  const note = el('detailNote');
  if (s.note) { note.textContent = s.note; note.classList.remove('hidden'); }
  else note.classList.add('hidden');

  const bm = state.data.benchmark;
  el('detailRetLabel').textContent = `${state.period} return`;
  el('detailBmLabel').textContent = `${bm.name} ${state.period}`;

  const ret = retOf(s), bmRet = benchmarkReturn(), rs = rsOf(s);
  el('detailReturn').textContent = signedPct(ret);
  el('detailBm').textContent = signedPct(bmRet);
  const rsNode = el('detailRs');
  rsNode.textContent = signedPct(rs);
  rsNode.style.color = colourFor(rs).fg;

  el('detailAdvDec').textContent = `${s.advances || 0} / ${s.declines || 0}`;

  // Advances and declines describe today; this describes the trend today sits
  // inside, which is the more honest read on whether a sector is healthy.
  const trend = s.trend || {};
  const trendBox = el('detailTrendBox');
  if (trend.above200Pct === null || trend.above200Pct === undefined) {
    trendBox.classList.add('hidden');
  } else {
    trendBox.classList.remove('hidden');
    const node = el('detailTrend');
    node.textContent = `${trend.above200Pct}% of ${trend.rated}`;
    node.style.color = colourFor(trend.above200Pct - 50).fg;
  }

  // Where the multiple sits against the sector's own five-year range. Leading
  // at the bottom of that range is a different trade from leading at the top.
  const val = s.valuation || {};
  const peBox = el('detailPeBox');
  if (!val.pe) {
    peBox.classList.add('hidden');
  } else {
    peBox.classList.remove('hidden');
    const node = el('detailPe');
    if (val.pePercentile === null || val.pePercentile === undefined) {
      node.textContent = fmt(val.pe, 1);
      node.style.color = '';
      node.title = 'Not enough history to place it.';
    } else {
      node.textContent = `${fmt(val.pe, 1)} · ${val.pePercentile}th pctl`;
      // Expensive for itself reads as risk, so the scale runs the other way.
      node.style.color = colourFor(50 - val.pePercentile).fg;
      node.title = `Median ${fmt(val.peMedian, 1)}, range ${fmt(val.peLow, 1)}–`
                 + `${fmt(val.peHigh, 1)} over ${val.years} years. `
                 + `Dearer than ${val.pePercentile}% of that history.`;
    }
  }

  renderPeriodTable(s);
  renderOverlaps(s);

  const stocks = s.stocks.filter(st => {
    if (!state.stockSearch) return true;
    const q = state.stockSearch;
    return st.symbol.toLowerCase().includes(q) || st.company.toLowerCase().includes(q);
  });

  const filtered = stocks.filter(st => {
    if (state.stockFilter === 'strong') return (stockRs(st.symbol) ?? -1) > 0;
    if (state.stockFilter === 'breakout') return st.nearHigh;
    if (state.stockFilter === 'uptrend') return aboveBothMas(stockBy(st.symbol));
    return true;
  }).filter(st => {
    if (state.capFilter === 'all') return true;
    const detail = stockBy(st.symbol);
    return detail && detail.capBand === state.capFilter;
  });

  const sorted = sortStocks(filtered);
  const near = s.stocks.filter(st => st.nearHigh).length;
  el('stockCount').textContent =
    `${sorted.length} of ${s.stocks.length} stocks · ${near} within 5% of a 52-week high`;

  el('stockRetHead').textContent = `${state.period} return`;
  el('stockRsHead').textContent = `vs bench (${state.period})`;

  el('stockBody').innerHTML = sorted.map(st => {
    const c = colourFor(st.pChange);
    const rs = stockRs(st.symbol);
    const ret = stockRet(st.symbol);
    const rsC = colourFor(rs);
    // Being near the high is the good end, so the sign is flipped for colour.
    const fh = colourFor(st.fromHigh === null ? null : st.fromHigh + 5);
    const fresh = st.daysSinceHigh !== null && st.daysSinceHigh !== undefined
                  && st.daysSinceHigh <= 10;
    const picked = state.selectedStocks.includes(st.symbol);
    const score = stockStrength(st.symbol);
    const detail = stockBy(st.symbol);

    return `
      <tr class="${st.nearHigh ? 'near-high' : ''}" style="border-left:3px solid ${c.border}">
        <td class="pick-cell">
          <button class="watch-star small ${watchedAnywhere('stock', st.symbol) ? 'on' : ''}"
                  data-watch-stock="${st.symbol}" title="Add to watchlist">★</button>
          <button class="compare-toggle small ${picked ? 'on' : ''}" data-stock="${st.symbol}"
                  title="Add to comparison">${picked ? '✓' : '+'}</button>
        </td>
        <td class="sym">
          ${st.symbol}${st.nearHigh ? ' <span class="near-flag">⚡</span>' : ''}
          ${score !== null ? `<span class="score" title="Beating the benchmark and near its own high">${score}</span>` : ''}
        </td>
        <td>${st.company}</td>
        <td class="right">${fmt(st.close)}</td>
        <td class="pchange" style="color:${c.fg}">${signedPct(st.pChange)}</td>
        <td class="right">${signedPct(ret)}</td>
        <td class="right" style="color:${rsC.fg};font-weight:700">${signedPct(rs)}</td>
        <td class="right">${st.rangePos === null || st.rangePos === undefined ? '—' : st.rangePos + '%'}</td>
        <td class="right" style="color:${fh.fg};font-weight:700">${signedPct(st.fromHigh)}</td>
        ${maCell(detail || st)}
        <td class="dim">${(detail && detail.capBand) || '—'}</td>
        <td class="${fresh ? 'fresh-high' : 'dim'}">${st.highDate || '—'}</td>
      </tr>`;
  }).join('');

  el('stockBody').querySelectorAll('.compare-toggle').forEach(btn => {
    btn.addEventListener('click', () => toggleStock(btn.dataset.stock));
  });
  el('stockBody').querySelectorAll('.watch-star').forEach(btn => {
    btn.addEventListener('click', () => toggleWatch('stock', btn.dataset.watchStock));
  });
}


/**
 * Distance from the 50 and 200-day averages, in one cell.
 *
 * Above both, with the shorter above the longer, is the textbook uptrend; the
 * two numbers side by side say that faster than either alone does.
 */
function maCell(s) {
  if (s.fromMa50 === null && s.fromMa200 === null) return '<td class="right dim">—</td>';
  const c50 = colourFor(s.fromMa50);
  const c200 = colourFor(s.fromMa200);
  return `<td class="right ma-cell">
      <span style="color:${c50.fg}">${signedPct(s.fromMa50)}</span>
      <span class="dim"> / </span>
      <span style="color:${c200.fg}">${signedPct(s.fromMa200)}</span>
    </td>`;
}

const aboveBothMas = (s) =>
  s && s.fromMa50 !== null && s.fromMa200 !== null && s.fromMa50 > 0 && s.fromMa200 > 0;

const STOCK_COMPARE_ROWS = [
  ['Company', s => s.company],
  ['Close', s => fmt(s.close)],
  ['Today', s => s.pChange, true],
  ['52w range position', s => s.rangePos === null ? '—' : s.rangePos + '%'],
  ['From 52w high', s => s.fromHigh, true],
  ['High set', s => s.highDate || '—'],
  ['Days since high', s => s.daysSinceHigh === null || s.daysSinceHigh === undefined
                          ? '—' : s.daysSinceHigh],
  ['Also in', s => (s.sectors || []).length],
];

function renderStockTable(stocks) {
  const box = el('stockCompareBox');
  if (!stocks.length) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');

  const periods = (state.data.periods) || [];

  el('stockCompareHead').innerHTML = '<th>Metric</th>' + stocks.map(s =>
    `<th><div>${s.symbol}</div><span class="dim th-sub">${
      stockStrength(s.symbol) !== null ? 'strength ' + stockStrength(s.symbol) : ''
    }</span></th>`).join('');

  const row = (label, get, isPct) => `
    <tr>
      <th class="row-label">${label}</th>
      ${stocks.map(s => {
        const v = get(s);
        if (!isPct) return `<td>${v}</td>`;
        return `<td style="color:${colourFor(v).fg};font-weight:700">${signedPct(v)}</td>`;
      }).join('')}
    </tr>`;

  el('stockCompareBody').innerHTML =
    STOCK_COMPARE_ROWS.map(([label, get, isPct]) => row(label, get, isPct)).join('')
    + periods.map(p => row(`${p} return`, s => (s.returns || {})[p], true)).join('')
    + periods.map(p => row(`${p} vs benchmark`, s => (s.rs || {})[p], true)).join('');
}

function sortStocks(list) {
  const key = state.stockSort;
  const value = (st) => {
    if (key === 'strength') return stockStrength(st.symbol);
    if (key === 'rs') return stockRs(st.symbol);
    if (key === 'ret') return stockRet(st.symbol);
    if (key === 'rangePos') return st.rangePos;
    return st.pChange;
  };
  return [...list].sort((a, b) => {
    const av = value(a), bv = value(b);
    if (av === null || av === undefined) return 1;
    if (bv === null || bv === undefined) return -1;
    return bv - av;
  });
}

// Every window at once: the row that matters is the last one, which is the gap
// you would read off a same-% chart.
function renderPeriodTable(s) {
  const periods = state.data.periods || [];
  const bm = state.data.benchmark;

  el('periodHead').innerHTML = '<th>Window</th>' +
    periods.map(p => `<th class="${p === state.period ? 'active-period' : ''}">${p}</th>`).join('');

  const row = (label, get, colour) => `
    <tr>
      <th class="row-label">${label}</th>
      ${periods.map(p => {
        const v = get(p);
        const style = colour ? `color:${colourFor(v).fg};font-weight:700` : '';
        return `<td class="${p === state.period ? 'active-period' : ''}" style="${style}">${signedPct(v)}</td>`;
      }).join('')}
    </tr>`;

  el('periodBody').innerHTML =
    row(s.name, p => (s.returns || {})[p], false) +
    row(bm.name, p => bm.returns[p], false) +
    row('Gap vs benchmark', p => (s.rs || {})[p], true);
}

// NSE indices overlap by design (Bank / Private Bank / PSU Bank, and every index
// against its industry group). Surface that so three views of the same stocks
// aren't read as three independent signals.
function renderOverlaps(sector) {
  const box = el('overlapBox');
  const related = sector.related || [];
  if (!related.length) { box.classList.add('hidden'); return; }

  box.classList.remove('hidden');
  el('overlapList').innerHTML = related.map(r => `
    <button class="overlap-pill ${r.subsetOfThat ? 'subset' : ''}" data-target="${r.indexName}">
      ${r.name} <span class="pill-group">${r.group}</span>
      <b>${r.shared} stocks · ${r.shareOfThis}%</b>
      ${r.subsetOfThat ? '<span class="overlap-flag">fully inside</span>' : ''}
    </button>`).join('');

  el('overlapList').querySelectorAll('.overlap-pill').forEach(pill => {
    pill.addEventListener('click', () => openSector(pill.dataset.target));
  });
}

/* -------------------------------------------------------------- comparison */

function toggleCompare(indexName) {
  const i = state.selected.indexOf(indexName);
  if (i >= 0) state.selected.splice(i, 1);
  else state.selected.push(indexName);
  renderSections();
  renderTray();
  if (!el('compareView').classList.contains('hidden')) renderCompare();
}

function toggleStock(symbol) {
  const i = state.selectedStocks.indexOf(symbol);
  if (i >= 0) state.selectedStocks.splice(i, 1);
  else state.selectedStocks.push(symbol);
  if (state.activeSector) renderDetail();
  renderTray();
  if (!el('compareView').classList.contains('hidden')) renderCompare();
}

function renderTray() {
  const tray = el('compareTray');
  const total = state.selected.length + state.selectedStocks.length;
  if (!total) { tray.classList.add('hidden'); return; }

  tray.classList.remove('hidden');

  const sectorChips = state.selected.map(name => {
    const s = sectorBy(name);
    if (!s) return '';
    const c = colourFor(rsOf(s));
    return `<span class="tray-chip" style="border-color:${c.border}">
      ${s.name}<button class="tray-remove" data-sector="${name}" aria-label="Remove">×</button>
    </span>`;
  }).join('');

  const stockChips = state.selectedStocks.map(symbol => {
    const c = colourFor(stockRs(symbol));
    return `<span class="tray-chip stock" style="border-color:${c.border}">
      ${symbol}<button class="tray-remove" data-stock="${symbol}" aria-label="Remove">×</button>
    </span>`;
  }).join('');

  el('trayItems').innerHTML = sectorChips + stockChips;

  el('trayItems').querySelectorAll('.tray-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.stock) toggleStock(btn.dataset.stock);
      else toggleCompare(btn.dataset.sector);
    });
  });

  // One selection is enough: the benchmark is always drawn as the baseline, so
  // a single stock still gets the comparison that matters most.
  el('openCompare').textContent = total === 1 ? 'Compare vs benchmark' : `Compare ${total}`;
  el('openCompare').disabled = total < 1;
}

function compareRows() {
  const periods = (state.data && state.data.periods) || [];
  return [
    ['Group', s => s.group],
    ['Index level', s => s.last === null || s.last === undefined ? '—' : fmt(s.last)],
    ...periods.map(p => [`${p} return`, s => (s.returns || {})[p], true]),
    ...periods.map(p => [`${p} vs benchmark`, s => (s.rs || {})[p], true]),
    ['Advances', s => s.advances || 0],
    ['Declines', s => s.declines || 0],
    ['Constituents', s => s.stocks.length],
    ['Best stock today', s => topStock(s, 'best')],
    ['Worst stock today', s => topStock(s, 'worst')],
  ];
}

function topStock(s, which) {
  const rated = s.stocks.filter(st => st.pChange !== null && st.pChange !== undefined);
  if (!rated.length) return '—';
  const pick = which === 'best' ? rated[0] : rated[rated.length - 1];
  return `${pick.symbol} ${signedPct(pick.pChange)}`;
}

async function renderCompare() {
  const chosen = state.selected.map(sectorBy).filter(Boolean);
  const chosenStocks = state.selectedStocks.map(stockBy).filter(Boolean);
  el('compareCount').textContent = chosen.length + chosenStocks.length;

  // Stock series arrive per request, so they have to be here before drawing.
  await ensureStockHistory(state.selectedStocks);

  renderChartControls();
  renderChart();
  renderStockTable(chosenStocks);

  el('compareHead').innerHTML = '<th>Metric</th>' +
    chosen.map(s => `<th><div>${s.name}</div><span class="dim th-sub">${s.group}</span></th>`).join('');

  el('compareBody').innerHTML = compareRows().map(([label, get, isPct]) => {
    const cells = chosen.map(s => {
      const v = get(s);
      if (!isPct) return `<td>${v}</td>`;
      return `<td style="color:${colourFor(v).fg};font-weight:700">${signedPct(v)}</td>`;
    }).join('');
    return `<tr><th class="row-label">${label}</th>${cells}</tr>`;
  }).join('');

  // Pairwise shared-constituent matrix.
  const sets = chosen.map(s => new Set(s.stocks.map(st => st.symbol)));
  el('matrixHead').innerHTML = '<th></th>' + chosen.map(s => `<th>${s.name}</th>`).join('');
  el('matrixBody').innerHTML = chosen.map((s, i) => {
    const cells = chosen.map((_, j) => {
      if (i === j) return '<td class="self">—</td>';
      const shared = [...sets[i]].filter(sym => sets[j].has(sym)).length;
      const pct = sets[i].size ? Math.round((shared / sets[i].size) * 100) : 0;
      const heat = shared === 0 ? '' : `background:hsl(45 80% 50% / ${Math.min(pct, 100) / 220})`;
      return `<td style="${heat}">${shared}${shared ? ` <span class="dim">(${pct}%)</span>` : ''}</td>`;
    }).join('');
    return `<tr><th class="row-label">${s.name}</th>${cells}</tr>`;
  }).join('');
}

/* --------------------------------------------------------------- freshness
 * A number with no age on it invites being trusted more than it deserves. This
 * says whether the figures are keeping up with a running market, lagging it, or
 * simply the last close, and it re-renders on a timer so the age stays true
 * without anyone reloading.
 */

// NSE trades 09:15 to 15:30 IST. Computed against IST explicitly rather than the
// viewer's clock, so it stays right when the page is open from another timezone.
const IST_OFFSET_MIN = 330;
const MARKET_OPEN_MIN = 9 * 60 + 15;
const MARKET_CLOSE_MIN = 15 * 60 + 30;

// A live refresh runs every 15 minutes, so anything inside 20 counts as current.
const FRESH_MINUTES = 20;

function istNow(now = new Date()) {
  return new Date(now.getTime() + (IST_OFFSET_MIN + now.getTimezoneOffset()) * 60000);
}

function marketIsOpen(now = new Date()) {
  const ist = istNow(now);
  const day = ist.getDay();
  if (day === 0 || day === 6) return false;
  const minutes = ist.getHours() * 60 + ist.getMinutes();
  return minutes >= MARKET_OPEN_MIN && minutes <= MARKET_CLOSE_MIN;
}

function ageText(minutes) {
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${Math.round(minutes)}m ago`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.round(hours)}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * The strip under the header.
 *
 * The row is rendered twice and the track slid by half its width, which is what
 * makes the loop seamless; the copy is hidden from screen readers so the
 * figures are not announced twice.
 */
/* ------------------------------------------------------------- change log */

let changesSince = localStorage.getItem('changesSince') || 'week';
let changesScope = localStorage.getItem('changesScope') || 'all';
let changesShut = localStorage.getItem('changesCollapsed') === '1';

const CHANGE_CARDS = [
  ['entered', 'Entered the top 10'],
  ['left', 'Fell out of the top 10'],
  ['crossedUp', 'Started beating the benchmark'],
  ['crossedDown', 'Fell behind the benchmark'],
  ['climbed', 'Climbing'],
  ['slipped', 'Slipping'],
];

/**
 * Who moved in the rankings.
 *
 * The rest of the board is a still photograph -- it says who leads today and
 * nothing about who led last week, which is a strange gap in a tool about
 * rotation. The interesting moment is rarely "X is ahead", it is "X was
 * fourteenth a fortnight ago".
 *
 * Each scope is ranked within itself, so switching to Sectoral renumbers from
 * 1 rather than showing gaps where the themes were.
 */
function renderChanges() {
  const panel = el('changesPanel');
  const changes = state.data && state.data.changes;
  const scopes = changes && changes.scopes;
  if (!scopes) { panel.classList.add('hidden'); return; }

  if (!scopes[changesScope]) changesScope = 'all';
  const scope = scopes[changesScope];
  const block = scope && scope.since && scope.since[changesSince];
  if (!block) { panel.classList.add('hidden'); return; }

  panel.classList.remove('hidden');
  panel.classList.toggle('collapsed', changesShut);
  el('changesToggle').setAttribute('aria-expanded', String(!changesShut));

  el('changesSub').textContent =
    `rank out of ${scope.count}, on ${changes.window} relative strength · against ${block.date}`;

  el('changesScope').innerHTML = Object.entries(scopes)
    .map(([key, s]) => `<button class="chip ${key === changesScope ? 'active' : ''}"
            data-scope="${key}">${s.label} (${s.count})</button>`)
    .join('');

  [...el('changesSince').children].forEach(b =>
    b.classList.toggle('active', b.dataset.since === changesSince));

  const rows = (list) => list.length
    ? list.map(r => `
        <div class="change-row" data-open="${r.indexName}" title="${r.name}: rank ${r.from} → ${r.to} of ${scope.count}">
          <span>${r.name}</span>
          <span class="change-rank">${r.from} &rarr; ${r.to}</span>
        </div>`).join('')
    : '<div class="change-empty">Nothing.</div>';

  el('changesGrid').innerHTML = CHANGE_CARDS
    .filter(([key]) => (block[key] || []).length)
    .map(([key, title]) => `
      <div class="change-card">
        <h4>${title}</h4>
        ${rows(block[key] || [])}
      </div>`).join('')
    || '<div class="change-empty">Nothing moved enough to report in this group.</div>';

  el('changesGrid').querySelectorAll('.change-row').forEach(row =>
    row.addEventListener('click', () => openSector(row.dataset.open)));

  el('changesScope').querySelectorAll('[data-scope]').forEach(btn =>
    btn.addEventListener('click', () => {
      changesScope = btn.dataset.scope;
      localStorage.setItem('changesScope', changesScope);
      renderChanges();
    }));
}

el('changesToggle').addEventListener('click', () => {
  changesShut = !changesShut;
  localStorage.setItem('changesCollapsed', changesShut ? '1' : '0');
  renderChanges();
});

el('changesSince').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-since]');
  if (!btn) return;
  changesSince = btn.dataset.since;
  localStorage.setItem('changesSince', changesSince);
  renderChanges();
});

function renderTicker() {
  const strip = el('tickerStrip');
  const rows = (state.data && state.data.ticker) || [];

  if (!rows.length) { strip.classList.add('hidden'); return; }
  strip.classList.remove('hidden');

  const item = (r) => {
    const dir = r.pChange > 0 ? 'up' : r.pChange < 0 ? 'down' : 'flat';
    // Metals only, and only once the fall is deep enough to be worth a word.
    const dip = r.drawdown
      ? `<span class="ticker-dip ${r.drawdownLevel || 'mild'}"
               title="${r.name} is ${signedPct(r.fromHigh)} from its 52-week high of ${fmt(r.high52)}">
           ${r.drawdown} ${signedPct(r.fromHigh)}
         </span>`
      : '';
    return `
      <span class="ticker-item">
        <span class="ticker-name">${r.name}</span>
        <span class="ticker-last">${fmt(r.last)}</span>
        <span class="ticker-change ${dir}">${signedPct(r.pChange)}</span>
        ${dip}
      </span>`;
  };

  const once = rows.map(item).join('');
  el('tickerTrack').innerHTML =
    once + `<span class="ticker-copy" aria-hidden="true">${once}</span>`;

}

function renderFreshness() {
  const box = el('freshness');
  const label = el('freshLabel');
  if (!state.data || !state.data.updatedAt) {
    box.className = 'freshness';
    label.textContent = '—';
    return;
  }

  const minutes = (Date.now() - new Date(state.data.updatedAt).getTime()) / 60000;
  const open = marketIsOpen();

  let mode, text;
  if (open && minutes <= FRESH_MINUTES) {
    mode = 'live';
    text = 'LIVE';
  } else if (open) {
    // Market moving but nothing has refreshed -- say so rather than imply live.
    mode = 'stale';
    text = `DELAYED · ${ageText(minutes)}`;
  } else {
    mode = 'closed';
    text = `CLOSED · ${ageText(minutes)}`;
  }

  box.className = 'freshness ' + mode;
  label.textContent = text;
  box.title = `Figures updated ${ageText(minutes)}`
    + ` · ${state.data.refreshMode === 'live' ? 'live refresh' : 'full rebuild'}`
    + ` · market ${open ? 'open' : 'closed'}`;
}

setInterval(renderFreshness, 30000);

/*
 * The scheduled refresh writes new figures on the server, but an open page would
 * happily keep showing the ones it loaded an hour ago -- which matters most on a
 * phone, where the tab tends to be left open rather than reloaded.
 *
 * So the page checks for itself. It only redraws when the server reports a newer
 * timestamp, and it stays quiet while the tab is hidden so a backgrounded phone
 * isn't polling all day.
 */
const POLL_MS = 60000;

async function pollForUpdate() {
  if (window.EMBEDDED_DATA) return;          // snapshot: nothing to poll
  if (document.hidden) return;
  if (!state.data) return;

  try {
    const res = await fetch('/api/sectors', { cache: 'no-store' });
    if (!res.ok) return;
    const fresh = await res.json();
    if (fresh.updatedAt && fresh.updatedAt !== state.data.updatedAt) {
      applyData(fresh);
      showStatus('Figures refreshed.', 'success');
    }
  } catch (e) {
    /* server asleep or network dropped - the badge will show the data ageing */
  }
}

setInterval(pollForUpdate, POLL_MS);
// A tab returning to the foreground is the moment its data is most likely stale.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { renderFreshness(); pollForUpdate(); }
});

/* ------------------------------------------------------------ market regime
 * NIFTY Composite G-Sec / NIFTY 50 against its own 30-day average. Money moving
 * into government bonds pushes the ratio up while equities fall, so the line runs
 * roughly inverse to the market: above its average is risk-off, below it is
 * risk-on. Colour therefore runs backwards to the reading -- well under the
 * average is the deep green.
 */

const GSEC_INDEX = 'NIFTY COMPOSITE G-SEC INDEX';
const REGIME_SMA = 30;
const REGIME_STEP = 0.5;      // % away from the average per colour band

/** Trailing run of consecutive trading days, ignoring the weekly/monthly tail. */
function dailyTail(dates) {
  const day = s => new Date(s + 'T00:00:00').getTime();
  let start = dates.length - 1;
  while (start > 0 && (day(dates[start]) - day(dates[start - 1])) / 86400000 <= 4) start--;
  return start;
}

function computeRegime() {
  if (!priceHistory) return null;
  const gsec = priceHistory.series[GSEC_INDEX];
  const nifty = priceHistory.series['NIFTY 50'];
  if (!gsec || !nifty) return null;

  const from = dailyTail(priceHistory.dates);
  const points = [];
  for (let i = from; i < priceHistory.dates.length; i++) {
    if (gsec[i] && nifty[i]) points.push({ date: priceHistory.dates[i], ratio: gsec[i] / nifty[i] });
  }
  if (points.length < REGIME_SMA) return null;

  const last = points.length - 1;
  const window = points.slice(last - REGIME_SMA + 1, last + 1);
  const sma = window.reduce((a, p) => a + p.ratio, 0) / REGIME_SMA;
  const deviation = (points[last].ratio / sma - 1) * 100;

  // Days since the ratio last sat on the other side of its average.
  let flipped = null;
  for (let i = last; i >= REGIME_SMA - 1; i--) {
    const win = points.slice(i - REGIME_SMA + 1, i + 1);
    const avg = win.reduce((a, p) => a + p.ratio, 0) / REGIME_SMA;
    const above = points[i].ratio > avg;
    if (above !== (deviation > 0)) { flipped = points[i + 1] ? points[i + 1].date : null; break; }
  }

  // A short run of the deviation, so the header can show which way it is heading
  // rather than only where it stands.
  const trail = [];
  for (let i = Math.max(REGIME_SMA - 1, last - 59); i <= last; i++) {
    const win = points.slice(i - REGIME_SMA + 1, i + 1);
    const avg = win.reduce((a, p) => a + p.ratio, 0) / REGIME_SMA;
    trail.push((points[i].ratio / avg - 1) * 100);
  }

  return {
    deviation,
    bullish: deviation < 0,
    asOf: points[last].date,
    since: flipped,
    days: flipped ? Math.round((Date.now() - new Date(flipped + 'T00:00:00')) / 86400000) : null,
    trail,
  };
}

/**
 * The recent run of the ratio against its average, as a small line.
 *
 * Drawn upside down on purpose: below the average is the bullish side, so the
 * line rising means conditions improving, which is the way anyone reads a chart.
 */
function regimeSparkline(trail, colour) {
  if (!trail || trail.length < 4) return '';

  const W = 96, H = 30, pad = 3;
  const span = Math.max(...trail.map(Math.abs)) || 1;
  const x = i => (i / (trail.length - 1)) * W;
  const y = v => pad + (1 - (-v + span) / (2 * span)) * (H - 2 * pad);

  const d = trail.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  const area = `${d} L${W} ${H} L0 ${H} Z`;

  return `
    <svg viewBox="0 0 ${W} ${H}" class="spark-svg" aria-hidden="true">
      <path d="${area}" fill="${colour}" opacity="0.14"/>
      <line x1="0" x2="${W}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}" class="spark-zero"/>
      <path d="${d}" fill="none" stroke="${colour}" stroke-width="1.8"
            stroke-linejoin="round" stroke-linecap="round"/>
      <circle cx="${W}" cy="${y(trail[trail.length - 1]).toFixed(1)}" r="2.6" fill="${colour}"/>
    </svg>`;
}

function renderRegime() {
  const box = el('regimeBox');
  const regime = computeRegime();

  if (!regime) {
    el('regimeVerdict').textContent = '—';
    el('regimeDetail').textContent = historyError
      ? 'needs price history' : 'not enough daily history yet';
    el('regimeDays').textContent = '';
    el('regimeSpark').innerHTML = '';
    box.style.borderColor = 'var(--border)';
    return;
  }

  // Below the average is bullish, so the sign is flipped before colouring.
  const colour = bandColour(bandOf(-regime.deviation, REGIME_STEP));

  const verdict = el('regimeVerdict');
  verdict.textContent = regime.bullish ? 'BULLISH' : 'BEARISH';
  verdict.style.color = colour.fg;

  const side = regime.bullish ? 'below' : 'above';
  el('regimeDetail').textContent =
    `G-Sec/Nifty ${Math.abs(regime.deviation).toFixed(2)}% ${side} its 30-day average`;

  el('regimeDays').textContent = regime.days !== null
    ? `${regime.days} day${regime.days === 1 ? '' : 's'}` : '';

  el('regimeSpark').innerHTML = regimeSparkline(regime.trail, colour.fg);
  el('regimeRail').style.background = colour.fg;

  box.style.borderColor = colour.border;
  box.style.background = `linear-gradient(135deg, ${colour.bg}, transparent 70%)`;
  box.style.boxShadow = `0 0 0 1px ${colour.bg}, 0 6px 18px ${colour.bg}`;
}

/* ------------------------------------------------------------- rotation map
 * A Relative Rotation Graph. Two questions at once: is a sector ahead of the
 * benchmark, and is that lead growing or shrinking. Sectors travel clockwise --
 * Improving, then Leading, then Weakening, then Lagging.
 *
 * The dashboard's ranking only answers the first, which is why a sector can sit
 * second on the list while quietly losing its lead. This shows both, so a leader
 * running out of steam and a laggard turning up are visible before either shows
 * in the ranking.
 *
 * Kept behind a toggle: it is a considered read, not something wanted on screen
 * every time the page opens.
 */

const RRG_QUADRANTS = [
  { key: 'leading',   label: 'Leading',   note: 'ahead and pulling away' },
  { key: 'weakening', label: 'Weakening', note: 'still ahead, losing ground' },
  { key: 'lagging',   label: 'Lagging',   note: 'behind and falling further' },
  { key: 'improving', label: 'Improving', note: 'behind, but turning up' },
];

function rrgPoints(group) {
  if (!state.data) return [];
  return state.data.sectors
    .filter(s => s.group === group && !s.isBenchmark)
    .map(s => {
      const x = (s.rs || {})['3M'];
      const y = s.rsMomentum;
      if (x === null || x === undefined || y === null || y === undefined) return null;
      const quadrant = x >= 0
        ? (y >= 0 ? 'leading' : 'weakening')
        : (y >= 0 ? 'improving' : 'lagging');
      return { name: s.name, indexName: s.indexName, x, y, quadrant };
    })
    .filter(Boolean);
}

/**
 * The quadrants as four panels laid out where they belong.
 *
 * A scatter carrying twenty-odd labelled points is dense however large it is
 * drawn. The board keeps the same mental model -- the four quadrants in their
 * usual corners, money travelling clockwise between them -- but each is a list
 * you can simply read, with a bar for how far from the benchmark a sector is and
 * the momentum figure that decided which quadrant it landed in.
 */
function renderRrgBoard(points) {
  const host = el('rrgBoard');
  if (!points.length) { host.innerHTML = ''; return; }

  const widest = Math.max(...points.map(p => Math.abs(p.x))) || 1;

  // Top row is the two "behind"/"ahead but improving" halves, so the clockwise
  // path reads Improving -> Leading -> Weakening -> Lagging around the board.
  const cells = [
    { key: 'improving', label: 'Improving', note: 'behind, but turning up' },
    { key: 'leading',   label: 'Leading',   note: 'ahead and pulling away' },
    { key: 'lagging',   label: 'Lagging',   note: 'behind and falling further' },
    { key: 'weakening', label: 'Weakening', note: 'still ahead, losing ground' },
  ];

  host.innerHTML = cells.map(cell => {
    const inCell = points.filter(p => p.quadrant === cell.key)
      .sort((a, b) => b.x - a.x);

    const rows = inCell.map(p => {
      const width = Math.max(4, Math.abs(p.x) / widest * 100);
      const rising = p.y >= 0;
      return `
        <button class="board-row" data-sector="${p.indexName}">
          <span class="board-name">${p.name}</span>
          <span class="board-bar"><i style="width:${width.toFixed(0)}%"></i></span>
          <span class="board-x">${signedPct(p.x)}</span>
          <span class="board-y ${rising ? 'up' : 'down'}"
                title="${rising ? 'Lead widening' : 'Lead narrowing'} by ${signedPct(p.y)} against its three-month pace">
            ${rising ? '▲' : '▼'} ${signedPct(p.y)}
          </span>
        </button>`;
    }).join('');

    return `
      <div class="board-cell ${cell.key}">
        <div class="board-head">
          <span class="board-title">${cell.label}</span>
          <span class="board-count">${inCell.length}</span>
          <span class="board-note dim">${cell.note}</span>
        </div>
        <div class="board-rows">${rows || '<p class="dim board-empty">nothing here</p>'}</div>
      </div>`;
  }).join('');

  host.querySelectorAll('.board-row').forEach(b =>
    b.addEventListener('click', () => openSector(b.dataset.sector)));
}

/**
 * What the map is actually saying today, in words.
 *
 * A scatter of twenty-odd dots is only useful if you can already read one. This
 * picks out the four things worth acting on -- where the money is, what is
 * quietly rolling over, what is turning up first, and what to leave alone -- and
 * names them.
 */
function renderRrgReading(points) {
  const box = el('rrgReading');
  if (!points.length) { box.innerHTML = ''; return; }

  const byQuad = q => points.filter(p => p.quadrant === q);
  const strongest = list => [...list].sort((a, b) => b.x - a.x)[0];
  const fastestUp = list => [...list].sort((a, b) => b.y - a.y)[0];
  const fastestDown = list => [...list].sort((a, b) => a.y - b.y)[0];

  const leading = byQuad('leading');
  const weakening = byQuad('weakening');
  const improving = byQuad('improving');
  const lagging = byQuad('lagging');

  const bm = state.data.benchmark;
  const regime = bm.rangePos === null || bm.rangePos === undefined ? null : bm.rangePos;

  const cards = [];

  if (leading.length) {
    const best = fastestUp(leading);
    cards.push({
      key: 'leading',
      title: 'Money is here',
      body: `<b>${leading.length}</b> ahead of ${bm.name} and still widening. `
        + `<b>${best.name}</b> is pulling away fastest, ${signedPct(best.y)} above its own three-month pace.`,
    });
  }

  if (weakening.length) {
    const slipping = fastestDown(weakening);
    cards.push({
      key: 'weakening',
      title: 'Quietly rolling over',
      body: `<b>${slipping.name}</b> is still <b>${signedPct(slipping.x)}</b> ahead — near the top of any ranking — `
        + `but losing ground fastest of anything here. ${weakening.length > 1
          ? `${weakening.length - 1} other${weakening.length > 2 ? 's are' : ' is'} doing the same.` : ''}`,
    });
  }

  if (improving.length) {
    const turning = fastestUp(improving);
    cards.push({
      key: 'improving',
      title: 'Turning up first',
      body: `<b>${turning.name}</b> is still <b>${signedPct(turning.x)}</b> behind, so the ranking shows it red — `
        + `but it is improving faster than anything on the board. This is where the next leader usually appears.`,
    });
  }

  if (lagging.length) {
    const worst = fastestDown(lagging);
    cards.push({
      key: 'lagging',
      title: 'Leave alone for now',
      body: `<b>${lagging.length}</b> behind and still falling further`
        + (worst ? `, ${worst.name} the weakest.` : '.'),
    });
  }

  // Spelling out the actual levels, because "45% up its range" can be misread as
  // "45% above the low" -- which it is not.
  const bmSector = state.data.sectors.find(s => s.isBenchmark);
  const yearReturn = bm.returns['1Y'];

  const wherePart = !bmSector || bmSector.low52 == null || bmSector.high52 == null
    ? `${bm.name} is <b>${regime}%</b> of the way up its 52-week range`
    : `${bm.name} is at <b>${fmt(bmSector.last, 0)}</b>, between its 52-week low of `
      + `${fmt(bmSector.low52, 0)} and high of ${fmt(bmSector.high52, 0)} — `
      + `<b>${regime}% of the way up</b>, and ${signedPct(bm.fromHigh)} from the high`;

  const meaning = regime < 60
    ? `The index has gone <b>${signedPct(yearReturn)}</b> in a year, so anything leading here `
      + `is doing it on its own rather than being carried by the market.`
    : `The index is near the top of its own range, so most of these are rising `
      + `<em>with</em> it rather than despite it — being ahead counts for less.`;

  const headline = regime === null ? '' : `
    <p class="rrg-headline">${wherePart}.<br><span class="dim">${meaning}</span></p>`;

  box.innerHTML = headline + `<div class="rrg-reading-grid">` + cards.map(c => `
    <div class="rrg-read ${c.key}">
      <div class="rrg-read-title">${c.title}</div>
      <p>${c.body}</p>
    </div>`).join('') + `</div>`;
}

function renderRrg() {
  const panel = el('rrgPanel');
  if (panel.classList.contains('hidden')) return;

  const points = rrgPoints(el('rrgGroup').value);
  const host = el('rrgHost');

  const scatter = state.rrgView === 'scatter';
  host.classList.toggle('hidden', !scatter);
  el('rrgBoard').classList.toggle('hidden', scatter);

  if (!points.length) {
    host.innerHTML = '<div class="chart-empty">Nothing to plot for this group.</div>';
    el('rrgLists').innerHTML = '';
    return;
  }

  // Symmetric bounds so the axes cross in the middle and quadrants read evenly.
  const spanX = Math.max(...points.map(p => Math.abs(p.x))) * 1.15 || 1;
  const spanY = Math.max(...points.map(p => Math.abs(p.y))) * 1.15 || 1;

  const W = 1000, H = 620, M = 52;
  const x = v => M + ((v + spanX) / (2 * spanX)) * (W - 2 * M);
  const y = v => M + (1 - (v + spanY) / (2 * spanY)) * (H - 2 * M);
  const midX = x(0), midY = y(0);

  const tint = {
    leading:   'rgba(22, 199, 132, 0.07)',
    weakening: 'rgba(240, 185, 11, 0.07)',
    lagging:   'rgba(234, 57, 67, 0.07)',
    improving: 'rgba(75, 159, 255, 0.07)',
  };

  // With twenty-odd sectors the names collide; nudge overlapping ones apart and
  // draw a short leader line back to the dot so it stays clear which is which.
  const placed = points
    .map(p => ({ ...p, labelY: y(p.y), nudged: false }))
    .sort((a, b) => a.labelY - b.labelY);
  for (let i = 1; i < placed.length; i++) {
    const gap = placed[i].labelY - placed[i - 1].labelY;
    if (gap < 15 && Math.abs(x(placed[i].x) - x(placed[i - 1].x)) < 150) {
      placed[i].labelY = placed[i - 1].labelY + 15;
      placed[i].nudged = true;
    }
  }

  host.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" class="rrg-svg" role="img" aria-label="Rotation map">
      <rect x="${midX}" y="${M}" width="${W - M - midX}" height="${midY - M}" fill="${tint.leading}"/>
      <rect x="${midX}" y="${midY}" width="${W - M - midX}" height="${H - M - midY}" fill="${tint.weakening}"/>
      <rect x="${M}" y="${midY}" width="${midX - M}" height="${H - M - midY}" fill="${tint.lagging}"/>
      <rect x="${M}" y="${M}" width="${midX - M}" height="${midY - M}" fill="${tint.improving}"/>

      <line x1="${M}" x2="${W - M}" y1="${midY}" y2="${midY}" class="rrg-axis"/>
      <line x1="${midX}" x2="${midX}" y1="${M}" y2="${H - M}" class="rrg-axis"/>

      <text x="${W - M - 8}" y="${M + 16}" class="rrg-quad" text-anchor="end">LEADING</text>
      <text x="${W - M - 8}" y="${H - M - 8}" class="rrg-quad" text-anchor="end">WEAKENING</text>
      <text x="${M + 8}" y="${H - M - 8}" class="rrg-quad">LAGGING</text>
      <text x="${M + 8}" y="${M + 16}" class="rrg-quad">IMPROVING</text>

      <text x="${W - M}" y="${midY - 8}" class="rrg-axis-label" text-anchor="end">ahead of benchmark →</text>
      <text x="${midX + 8}" y="${M + 4}" class="rrg-axis-label">↑ lead growing</text>

      ${placed.map(p => `
        <g class="rrg-point" data-sector="${p.indexName}">
          ${p.nudged ? `<line x1="${x(p.x).toFixed(1)}" y1="${y(p.y).toFixed(1)}"
                x2="${(x(p.x) + 10).toFixed(1)}" y2="${p.labelY.toFixed(1)}"
                class="rrg-leader"/>` : ''}
          <circle cx="${x(p.x).toFixed(1)}" cy="${y(p.y).toFixed(1)}" r="6.5"
                  class="rrg-dot ${p.quadrant}"/>
          <text x="${(x(p.x) + 12).toFixed(1)}" y="${(p.labelY + 4).toFixed(1)}"
                class="rrg-name">${p.name}</text>
        </g>`).join('')}
    </svg>`;

  renderRrgBoard(points);
  renderRrgReading(points);

  el('rrgLists').innerHTML = state.rrgView === 'scatter' ? RRG_QUADRANTS.map(q => {
    const inQuad = points.filter(p => p.quadrant === q.key)
      .sort((a, b) => b.x - a.x);
    if (!inQuad.length) return '';
    return `
      <div class="rrg-list ${q.key}">
        <div class="rrg-list-head">${q.label} <span class="dim">${q.note}</span></div>
        ${inQuad.map(p => `
          <button class="rrg-item" data-sector="${p.indexName}">
            ${p.name}<b>${signedPct(p.x)}</b>
          </button>`).join('')}
      </div>`;
  }).join('') : '';

  host.querySelectorAll('.rrg-point').forEach(g =>
    g.addEventListener('click', () => openSector(g.dataset.sector)));
  el('rrgLists').querySelectorAll('.rrg-item').forEach(b =>
    b.addEventListener('click', () => openSector(b.dataset.sector)));
}

/* ------------------------------------------------- same-% chart + crossings
 * The chart is the point of the whole exercise: rebase every series to 0% at
 * the left edge and the vertical distance between two lines *is* their relative
 * performance. Where the lines cross is where leadership changed hands, which a
 * pair of endpoint numbers can never show.
 */

const CHART_WINDOWS = [
  ['1M', 30], ['3M', 91], ['6M', 182], ['1Y', 365], ['2Y', 730], ['3Y', 1095], ['5Y', 1826],
];

const LINE_COLOURS = [
  '#4b9fff', '#16c784', '#f0b90b', '#ff7ab6', '#a78bfa',
  '#22d3ee', '#fb923c', '#f87171', '#84cc16', '#e879f9',
];

let priceHistory = null;     // {dates, series} - not window.history
let historyError = null;
let stockHistory = {};       // symbol -> {isoDate: close}, fetched on demand

/**
 * Pull price series for stocks that are about to be charted.
 *
 * The full price book is 7.5 MB, so it is never shipped whole -- only the
 * handful of symbols actually selected, and only once each.
 */
async function ensureStockHistory(symbols) {
  const missing = symbols.filter(s => !stockHistory[s]);
  if (!missing.length) return;
  try {
    const res = await fetch('/api/stock-history?symbols='
      + encodeURIComponent(missing.join(',')));
    if (!res.ok) return;
    const body = await res.json();
    Object.assign(stockHistory, body.series || {});
  } catch (e) {
    /* charted lines will simply be absent */
  }
}

async function loadHistory() {
  // Standalone snapshots carry the series inline; there is no server to ask.
  if (window.EMBEDDED_HISTORY) { priceHistory = window.EMBEDDED_HISTORY; renderRegime(); return; }
  if (window.EMBEDDED_DATA) {
    historyError = 'This snapshot was built without price history, so the chart is '
      + 'unavailable. Run build_history.py, then build_snapshot.py again.';
    renderRegime();
    return;
  }
  try {
    const res = await fetch('/api/history');
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      historyError = body.message || 'No price history available.';
      return;
    }
    priceHistory = await res.json();
  } catch (e) {
    historyError = 'Could not load price history: ' + e.message;
  }
  renderRegime();
}

// Industry groups have no index of their own, so they cannot be charted.
const chartableSeries = (indexName) =>
  priceHistory && priceHistory.series[(indexName || '').toUpperCase()] || null;

/** Sectors and stocks in one list, so the chart can mix them freely. */
function selections() {
  const out = state.selected.map(indexName => {
    const sector = sectorBy(indexName);
    return { kind: 'sector', key: indexName,
             name: sector ? sector.name : indexName,
             tag: sector ? sector.group : '' };
  });
  state.selectedStocks.forEach(symbol => {
    const stock = stockBy(symbol);
    out.push({ kind: 'stock', key: symbol, name: symbol,
               tag: stock ? stock.company : 'stock' });
  });
  return out;
}

/**
 * A stock series aligned to the index calendar, as an as-of join.
 *
 * Index history is a positional array sampled on its own dates; stock history is
 * keyed by Yahoo's. Outside the daily stretch the two almost never land on the
 * same day, so matching dates exactly finds nothing and whatever was last matched
 * gets carried for years -- which is how TVSMOTOR came to be charted from its
 * 2021 price and read +240% over one year instead of +33%.
 *
 * Both sides are sorted, so a single walk takes the latest stock close at or
 * before each index date.
 */
function seriesFor(item) {
  if (item.kind === 'sector') return chartableSeries(item.key);
  const byDate = stockHistory[item.key];
  if (!byDate || !priceHistory) return null;

  const days = Object.keys(byDate).sort();
  let cursor = 0;
  let carried = null;

  return priceHistory.dates.map(date => {
    while (cursor < days.length && days[cursor] <= date) {
      carried = byDate[days[cursor]];
      cursor++;
    }
    return carried;
  });
}

/** Monday of the week containing a date (weeks run Monday to Sunday). */
function mondayOf(d) {
  const day = d.getUTCDay();                 // 0 = Sunday
  const back = day === 0 ? 6 : day - 1;
  const m = new Date(d);
  m.setUTCDate(d.getUTCDate() - back);
  return m;
}

/**
 * Where a window of `days` starts, aligned the way TradingView aligns it.
 *
 * TradingView measures from the start of the newest weekly bar, steps back the
 * period, and begins at the bar containing wherever that lands. Counting a plain
 * 365 days instead landed on 19 August 2025 where TradingView began on the 11th
 * -- a week and a bit of difference, which had TVSMOTOR reading +34.6% against
 * its +46.7% for what both called "1Y".
 *
 * Matching matters more than being independently precise here: the figures are
 * checked against TradingView, and two defensible answers to the same question
 * are worse than one shared one.
 */
function windowSlice(days) {
  const dates = priceHistory.dates;
  const last = new Date(dates[dates.length - 1] + 'T00:00:00Z');

  const anchor = mondayOf(last);
  const target = new Date(anchor);
  target.setUTCDate(anchor.getUTCDate() - days);
  const iso = mondayOf(target).toISOString().slice(0, 10);

  // First trading day of that week -- the Monday itself may be a holiday.
  const from = dates.findIndex(d => d >= iso);
  if (from < 0) return Math.max(0, dates.length - 2);
  return Math.min(from, dates.length - 2);
}

/** Rebase a series to 0% at `from`, skipping leading gaps. */
function rebase(values, from) {
  let base = null;
  for (let i = from; i < values.length; i++) {
    if (values[i] !== null && values[i] !== undefined) { base = values[i]; break; }
  }
  if (!base) return null;
  return values.slice(from).map(v =>
    v === null || v === undefined ? null : (v / base - 1) * 100);
}

/** Index of the last sign change between two rebased series. */
function lastCrossing(a, b) {
  let last = null;
  for (let i = 1; i < a.length; i++) {
    if (a[i] === null || b[i] === null || a[i - 1] === null || b[i - 1] === null) continue;
    const before = a[i - 1] - b[i - 1];
    const now = a[i] - b[i];
    if (before === 0 || now === 0) continue;
    if ((before < 0) !== (now < 0)) last = { at: i, above: now > 0 };
  }
  return last;
}

function chartState() {
  const days = parseInt(el('chartPeriod').value, 10);
  const baseName = el('baselineSelect').value;
  const from = windowSlice(days);
  const dates = priceHistory.dates.slice(from);

  const all = selections();
  const baseItem = all.find(i => i.key === baseName)
    || { kind: 'sector', key: baseName, name: baselineLabel(baseName) };
  const baseRaw = seriesFor(baseItem);
  const base = baseRaw && rebase(baseRaw, from);

  const lines = all.map(item => {
    const raw = seriesFor(item);
    return {
      name: item.name,
      indexName: item.key,
      kind: item.kind,
      values: raw ? rebase(raw, from) : null,
      isBase: item.key === baseName,
    };
  });

  return { dates, base, baseName, lines, days };
}

function renderChart() {
  const host = el('chartHost');
  if (!priceHistory) {
    host.innerHTML = `<div class="chart-empty">${historyError ||
      'Price history not built yet. Run <code>python build_history.py</code>.'}</div>`;
    el('chartLegend').innerHTML = '';
    el('crossList').innerHTML = '';
    return;
  }

  const { dates, base, baseName, lines } = chartState();
  const drawable = lines.filter(l => l.values);

  if (!base || !drawable.length) {
    host.innerHTML = '<div class="chart-empty">None of the selections have an index series to chart. '
      + 'Industry groups are computed from their constituents, so they have no index of their own.</div>';
    el('chartLegend').innerHTML = '';
    el('crossList').innerHTML = '';
    return;
  }

  const series = [{ name: baselineLabel(baseName), values: base, baseline: true },
                  ...drawable.filter(l => !l.isBase)];

  const all = series.flatMap(s => s.values).filter(v => v !== null);
  const min = Math.min(0, ...all), max = Math.max(0, ...all);
  const pad = (max - min) * 0.08 || 1;
  const lo = min - pad, hi = max + pad;

  // Room on the right for the end labels, the way a price chart carries its
  // scale and last value there rather than making you trace a line to a legend.
  const W = 1000, H = 380, L = 8, R = 96, T = 16, B = 30;
  const x = i => L + (i / Math.max(dates.length - 1, 1)) * (W - L - R);
  const y = v => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);

  const path = values => {
    let d = '', pen = false;
    values.forEach((v, i) => {
      if (v === null) { pen = false; return; }
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)} `;
      pen = true;
    });
    return d.trim();
  };

  const ticks = [];
  for (let k = 0; k <= 5; k++) ticks.push(lo + (hi - lo) * (k / 5));

  // Roughly monthly gridlines, so the horizontal axis is readable at any window.
  const step = Math.max(1, Math.round(dates.length / 7));
  const dateTicks = [];
  for (let i = 0; i < dates.length; i += step) dateTicks.push(i);
  if (dateTicks[dateTicks.length - 1] !== dates.length - 1) dateTicks.push(dates.length - 1);

  const colourOf = (s, i) =>
    s.baseline ? 'var(--text-dim)' : LINE_COLOURS[i % LINE_COLOURS.length];

  // End labels, stacked apart when lines finish close together.
  const ends = series.map((s, i) => {
    const last = [...s.values].reverse().find(v => v !== null);
    return { name: s.name, value: last, colour: colourOf(s, i), y: y(last ?? 0), baseline: s.baseline };
  }).filter(e => e.value !== undefined).sort((a, b) => a.y - b.y);

  for (let i = 1; i < ends.length; i++) {
    if (ends[i].y - ends[i - 1].y < 17) ends[i].y = ends[i - 1].y + 17;
  }

  host.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" class="chart-svg" role="img"
         aria-label="Rebased performance comparison">
      ${ticks.map(t => `
        <line x1="${L}" x2="${(W - R).toFixed(1)}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}"
              class="grid ${Math.abs(t) < (hi - lo) / 200 ? 'zero' : ''}"/>
        <text x="${(W - R + 6).toFixed(1)}" y="${(y(t) + 4).toFixed(1)}" class="axis">
          ${t > 0 ? '+' : ''}${t.toFixed(t >= 100 || t <= -100 ? 0 : 1)}%
        </text>`).join('')}

      ${dateTicks.map(i => `
        <line x1="${x(i).toFixed(1)}" x2="${x(i).toFixed(1)}" y1="${T}" y2="${H - B}"
              class="grid vertical"/>
        <text x="${x(i).toFixed(1)}" y="${H - 10}" class="axis"
              text-anchor="${i === 0 ? 'start' : i === dates.length - 1 ? 'end' : 'middle'}">
          ${dates[i].slice(2)}
        </text>`).join('')}

      ${series.map((s, i) => `
        <path d="${path(s.values)}" fill="none" class="series-line"
              stroke="${colourOf(s, i)}"
              stroke-width="${s.baseline ? 2 : 2.2}"
              stroke-dasharray="${s.baseline ? '5 4' : ''}"/>`).join('')}

      ${ends.map(e => `
        <rect x="${(W - R + 2).toFixed(1)}" y="${(e.y - 9).toFixed(1)}" width="${R - 6}" height="18"
              rx="3" fill="${e.colour}" opacity="${e.baseline ? 0.55 : 1}"/>
        <text x="${(W - R + 7).toFixed(1)}" y="${(e.y + 4).toFixed(1)}" class="end-label">
          ${signedPct(e.value)}
        </text>`).join('')}
    </svg>`;

  el('chartLegend').innerHTML = series.map((s, i) => {
    const last = [...s.values].reverse().find(v => v !== null);
    const colour = s.baseline ? 'var(--text-dim)' : LINE_COLOURS[i % LINE_COLOURS.length];
    return `<span class="legend-item">
      <i style="background:${colour}"></i>${s.name}
      <b>${signedPct(last)}</b>${s.baseline ? '<em>baseline</em>' : ''}
    </span>`;
  }).join('');

  renderCrossings(dates, base, drawable, baseName);
}

function baselineLabel(indexName) {
  const s = sectorBy(indexName);
  return s ? s.name : indexName;
}

function renderCrossings(dates, base, lines, baseName) {
  el('crossBaseName').textContent = baselineLabel(baseName);

  const rows = lines.filter(l => !l.isBase).map(l => {
    const cross = lastCrossing(l.values, base);
    const lastA = [...l.values].reverse().find(v => v !== null);
    const lastB = [...base].reverse().find(v => v !== null);
    const gap = lastA === undefined || lastB === undefined ? null : lastA - lastB;
    const above = gap !== null && gap > 0;

    let age = null;
    let when;
    if (cross) {
      const d = new Date(dates[cross.at]);
      age = Math.round((Date.now() - d.getTime()) / 86400000);
      when = `crossed ${cross.above ? 'above' : 'below'} on ${dates[cross.at]}`;
    } else {
      // No sign change at all: it has held one side for the entire window.
      when = `stayed ${above ? 'above' : 'below'} for the whole window`;
    }

    return { name: l.name, indexName: l.indexName, gap, above, when, age, cross };
  });

  // Freshest crossings first: those are the leadership changes worth acting on.
  rows.sort((a, b) => (a.age === null ? 1e9 : a.age) - (b.age === null ? 1e9 : b.age));

  el('crossList').innerHTML = rows.map(r => {
    const c = colourFor(r.gap);
    const fresh = r.age !== null && r.age <= 45;
    return `
      <div class="cross-row ${fresh ? 'fresh' : ''}">
        <span class="cross-name">${r.name}</span>
        <span class="cross-gap" style="color:${c.fg}">${signedPct(r.gap)}</span>
        <span class="cross-when">
          ${r.when}${r.age !== null ? ` <b>${r.age} days ago</b>` : ''}
        </span>
        ${fresh ? '<span class="cross-flag">recent change</span>' : ''}
      </div>`;
  }).join('') || '<p class="dim">Nothing else selected to compare against the baseline.</p>';
}

function renderChartControls() {
  const baseSel = el('baselineSelect');
  // Anything with a series can be the yardstick -- including a stock, so one
  // name can be measured against the leader rather than against the index.
  const options = selections().filter(i => seriesFor(i));

  const bmName = state.data.benchmark.indexName;
  const all = options.some(o => o.key === bmName)
    ? options
    : [{ key: bmName, name: state.data.benchmark.name }, ...options];

  const previous = baseSel.value;
  baseSel.innerHTML = all
    .map(o => `<option value="${o.key}">${o.name}</option>`).join('');
  baseSel.value = all.some(o => o.key === previous) ? previous : bmName;

  if (!el('chartPeriod').options.length) {
    el('chartPeriod').innerHTML = CHART_WINDOWS
      .map(([label, days]) => `<option value="${days}" ${label === '1Y' ? 'selected' : ''}>${label}</option>`)
      .join('');
  }
}

/* ------------------------------------------------------------ view switching */

function showView(view) {
  el('overviewView').classList.toggle('hidden', view !== 'overview');
  el('detailView').classList.toggle('hidden', view !== 'detail');
  el('compareView').classList.toggle('hidden', view !== 'compare');
  if (view !== 'overview') state.lastView = view;
}

/*
 * Drilling into a sector swaps one section for another without the browser
 * noticing, so a phone's back gesture used to leave the site entirely instead of
 * returning to the grid. Each drill-in now pushes a history entry, which makes
 * the hardware back button, the on-screen button and Escape all do the same
 * thing.
 *
 * The URL only changes over http; a snapshot opened from a file:// path is not
 * allowed to rewrite its own URL, so there the entry is pushed without one.
 */
function pushView(view, indexName) {
  const entry = { view, indexName: indexName || null };
  try {
    if (location.protocol.startsWith('http')) {
      const hash = view === 'detail' ? '#sector/' + encodeURIComponent(indexName)
                 : view === 'compare' ? '#compare' : '#';
      history.pushState(entry, '', hash);
    } else {
      history.pushState(entry, '');
    }
  } catch (e) {
    /* history blocked (sandboxed file view) - the on-screen button still works */
  }
}

function showOverview() {
  state.activeSector = null;
  showView('overview');
}

function goBack() {
  const current = history.state;
  if (current && current.view && current.view !== 'overview') {
    history.back();          // popstate renders it, keeping the stack honest
  } else {
    showOverview();
  }
}

window.addEventListener('popstate', (e) => {
  const entry = e.state;
  if (!entry || entry.view === 'overview') { showOverview(); return; }
  if (entry.view === 'detail' && entry.indexName) { openSector(entry.indexName, false); return; }
  if (entry.view === 'compare') { showView('compare'); renderCompare(); }
});

/** Reopen whatever the URL points at, once the data is actually loaded. */
function restoreFromUrl() {
  const hash = decodeURIComponent(location.hash || '');
  if (hash.startsWith('#sector/')) {
    const name = hash.slice('#sector/'.length);
    if (sectorBy(name)) { openSector(name, false); return; }
  }
  if (hash === '#compare' && state.selected.length >= 2) {
    showView('compare');
    renderCompare();
  }
}

/* ----------------------------------------------------------------- events */

el('refreshBtn').addEventListener('click', refreshData);
document.querySelectorAll('[data-back]').forEach(b => b.addEventListener('click', goBack));

// The logo doubles as the way home from a sector or the comparison.
el('brandHome').addEventListener('click', (e) => {
  e.preventDefault();
  if (el('overviewView').classList.contains('hidden')) goBack();
  else window.scrollTo({ top: 0, behavior: 'smooth' });
});

el('sectorSearch').addEventListener('input', (e) => {
  state.search = e.target.value.trim().toLowerCase();
  renderSections();
});

el('stockSearch').addEventListener('input', (e) => {
  state.stockSearch = e.target.value.trim().toLowerCase();
  renderDetail();
});

el('statusFilter').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  el('statusFilter').querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
  chip.classList.add('active');
  state.filter = chip.dataset.filter;
  renderSections();
});

el('sortBy').addEventListener('change', (e) => {
  state.sortBy = e.target.value;
  renderSections();
});

el('watchSelect').addEventListener('change', (e) => {
  watchlists.active = parseInt(e.target.value, 10);
  saveWatchlists();
  render();
});

el('watchStocksToggle').addEventListener('click', toggleWatchStocks);

el('watchNew').addEventListener('click', () => {
  const name = prompt('Name for the new watchlist:', `List ${watchlists.lists.length + 1}`);
  if (!name) return;
  watchlists.lists.push({ name: name.trim(), sectors: [], stocks: [] });
  watchlists.active = watchlists.lists.length - 1;
  saveWatchlists();
  render();
});

el('watchRename').addEventListener('click', () => {
  const list = activeList();
  const name = prompt('Rename this watchlist:', list.name);
  if (!name) return;
  list.name = name.trim();
  saveWatchlists();
  render();
});

el('watchDelete').addEventListener('click', () => {
  if (watchlists.lists.length < 2) return;
  const list = activeList();
  if (!confirm(`Delete "${list.name}"? Its ${list.sectors.length + list.stocks.length} entries go with it.`)) return;
  watchlists.lists.splice(watchlists.active, 1);
  watchlists.active = 0;
  saveWatchlists();
  render();
});

el('watchOnly').addEventListener('click', () => {
  state.watchOnly = !state.watchOnly;
  render();
});

el('rrgToggle').addEventListener('click', () => {
  const panel = el('rrgPanel');
  const open = panel.classList.toggle('hidden') === false;
  el('rrgToggle').setAttribute('aria-expanded', String(open));
  el('rrgToggle').classList.toggle('active', open);
  localStorage.setItem('rrgOpen', open ? '1' : '0');
  if (open) renderRrg();
});

el('rrgView').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  el('rrgView').querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
  chip.classList.add('active');
  state.rrgView = chip.dataset.view;
  localStorage.setItem('rrgView', state.rrgView);
  renderRrg();
});

el('rrgGroup').addEventListener('change', () => {
  localStorage.setItem('rrgGroup', el('rrgGroup').value);
  renderRrg();
});

el('periodSelect').addEventListener('change', (e) => {
  state.period = e.target.value;
  localStorage.setItem('period', e.target.value);
  render();
  if (state.activeSector) renderDetail();
  if (!el('compareView').classList.contains('hidden')) renderCompare();
});

el('colourStep').addEventListener('change', (e) => {
  state.colourStep = parseFloat(e.target.value);
  localStorage.setItem('colourStep', e.target.value);
  render();
  if (state.activeSector) renderDetail();
  if (!el('compareView').classList.contains('hidden')) renderCompare();
});

el('baselineSelect').addEventListener('change', renderChart);
el('chartPeriod').addEventListener('change', renderChart);

el('openCompare').addEventListener('click', () => {
  if (state.selected.length + state.selectedStocks.length < 1) return;
  pushView('compare');
  showView('compare');
  renderCompare();
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

el('stockFilter').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  el('stockFilter').querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
  chip.classList.add('active');
  state.stockFilter = chip.dataset.sfilter;
  renderDetail();
});

el('capFilter').addEventListener('change', (e) => {
  state.capFilter = e.target.value;
  renderDetail();
});

el('stockSort').addEventListener('change', (e) => {
  state.stockSort = e.target.value;
  renderDetail();
});

el('clearCompare').addEventListener('click', () => {
  state.selected = [];
  state.selectedStocks = [];
  renderSections();
  renderTray();
  if (!el('compareView').classList.contains('hidden')) goBack();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && el('overviewView').classList.contains('hidden')) goBack();
});

const savedStep = localStorage.getItem('colourStep');
if (savedStep) {
  state.colourStep = parseFloat(savedStep);
  el('colourStep').value = savedStep;
}

const savedPeriod = localStorage.getItem('period');
if (savedPeriod) state.period = savedPeriod;

// The rotation map stays where it was left -- open for whoever uses it, out of
// the way for whoever doesn't.
const savedGroup = localStorage.getItem('rrgGroup');
if (savedGroup) el('rrgGroup').value = savedGroup;

const savedView = localStorage.getItem('rrgView');
if (savedView) {
  state.rrgView = savedView;
  el('rrgView').querySelectorAll('.chip').forEach(c =>
    c.classList.toggle('active', c.dataset.view === savedView));
}
if (localStorage.getItem('rrgOpen') === '1') {
  el('rrgPanel').classList.remove('hidden');
  el('rrgToggle').classList.add('active');
  el('rrgToggle').setAttribute('aria-expanded', 'true');
}

// Anchor the stack so the first back press has somewhere to land.
try { history.replaceState({ view: 'overview', indexName: null }, ''); } catch (e) { /* ignore */ }

async function loadStocks() {
  if (window.EMBEDDED_STOCKS) { stockBook = window.EMBEDDED_STOCKS; return; }
  if (window.EMBEDDED_DATA) return;         // snapshot built without stock detail
  try {
    const res = await fetch('/api/stocks');
    if (res.ok) stockBook = await res.json();
  } catch (e) {
    /* stock detail is an enhancement; the sector view works without it */
  }
  // The watchlist table and the grid both read from this, and both may have
  // rendered before it arrived.
  renderWatchStocks();
  renderSections();
  if (state.activeSector) renderDetail();
}

loadCached();
loadHistory();
loadStocks();
