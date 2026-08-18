const el = (id) => document.getElementById(id);

let state = {
  data: null,
  filter: 'all',
  group: 'all',
  sortBy: 'pChange',
  search: '',
  activeSector: null,
  stockSearch: '',
};

// Theme
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
});

function showStatus(message, kind) {
  const bar = el('statusBar');
  bar.textContent = message;
  bar.className = 'status-bar' + (kind ? ' ' + kind : '');
  if (kind === 'success') {
    setTimeout(() => bar.classList.add('hidden'), 4000);
  }
}

function fmt(n, digits = 2) {
  if (n === null || n === undefined) return '—';
  return n.toLocaleString('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function signedPct(n) {
  if (n === null || n === undefined) return '—';
  return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
}

// Data loading
async function loadCached() {
  try {
    const res = await fetch('/api/sectors');
    if (res.status === 404) {
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
  showStatus('Fetching latest data from NSE… this usually takes 30–60 seconds.', null);

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
  el('marketDate').textContent = 'Market date: ' + (data.bhavDate || '—');
  el('updatedAt').textContent = 'Updated ' + new Date(data.updatedAt).toLocaleString('en-IN');
  const th = data.thresholds || {};
  const setTh = (cls, v, sign) => document.querySelectorAll(cls)
    .forEach(s => { if (v !== undefined) s.textContent = (sign && v > 0 ? '+' : '') + v; });
  setTh('.thStrongBull', th.strongBullish, true);
  setTh('.thBull', th.bullish, true);
  setTh('.thBear', th.bearish, false);
  setTh('.thStrongBear', th.strongBearish, false);

  const counts = { 'strong-bullish': 0, bullish: 0, neutral: 0, bearish: 0, 'strong-bearish': 0 };
  data.sectors.forEach(s => { counts[s.status] = (counts[s.status] || 0) + 1; });
  el('countStrongBullish').textContent = counts['strong-bullish'];
  el('countBullish').textContent = counts.bullish;
  el('countNeutral').textContent = counts.neutral;
  el('countBearish').textContent = counts.bearish;
  el('countStrongBearish').textContent = counts['strong-bearish'];

  renderSectors();
  if (state.activeSector) {
    const fresh = data.sectors.find(s => s.indexName === state.activeSector.indexName);
    if (fresh) { state.activeSector = fresh; renderDetail(); }
  }
}

// Sector grid
function renderSectors() {
  const grid = el('sectorGrid');
  if (!state.data) return;

  const list = state.data.sectors.filter(s => {
    if (state.filter === 'bull' && !s.status.includes('bullish')) return false;
    if (state.filter === 'bear' && !s.status.includes('bearish')) return false;
    if (state.filter === 'neutral' && s.status !== 'neutral') return false;
    if (state.group !== 'all' && s.group !== state.group) return false;
    if (state.search && !s.name.toLowerCase().includes(state.search)
        && !s.indexName.toLowerCase().includes(state.search)) return false;
    return true;
  });

  const key = state.sortBy;
  if (key === 'name') {
    list.sort((a, b) => a.name.localeCompare(b.name));
  } else {
    list.sort((a, b) => {
      const av = a[key], bv = b[key];
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      return bv - av;
    });
  }

  el('resultCount').textContent = `${list.length} of ${state.data.sectors.length} sectors`;

  if (!list.length) {
    grid.innerHTML = '<div class="empty-state"><p>No sectors match this filter.</p></div>';
    return;
  }

  grid.innerHTML = list.map((s, i) => {
    const adv = s.advances || 0;
    const dec = s.declines || 0;
    const total = adv + dec || 1;
    const headline = s.last !== null && s.last !== undefined ? fmt(s.last) : signedPct(s.pChange);
    const secondary = s.last !== null && s.last !== undefined ? signedPct(s.pChange) : '';
    return `
      <div class="sector-card ${s.status}" data-sector="${s.indexName}" style="animation-delay:${Math.min(i, 20) * 30}ms">
        <div class="sector-card-top">
          <div>
            <div class="sector-name">${s.name}</div>
            <div class="sector-index">${s.indexName}</div>
          </div>
          <div class="badge-stack">
            <span class="badge ${s.status}">${statusLabel(s.status)}</span>
            <span class="group-tag">${s.group}</span>
          </div>
        </div>
        <div class="sector-figures">
          <span class="sector-value">${headline}</span>
          <span class="sector-change ${s.status}">${secondary}</span>
        </div>
        <div class="trend-row">
          <span>30d <b class="${trendClass(s.pChange30d)}">${signedPct(s.pChange30d)}</b></span>
          <span>1y <b class="${trendClass(s.pChange365d)}">${signedPct(s.pChange365d)}</b></span>
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
  }).join('');

  grid.querySelectorAll('.sector-card').forEach(card => {
    card.addEventListener('click', () => openSector(card.dataset.sector));
  });
}

function trendClass(v) {
  if (v === null || v === undefined) return 'dim';
  const th = (state.data && state.data.thresholds) || {};
  if (v >= (th.strongBullish ?? 1.5)) return 'strong-bullish';
  if (v >= (th.bullish ?? 0.4)) return 'bullish';
  if (v <= (th.strongBearish ?? -1.5)) return 'strong-bearish';
  if (v <= (th.bearish ?? -0.4)) return 'bearish';
  return 'dim';
}

function statusLabel(status) {
  return {
    'strong-bullish': 'strong bull',
    'bullish': 'bullish',
    'neutral': 'moderate',
    'bearish': 'bearish',
    'strong-bearish': 'strong bear',
  }[status] || status;
}

// Detail view
function openSector(indexName) {
  const sector = state.data.sectors.find(s => s.indexName === indexName);
  if (!sector) return;
  state.activeSector = sector;
  state.stockSearch = '';
  el('stockSearch').value = '';
  el('overviewView').classList.add('hidden');
  el('detailView').classList.remove('hidden');
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

  const change = el('detailChange');
  change.textContent = signedPct(s.pChange);
  change.className = 'stat-value ' + s.status;

  const d30 = el('detail30d');
  d30.textContent = signedPct(s.pChange30d);
  d30.className = 'stat-value ' + trendClass(s.pChange30d);

  const d365 = el('detail365d');
  d365.textContent = signedPct(s.pChange365d);
  d365.className = 'stat-value ' + trendClass(s.pChange365d);

  el('detailAdvDec').textContent = `${s.advances || 0} / ${s.declines || 0}`;

  const status = el('detailStatus');
  const label = statusLabel(s.status);
  status.textContent = label.charAt(0).toUpperCase() + label.slice(1);
  status.className = 'stat-value ' + s.status;

  renderOverlaps(s);

  const stocks = s.stocks.filter(st => {
    if (!state.stockSearch) return true;
    const q = state.stockSearch;
    return st.symbol.toLowerCase().includes(q) || st.company.toLowerCase().includes(q);
  });

  el('stockCount').textContent = `${stocks.length} of ${s.stocks.length} stocks`;

  el('stockBody').innerHTML = stocks.map(st => `
    <tr class="${st.status}">
      <td class="sym">${st.symbol}</td>
      <td>${st.company}</td>
      <td class="right">${fmt(st.prevClose)}</td>
      <td class="right">${fmt(st.close)}</td>
      <td class="pchange ${st.status}">${signedPct(st.pChange)}</td>
      <td><span class="badge ${st.status}">${statusLabel(st.status)}</span></td>
    </tr>`).join('');
}

// Many NSE indices deliberately share constituents (Bank / Private Bank / PSU Bank,
// and every index overlaps its industry group). Show that so three views of the
// same stocks aren't mistaken for three independent signals.
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

function closeSector() {
  state.activeSector = null;
  el('detailView').classList.add('hidden');
  el('overviewView').classList.remove('hidden');
}

// Events
el('refreshBtn').addEventListener('click', refreshData);
el('backBtn').addEventListener('click', closeSector);

el('sectorSearch').addEventListener('input', (e) => {
  state.search = e.target.value.trim().toLowerCase();
  renderSectors();
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
  renderSectors();
});

el('groupFilter').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  el('groupFilter').querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
  chip.classList.add('active');
  state.group = chip.dataset.group;
  renderSectors();
});

el('sortBy').addEventListener('change', (e) => {
  state.sortBy = e.target.value;
  renderSectors();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.activeSector) closeSector();
});

loadCached();
