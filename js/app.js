const el = (id) => document.getElementById(id);

let state = { data: null, filter: 'all', search: '', activeSector: null, stockSearch: '' };

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
  document.querySelectorAll('.thBull').forEach(s => s.textContent = '+' + data.thresholds.bullish);
  document.querySelectorAll('.thBear').forEach(s => s.textContent = data.thresholds.bearish);

  const counts = { bullish: 0, bearish: 0, neutral: 0 };
  data.sectors.forEach(s => counts[s.status]++);
  el('countBullish').textContent = counts.bullish;
  el('countBearish').textContent = counts.bearish;
  el('countNeutral').textContent = counts.neutral;

  renderSectors();
  if (state.activeSector) {
    const fresh = data.sectors.find(s => s.name === state.activeSector.name);
    if (fresh) { state.activeSector = fresh; renderDetail(); }
  }
}

// Sector grid
function renderSectors() {
  const grid = el('sectorGrid');
  if (!state.data) return;

  const list = state.data.sectors.filter(s => {
    if (state.filter !== 'all' && s.status !== state.filter) return false;
    if (state.search && !s.name.toLowerCase().includes(state.search)) return false;
    return true;
  });

  if (!list.length) {
    grid.innerHTML = '<div class="empty-state"><p>No sectors match this filter.</p></div>';
    return;
  }

  grid.innerHTML = list.map((s, i) => {
    const adv = parseInt(s.advances || 0, 10);
    const dec = parseInt(s.declines || 0, 10);
    const total = adv + dec || 1;
    return `
      <div class="sector-card ${s.status}" data-sector="${s.name}" style="animation-delay:${i * 35}ms">
        <div class="sector-card-top">
          <div>
            <div class="sector-name">${s.name}</div>
            <div class="sector-index">${s.indexName}</div>
          </div>
          <span class="badge ${s.status}">${s.status}</span>
        </div>
        <div class="sector-figures">
          <span class="sector-value">${fmt(s.last)}</span>
          <span class="sector-change ${s.status}">${signedPct(s.pChange)}</span>
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

// Detail view
function openSector(name) {
  const sector = state.data.sectors.find(s => s.name === name);
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
  el('detailLast').textContent = fmt(s.last);

  const change = el('detailChange');
  change.textContent = signedPct(s.pChange);
  change.className = 'stat-value ' + s.status;

  el('detailAdvDec').textContent = `${s.advances || 0} / ${s.declines || 0}`;

  const status = el('detailStatus');
  status.textContent = s.status.charAt(0).toUpperCase() + s.status.slice(1);
  status.className = 'stat-value ' + s.status;

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
      <td><span class="badge ${st.status}">${st.status}</span></td>
    </tr>`).join('');
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

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.activeSector) closeSector();
});

loadCached();
