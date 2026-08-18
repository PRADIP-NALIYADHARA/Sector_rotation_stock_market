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

  // Drop selections that no longer exist.
  state.selected = state.selected.filter(sectorBy);

  render();
  if (state.activeSector) {
    const fresh = sectorBy(state.activeSector.indexName);
    if (fresh) { state.activeSector = fresh; renderDetail(); }
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

function openSector(indexName) {
  const sector = sectorBy(indexName);
  if (!sector) return;
  state.activeSector = sector;
  state.stockSearch = '';
  el('stockSearch').value = '';
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

/* ------------------------------------------------------------ view switching */

function showView(view) {
  el('overviewView').classList.toggle('hidden', view !== 'overview');
  el('detailView').classList.toggle('hidden', view !== 'detail');
  el('compareView').classList.toggle('hidden', view !== 'compare');
  if (view !== 'overview') state.lastView = view;
}

function goBack() {
  state.activeSector = null;
  showView('overview');
}

/* ----------------------------------------------------------------- events */

el('refreshBtn').addEventListener('click', refreshData);
document.querySelectorAll('[data-back]').forEach(b => b.addEventListener('click', goBack));

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

el('openCompare').addEventListener('click', () => {
  if (state.selected.length < 2) return;
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

loadCached();
