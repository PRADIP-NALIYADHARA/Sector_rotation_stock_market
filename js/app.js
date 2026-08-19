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
  selected: [],      // indexNames chosen for comparison
  lastView: 'overview',
};

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
  renderFreshness();

  // Drop selections that no longer exist.
  state.selected = state.selected.filter(sectorBy);

  render();
  if (state.activeSector) {
    const fresh = sectorBy(state.activeSector.indexName);
    if (fresh) { state.activeSector = fresh; renderDetail(); }
  } else {
    restoreFromUrl();
  }
}

/* -------------------------------------------------------------- rendering */

function render() {
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

function visibleSectors() {
  if (!state.data) return [];
  return state.data.sectors.filter(s => {
    const rs = rsOf(s);
    if (state.filter === 'bull' && !(rs > 0)) return false;
    if (state.filter === 'bear' && !(rs < 0)) return false;
    if (state.filter === 'breakout' && !(s.lead && s.lead.breakingOut)) return false;
    if (state.search) {
      const q = state.search;
      if (!s.name.toLowerCase().includes(q) && !s.indexName.toLowerCase().includes(q)) return false;
    }
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

function renderSections() {
  const container = el('sectionsContainer');
  if (!state.data) { container.innerHTML = ''; return; }

  const visible = visibleSectors();
  el('resultCount').textContent = `${visible.length} of ${state.data.sectors.length}`;

  const html = GROUP_ORDER.map(group => {
    const list = sortSectors(visible.filter(s => s.group === group));
    if (!list.length) return '';
    return `
      <section class="group-section">
        <div class="group-header">
          <h2>${group}</h2>
          <span class="group-count">${list.length}</span>
          <span class="group-blurb dim">${GROUP_BLURB[group]}</span>
        </div>
        <div class="sector-grid">${list.map(sectorCard).join('')}</div>
      </section>`;
  }).join('');

  container.innerHTML = html || '<div class="empty-state"><p>Nothing matches this filter.</p></div>';

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
        <button class="compare-toggle ${picked ? 'on' : ''}" data-sector="${s.indexName}"
                title="Add to comparison">${picked ? '✓' : '+'}</button>
      </div>
      ${lead.breakingOut ? '<div class="breakout-badge">⚡ Leading breakout</div>' : ''}
      <div class="sector-figures">
        <span class="sector-value" style="color:${c.fg}">${signedPct(rs)}</span>
        <span class="rs-tag" style="color:${c.fg}">${verdict} benchmark</span>
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

  renderPeriodTable(s);
  renderOverlaps(s);

  const stocks = s.stocks.filter(st => {
    if (!state.stockSearch) return true;
    const q = state.stockSearch;
    return st.symbol.toLowerCase().includes(q) || st.company.toLowerCase().includes(q);
  });

  const near = s.stocks.filter(st => st.nearHigh).length;
  el('stockCount').textContent =
    `${stocks.length} of ${s.stocks.length} stocks · ${near} within 5% of a 52-week high`;

  el('stockBody').innerHTML = stocks.map(st => {
    const c = colourFor(st.pChange);
    const fh = colourFor(st.fromHigh === null ? null : st.fromHigh + 5);  // near high reads green
    const fresh = st.daysSinceHigh !== null && st.daysSinceHigh !== undefined && st.daysSinceHigh <= 10;
    return `
      <tr class="${st.nearHigh ? 'near-high' : ''}" style="border-left:3px solid ${c.border}">
        <td class="sym">${st.symbol}${st.nearHigh ? ' <span class="near-flag">⚡</span>' : ''}</td>
        <td>${st.company}</td>
        <td class="right">${fmt(st.close)}</td>
        <td class="pchange" style="color:${c.fg}">${signedPct(st.pChange)}</td>
        <td class="right">${fmt(st.high52)}</td>
        <td class="right" style="color:${fh.fg};font-weight:700">${signedPct(st.fromHigh)}</td>
        <td class="${fresh ? 'fresh-high' : 'dim'}">${st.highDate || '—'}</td>
      </tr>`;
  }).join('');
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

function renderTray() {
  const tray = el('compareTray');
  if (!state.selected.length) { tray.classList.add('hidden'); return; }

  tray.classList.remove('hidden');
  el('trayItems').innerHTML = state.selected.map(name => {
    const s = sectorBy(name);
    if (!s) return '';
    const c = colourFor(s.pChange);
    return `<span class="tray-chip" style="border-color:${c.border}">
      ${s.name}<button class="tray-remove" data-sector="${name}" aria-label="Remove">×</button>
    </span>`;
  }).join('');

  el('trayItems').querySelectorAll('.tray-remove').forEach(btn => {
    btn.addEventListener('click', () => toggleCompare(btn.dataset.sector));
  });

  el('openCompare').textContent = `Compare ${state.selected.length}`;
  el('openCompare').disabled = state.selected.length < 2;
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

function renderCompare() {
  const chosen = state.selected.map(sectorBy).filter(Boolean);
  el('compareCount').textContent = chosen.length;

  renderChartControls();
  renderChart();

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

  return {
    deviation,
    bullish: deviation < 0,
    asOf: points[last].date,
    since: flipped,
    days: flipped ? Math.round((Date.now() - new Date(flipped + 'T00:00:00')) / 86400000) : null,
  };
}

function renderRegime() {
  const box = el('regimeBox');
  const regime = computeRegime();

  if (!regime) {
    el('regimeVerdict').textContent = '—';
    el('regimeDetail').textContent = historyError
      ? 'needs price history' : 'not enough daily history yet';
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
    `G-Sec/Nifty ${Math.abs(regime.deviation).toFixed(2)}% ${side} its 30-day average`
    + (regime.days !== null ? ` · ${regime.days}d` : '');

  box.style.borderColor = colour.border;
  box.style.background = colour.bg;
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

function windowSlice(days) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const iso = cutoff.toISOString().slice(0, 10);
  const from = priceHistory.dates.findIndex(d => d >= iso);
  return from < 0 ? priceHistory.dates.length - 2 : from;
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

  const baseRaw = chartableSeries(baseName);
  const base = baseRaw && rebase(baseRaw, from);

  const lines = state.selected.map(name => {
    const sector = sectorBy(name);
    const raw = chartableSeries(name);
    return {
      name: sector ? sector.name : name,
      indexName: name,
      values: raw ? rebase(raw, from) : null,
      isBase: name === baseName,
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

  const W = 900, H = 340, L = 52, R = 12, T = 14, B = 26;
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
  for (let k = 0; k <= 4; k++) ticks.push(lo + (hi - lo) * (k / 4));

  const dateLabels = [0, Math.floor(dates.length / 2), dates.length - 1]
    .filter((v, i, a) => a.indexOf(v) === i);

  host.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="chart-svg" role="img"
         aria-label="Rebased performance comparison">
      ${ticks.map(t => `
        <line x1="${L}" x2="${W - R}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}"
              class="grid ${Math.abs(t) < 1e-9 ? 'zero' : ''}"/>
        <text x="${L - 8}" y="${(y(t) + 4).toFixed(1)}" class="axis" text-anchor="end">
          ${t > 0 ? '+' : ''}${t.toFixed(0)}%
        </text>`).join('')}
      ${dateLabels.map(i => `
        <text x="${x(i).toFixed(1)}" y="${H - 8}" class="axis"
              text-anchor="${i === 0 ? 'start' : i === dates.length - 1 ? 'end' : 'middle'}">
          ${dates[i]}
        </text>`).join('')}
      ${series.map((s, i) => `
        <path d="${path(s.values)}" fill="none"
              stroke="${s.baseline ? 'var(--text-dim)' : LINE_COLOURS[i % LINE_COLOURS.length]}"
              stroke-width="${s.baseline ? 2.5 : 2}"
              stroke-dasharray="${s.baseline ? '6 4' : ''}"/>`).join('')}
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
  const options = state.selected
    .map(sectorBy)
    .filter(s => s && chartableSeries(s.indexName));

  const bmName = state.data.benchmark.indexName;
  const all = options.some(o => o.indexName === bmName)
    ? options
    : [{ indexName: bmName, name: state.data.benchmark.name }, ...options];

  const previous = baseSel.value;
  baseSel.innerHTML = all
    .map(o => `<option value="${o.indexName}">${o.name}</option>`).join('');
  baseSel.value = all.some(o => o.indexName === previous) ? previous : bmName;

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
  if (state.selected.length < 2) return;
  pushView('compare');
  showView('compare');
  renderCompare();
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

el('clearCompare').addEventListener('click', () => {
  state.selected = [];
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

// Anchor the stack so the first back press has somewhere to land.
try { history.replaceState({ view: 'overview', indexName: null }, ''); } catch (e) { /* ignore */ }

loadCached();
loadHistory();
