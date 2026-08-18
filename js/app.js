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
  sortBy: 'pChange',
  search: '',
  colourStep: 5,
  activeSector: null,
  stockSearch: '',
  selected: [],      // indexNames chosen for comparison
  lastView: 'overview',
};

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
  renderScaleLegend();
  renderSections();
  renderTray();
}

function visibleSectors() {
  if (!state.data) return [];
  return state.data.sectors.filter(s => {
    if (state.filter === 'bull' && !(s.pChange > 0)) return false;
    if (state.filter === 'bear' && !(s.pChange < 0)) return false;
    if (state.search) {
      const q = state.search;
      if (!s.name.toLowerCase().includes(q) && !s.indexName.toLowerCase().includes(q)) return false;
    }
    return true;
  });
}

function sortSectors(list) {
  const key = state.sortBy;
  if (key === 'name') return [...list].sort((a, b) => a.name.localeCompare(b.name));
  return [...list].sort((a, b) => {
    const av = a[key], bv = b[key];
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
  const c = colourFor(s.pChange);
  const c30 = colourFor(s.pChange30d);
  const c365 = colourFor(s.pChange365d);
  const adv = s.advances || 0;
  const dec = s.declines || 0;
  const total = adv + dec || 1;
  const hasLevel = s.last !== null && s.last !== undefined;
  const picked = state.selected.includes(s.indexName);

  return `
    <div class="sector-card" data-sector="${s.indexName}" style="border-left-color:${c.border}">
      <div class="sector-card-top">
        <div>
          <div class="sector-name">${s.name}</div>
          <div class="sector-index">${s.indexName}</div>
        </div>
        <button class="compare-toggle ${picked ? 'on' : ''}" data-sector="${s.indexName}"
                title="Add to comparison">${picked ? '✓' : '+'}</button>
      </div>
      <div class="sector-figures">
        <span class="sector-value">${hasLevel ? fmt(s.last) : signedPct(s.pChange)}</span>
        ${hasLevel ? `<span class="sector-change" style="color:${c.fg}">${signedPct(s.pChange)}</span>` : ''}
      </div>
      <div class="trend-row">
        <span>30d <b style="color:${c30.fg}">${signedPct(s.pChange30d)}</b></span>
        <span>1y <b style="color:${c365.fg}">${signedPct(s.pChange365d)}</b></span>
      </div>
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

  [['detailChange', s.pChange], ['detail30d', s.pChange30d], ['detail365d', s.pChange365d]]
    .forEach(([id, v]) => {
      const node = el(id);
      node.textContent = signedPct(v);
      node.style.color = colourFor(v).fg;
    });

  el('detailAdvDec').textContent = `${s.advances || 0} / ${s.declines || 0}`;

  renderOverlaps(s);

  const stocks = s.stocks.filter(st => {
    if (!state.stockSearch) return true;
    const q = state.stockSearch;
    return st.symbol.toLowerCase().includes(q) || st.company.toLowerCase().includes(q);
  });

  el('stockCount').textContent = `${stocks.length} of ${s.stocks.length} stocks`;
  el('stockBody').innerHTML = stocks.map(st => {
    const c = colourFor(st.pChange);
    return `
      <tr style="border-left:3px solid ${c.border}">
        <td class="sym">${st.symbol}</td>
        <td>${st.company}</td>
        <td class="right">${fmt(st.prevClose)}</td>
        <td class="right">${fmt(st.close)}</td>
        <td class="pchange" style="color:${c.fg}">${signedPct(st.pChange)}</td>
      </tr>`;
  }).join('');
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

const COMPARE_ROWS = [
  ['Group', s => s.group],
  ['Index level', s => s.last === null || s.last === undefined ? '—' : fmt(s.last)],
  ['Today', s => s.pChange, true],
  ['30 days', s => s.pChange30d, true],
  ['1 year', s => s.pChange365d, true],
  ['Advances', s => s.advances || 0],
  ['Declines', s => s.declines || 0],
  ['Constituents', s => s.stocks.length],
  ['Best stock', s => topStock(s, 'best')],
  ['Worst stock', s => topStock(s, 'worst')],
];

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

  el('compareBody').innerHTML = COMPARE_ROWS.map(([label, get, isPct]) => {
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

loadCached();
