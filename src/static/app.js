// State 

let windowSeconds = 60;
let alertThreshold = -0.10;
let chartReady = false, scoreChart;
let sparkReady = false, sparkChart;
let histReady = false, histChart;
let graphsReady = false;
let gBytesChart, gFlowsChart, gDestsChart, gPortsChart, gAvgChart;
let expandedAlerts = new Set();
let logPinned = false;
let monitorOffset = 0;
const MONITOR_LIMIT = 50;

const SPARK_LIMIT = 30;
const SCORE_LIMIT = 200;
const GRAPHS_LIMIT = 60;

let alertFilters = { start: null, end: null, label: '' };
let monitorFilters = { start: null, end: null };

let notifEnabled = localStorage.getItem('sentinel-notif') === '1';
let lastAlertTs = parseFloat(localStorage.getItem('sentinel-last-alert-ts') || '0');
let lastAlertSeeded = false;

// Theme

function updateLogos(theme) {
  const sidebarLogo = document.getElementById('sidebar-logo');
  const favicon = document.getElementById('favicon');
  const logoName = theme === 'light' ? 'lightLogo.png' : 'darkLogo.png';
  if (sidebarLogo) sidebarLogo.src = `/static/img/${logoName}`;
  if (favicon) favicon.href = `/static/img/${logoName}`;
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const label = document.getElementById('theme-label');
  if (label) label.textContent = theme === 'light' ? 'Light' : 'Dark';
  updateLogos(theme);
  localStorage.setItem('sentinel-theme', theme);
}

function initTheme() {
  const saved = localStorage.getItem('sentinel-theme')
    || (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  applyTheme(saved);
}

document.getElementById('theme-toggle').addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme') || 'dark';
  applyTheme(current === 'dark' ? 'light' : 'dark');
  if (chartReady) refreshChart();
  if (sparkReady) refreshSparkline();
  if (histReady) refreshHistChart();
  if (graphsReady) refreshGraphs();
});

initTheme();

// Navigation 

const sections = document.querySelectorAll('section[data-section]');
const navLinks  = document.querySelectorAll('nav a[data-section]');

function showSection(name) {
  sections.forEach(s => s.classList.toggle('active', s.dataset.section === name));
  navLinks.forEach(a => a.classList.toggle('active', a.dataset.section === name));
  if (name === 'alerts' && !chartReady) initChart();
  if (name === 'alerts' && !histReady) initHistChart();
  if (name === 'graphs' && !graphsReady) initGraphs();
}

navLinks.forEach(a => a.addEventListener('click', e => {
  e.preventDefault();
  showSection(a.dataset.section);
}));

showSection('overview');

// Helpers 

function fmtTime(ts) {
  if (!ts) return 'N/A';
  return new Date(ts * 1000).toLocaleString();
}

function fmtScore(s) {
  return typeof s === 'number' ? s.toFixed(4) : '-';
}

function fmtNum(n, dec = 1) {
  return typeof n === 'number' ? n.toFixed(dec) : '-';
}

function fmtUptime(s) {
  if (s === null || s === undefined) return '';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (h > 0) return `up ${h}h ${m}m`;
  if (m > 0) return `up ${m}m ${sec}s`;
  return `up ${sec}s`;
}

function localInputToEpoch(id) {
  const val = document.getElementById(id).value;
  if (!val) return null;
  const t = new Date(val).getTime();
  return isNaN(t) ? null : t / 1000;
}

function chartColors() {
  const dark = (document.documentElement.getAttribute('data-theme') || 'dark') !== 'light';
  return dark
    ? { tick: '#555', grid: '#1e1e1e', tooltipBg: '#1a1a1a', tooltipBorder: '#2a2a2a', tooltipTitle: '#f0f0f0', tooltipBody: '#aaa' }
    : { tick: '#8a8a8a', grid: '#e4e4e4', tooltipBg: '#ffffff', tooltipBorder: '#dcdcdc', tooltipTitle: '#111', tooltipBody: '#444' };
}

// Chart pagination (scroll back through history) 
// Rows come back newest-first with offset=0. Increasing offset walks further
// into the past ("Older"); decreasing it walks back toward the present ("Newer").

function makePager(prefix, limit) {
  const state = { offset: 0, total: 0, limit };
  const prevBtn = document.getElementById(`${prefix}-prev`);
  const nextBtn = document.getElementById(`${prefix}-next`);
  const rangeEl = document.getElementById(`${prefix}-range`);

  function render(rowsLength) {
    const start = state.total ? state.offset + 1 : 0;
    const end = Math.min(state.offset + rowsLength, state.total);
    rangeEl.textContent = state.total ? `${start}–${end} of ${state.total}` : '0 rows';
    prevBtn.disabled = !state.total || end >= state.total;
    nextBtn.disabled = state.offset === 0;
  }

  prevBtn.addEventListener('click', () => {
    state.offset += state.limit;
    onChangeFns[prefix]();
  });
  nextBtn.addEventListener('click', () => {
    state.offset = Math.max(0, state.offset - state.limit);
    onChangeFns[prefix]();
  });

  return { state, render };
}

const onChangeFns = {};

// Notifications & sound 

function updateNotifButton() {
  const btn = document.getElementById('notif-toggle');
  btn.textContent = notifEnabled ? 'Disable notifications' : 'Enable notifications';
  btn.classList.toggle('active', notifEnabled);
}

document.getElementById('notif-toggle').addEventListener('click', async () => {
  if (!notifEnabled) {
    if ('Notification' in window && Notification.permission !== 'granted') {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { updateNotifButton(); return; }
    }
    notifEnabled = true;
  } else {
    notifEnabled = false;
  }
  localStorage.setItem('sentinel-notif', notifEnabled ? '1' : '0');
  updateNotifButton();
});

updateNotifButton();

function playBeep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.35);
  } catch {}
}

function notifyNewAlert(alert) {
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification('Sentinel: anomaly detected', {
      body: `Score ${fmtScore(alert.score)} at ${fmtTime(alert.timestamp)}`,
    });
  }
  playBeep();
}

function checkNewAlert(latestAlerts) {
  if (!latestAlerts.length) return;
  const newest = latestAlerts[0].timestamp;
  if (!lastAlertSeeded) {
    lastAlertSeeded = true;
    if (newest > lastAlertTs) {
      lastAlertTs = newest;
      localStorage.setItem('sentinel-last-alert-ts', String(lastAlertTs));
    }
    return;
  }
  if (newest > lastAlertTs) {
    lastAlertTs = newest;
    localStorage.setItem('sentinel-last-alert-ts', String(lastAlertTs));
    if (notifEnabled) notifyNewAlert(latestAlerts[0]);
  }
}

// Banner (four states: alert > offline > paused > secure) 

function refreshBanner(backend, latestAlerts, captureStale) {
  const banner = document.getElementById('banner');
  const msg    = banner.querySelector('.banner-msg');

  if (latestAlerts.length) {
    const age = Date.now() / 1000 - latestAlerts[0].timestamp;
    if (age < 300) {
      banner.className = 'banner alert';
      msg.innerHTML = `Anomaly detected &nbsp;&middot;&nbsp; <strong>${fmtTime(latestAlerts[0].timestamp)}</strong> &nbsp;&middot;&nbsp; score <strong>${fmtScore(latestAlerts[0].score)}</strong>`;
      return;
    }
  }

  if (!backend.running) {
    banner.className = 'banner warn';
    msg.textContent  = 'Backend offline - packet monitoring is not active';
    return;
  }

  /*
  if (captureStale) {
    banner.className = 'banner paused';
    msg.textContent  = 'Backend running but capture appears paused (no new windows recently)';
    return;
  }
  */

  banner.className = 'banner ok';
  msg.textContent  = 'Monitoring active';
}

// Overview 

function refreshOverview(s, b) {
  document.getElementById('ov-alerts').textContent  = s.total_alerts;
  document.getElementById('ov-windows').textContent = s.monitor_count;
  document.getElementById('ov-last').textContent    = fmtTime(s.last_seen);

  const modelEl = document.getElementById('ov-model');
  modelEl.textContent = s.model_loaded ? 'Loaded' : 'None';
  modelEl.className   = 'card-value ' + (s.model_loaded ? 'green' : 'red');

  const backendEl = document.getElementById('ov-backend');
  backendEl.textContent = b.running ? 'Running' : 'Stopped';
  backendEl.className   = 'card-value ' + (b.running ? 'green' : 'red');
  document.getElementById('ov-uptime').textContent = b.running ? fmtUptime(b.uptime) : '';
}

// Sparkline (packets per window) 

const sparkPager = makePager('spark', SPARK_LIMIT);
onChangeFns.spark = () => refreshSparkline();

async function fetchSparkRows() {
  const data = await fetch(`/api/monitor?limit=${SPARK_LIMIT}&offset=${sparkPager.state.offset}`).then(r => r.json());
  sparkPager.state.total = data.total;
  sparkPager.render(data.rows.length);
  return data.rows.slice().reverse();
}

async function initSparkline() {
  sparkReady = true;
  const rows = await fetchSparkRows();
  const ctx  = document.getElementById('spark-chart').getContext('2d');
  const c = chartColors();

  sparkChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: rows.map(r => fmtTime(r.timestamp)),
      datasets: [{
        label: 'Total Packets',
        data: rows.map(r => r.total_packets),
        borderColor: '#f97316',
        backgroundColor: 'rgba(249, 115, 22, 0.06)',
        borderWidth: 1.5,
        pointRadius: 2,
        pointBackgroundColor: '#f97316',
        tension: 0.35,
        fill: true,
      }],
    },
    options: {
      responsive: true,
      animation: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: c.tooltipBg, borderColor: c.tooltipBorder, borderWidth: 1,
          titleColor: c.tooltipTitle, bodyColor: c.tooltipBody,
        },
      },
      scales: {
        x: { ticks: { color: c.tick, maxTicksLimit: 6, font: { size: 10 } }, grid: { color: c.grid } },
        y: { ticks: { color: c.tick, font: { size: 10 } }, grid: { color: c.grid } },
      },
    },
  });
}

async function refreshSparkline() {
  if (!sparkReady) { await initSparkline(); return; }
  const rows = await fetchSparkRows();
  sparkChart.data.labels            = rows.map(r => fmtTime(r.timestamp));
  sparkChart.data.datasets[0].data  = rows.map(r => r.total_packets);
  sparkChart.update('none');
}

// Top talkers 

function renderMiniTable(id, rows, keyLabel, valueLabel, formatValue) {
  const tbody = document.getElementById(id);
  if (!rows || !rows.length) {
    tbody.innerHTML = `<tr><td class="empty" colspan="2">No data yet</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map(r => `
    <tr><td>${r[keyLabel]}</td><td class="mini-val">${formatValue(r[valueLabel])}</td></tr>
  `).join('');
}

async function refreshTopTalkers() {
  const data = await fetch('/api/top-talkers?limit=20').then(r => r.json());
  renderMiniTable('tt-sources', data.top_sources, 'ip', 'bytes', v => v.toLocaleString() + ' B');
  renderMiniTable('tt-destinations', data.top_destinations, 'ip', 'bytes', v => v.toLocaleString() + ' B');
  renderMiniTable('tt-ports', data.top_ports, 'port', 'count', v => v.toLocaleString());
}

// System Status 

async function refreshSystem() {
  const sys = await fetch('/api/system').then(r => r.json());

  windowSeconds = sys.window || 60;
  if (sys.alert_threshold != null) alertThreshold = sys.alert_threshold;

  document.getElementById('sys-model-status').innerHTML = sys.model_loaded
    ? '<span class="pill green">Loaded</span>'
    : '<span class="pill red">Not loaded</span>';
  document.getElementById('sys-model-path').textContent    = sys.model_path;
  document.getElementById('sys-window').textContent        = sys.window + 's';
  document.getElementById('sys-contamination').textContent = sys.contamination;
  document.getElementById('sys-db').textContent            = sys.db_path;
  document.getElementById('sys-monitor-rows').textContent  = sys.monitor_count;

  const thresholdInput = document.getElementById('threshold-input');
  if (document.activeElement !== thresholdInput) {
    thresholdInput.value = sys.alert_threshold;
  }

  const ss = sys.score_stats;
  document.getElementById('sys-score-range').textContent = ss
    ? `${fmtScore(ss.min)} / ${fmtScore(ss.avg)} / ${fmtScore(ss.max)}  (min / avg / max)`
    : 'No scored windows yet';

  const profiles = sys.training_profiles.length
    ? sys.training_profiles.map(p => `${p.profile} (${p.count})`).join(', ')
    : 'None';
  document.getElementById('sys-profiles').textContent = profiles;

  refreshHealthStrip();
  refreshModels();
}

// Model switching 

function fmtBytes(n) {
  if (typeof n !== 'number') return '-';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

async function activateModel(path, btn) {
  btn.disabled = true;
  btn.textContent = 'Activating…';
  try {
    const res = await fetch('/api/config/model', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });
    const data = await res.json();
    if (!data.ok) alert(`Error: ${data.error}`);
  } catch (e) {
    alert(`Request failed: ${e.message}`);
  }
  refreshModels();
  refreshSystem();
}

async function refreshModels() {
  const data = await fetch('/api/models').then(r => r.json());
  const list = document.getElementById('model-list');

  if (!data.models.length) {
    list.innerHTML = '<p class="no-attribution">No models found in models/. Train one with <code>python src/ml.py train</code>.</p>';
    return;
  }

  list.innerHTML = data.models.map(m => `
    <div class="model-row ${m.active ? 'active' : ''}">
      <div class="model-info">
        <span class="model-name">${m.name}</span>
        <span class="model-meta">${fmtBytes(m.size)} &middot; modified ${fmtTime(m.modified)}</span>
      </div>
      ${m.active
        ? '<span class="pill green">Active</span>'
        : `<button class="btn" onclick="activateModel('${m.path}', this)">Activate</button>`}
    </div>`).join('');
}

document.getElementById('threshold-save').addEventListener('click', async () => {
  const input = document.getElementById('threshold-input');
  const msg   = document.getElementById('threshold-save-msg');
  const value = parseFloat(input.value);
  if (isNaN(value)) { msg.textContent = 'Invalid number'; msg.className = 'threshold-msg error'; return; }

  msg.textContent = 'Saving…';
  msg.className = 'threshold-msg';
  try {
    const res = await fetch('/api/config/threshold', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threshold: value }),
    });
    const data = await res.json();
    if (data.ok) {
      alertThreshold = data.alert_threshold;
      msg.textContent = 'Saved';
      msg.className = 'threshold-msg success';
      if (chartReady) refreshChart();
      if (histReady) refreshHistChart();
    } else {
      msg.textContent = data.error || 'Error saving';
      msg.className = 'threshold-msg error';
    }
  } catch (e) {
    msg.textContent = 'Request failed';
    msg.className = 'threshold-msg error';
  }
  setTimeout(() => { msg.textContent = ''; }, 3000);
});

// Health history strip 

async function refreshHealthStrip() {
  const data = await fetch('/api/health-history?hours=24&buckets=96').then(r => r.json());
  const strip = document.getElementById('health-strip');
  strip.innerHTML = data.slots.map((up, i) => {
    const t = data.since + i * data.bucket_seconds;
    return `<span class="health-tick ${up ? 'up' : 'down'}" title="${fmtTime(t)}: ${up ? 'up' : 'down'}"></span>`;
  }).join('');
}

// Alerts filters 

function buildAlertQuery(limit) {
  const params = new URLSearchParams();
  if (limit) params.set('limit', limit);
  if (alertFilters.start != null) params.set('start', alertFilters.start);
  if (alertFilters.end != null) params.set('end', alertFilters.end);
  if (alertFilters.label) params.set('label', alertFilters.label);
  return params.toString();
}

function updateAlertExportLink() {
  const params = new URLSearchParams();
  if (alertFilters.start != null) params.set('start', alertFilters.start);
  if (alertFilters.end != null) params.set('end', alertFilters.end);
  if (alertFilters.label) params.set('label', alertFilters.label);
  document.getElementById('alert-export').href = '/api/alerts/export?' + params.toString();
}

document.getElementById('alert-filter-apply').addEventListener('click', () => {
  alertFilters.start = localInputToEpoch('alert-start');
  alertFilters.end   = localInputToEpoch('alert-end');
  alertFilters.label = document.getElementById('alert-label-filter').value;
  updateAlertExportLink();
  refreshAlertsTable();
  refreshChart();
});

document.getElementById('alert-filter-clear').addEventListener('click', () => {
  document.getElementById('alert-start').value = '';
  document.getElementById('alert-end').value = '';
  document.getElementById('alert-label-filter').value = '';
  alertFilters = { start: null, end: null, label: '' };
  updateAlertExportLink();
  refreshAlertsTable();
  refreshChart();
});

updateAlertExportLink();

// Alerts table 

function toggleAlertDetail(ts) {
  if (expandedAlerts.has(ts)) expandedAlerts.delete(ts);
  else expandedAlerts.add(ts);
  const row = document.querySelector(`[data-detail-ts="${ts}"]`);
  if (row) row.classList.toggle('hidden', !expandedAlerts.has(ts));
}

function renderAttribution(attribution) {
  if (!attribution || !attribution.length) return '<p class="no-attribution">No attribution available.</p>';
  const maxAbsZ = Math.max(...attribution.map(a => Math.abs(a.z_score)), 1);
  return `
    <div class="attribution-list">
      ${attribution.map(a => {
        const pct = Math.min(100, Math.abs(a.z_score) / maxAbsZ * 100);
        const dir = a.z_score >= 0 ? 'pos' : 'neg';
        return `
          <div class="attribution-row">
            <span class="attr-feature">${a.feature.replace(/_/g, ' ')}</span>
            <div class="attr-bar-track">
              <div class="attr-bar ${dir}" style="width:${pct}%"></div>
            </div>
            <span class="attr-z">z=${a.z_score.toFixed(2)}</span>
            <span class="attr-val">val ${fmtNum(a.value, 2)} vs baseline ${fmtNum(a.baseline_mean, 2)}</span>
          </div>`;
      }).join('')}
    </div>`;
}

function renderTopTalkersDetail(tt) {
  if (!tt) return '';
  const fmtList = (arr, keyIdx, valIdx, unit) => (arr && arr.length)
    ? arr.slice(0, 5).map(x => `<span class="tt-chip">${x[keyIdx]} <em>${x[valIdx].toLocaleString()}${unit}</em></span>`).join('')
    : '<span class="no-attribution">None</span>';
  return `
    <div class="alert-talkers">
      <div class="tt-group"><span class="dk">Top Sources</span>${fmtList(tt.top_sources, 0, 1, 'B')}</div>
      <div class="tt-group"><span class="dk">Top Destinations</span>${fmtList(tt.top_destinations, 0, 1, 'B')}</div>
      <div class="tt-group"><span class="dk">Top Ports</span>${fmtList(tt.top_ports, 0, 1, '')}</div>
    </div>`;
}

async function ackAlert(id, current) {
  await fetch(`/api/alerts/${id}/ack`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ack: !current }),
  });
  refreshAlertsTable();
}

async function labelAlert(id, label) {
  await fetch(`/api/alerts/${id}/label`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label }),
  });
  refreshAlertsTable();
}

async function refreshAlertsTable() {
  const alerts = await fetch(`/api/alerts?${buildAlertQuery(50)}`).then(r => r.json());
  const tbody  = document.getElementById('alerts-body');
  if (!alerts.length) {
    tbody.innerHTML = '<tr><td class="empty" colspan="7">No alerts recorded</td></tr>';
    return;
  }
  tbody.innerHTML = alerts.map(a => `
    <tr class="alert-row" onclick="toggleAlertDetail(${a.timestamp})">
      <td>${fmtTime(a.timestamp)}</td>
      <td><span class="score">${fmtScore(a.score)}</span></td>
      <td>${a.active_flows}</td>
      <td>${a.total_packets}</td>
      <td>${a.total_bytes}</td>
      <td onclick="event.stopPropagation()">
        <button class="btn ack-btn ${a.ack ? 'active' : ''}" onclick="ackAlert(${a.id}, ${a.ack ? 'true' : 'false'})"
                title="${a.ack ? 'Click to mark as not yet reviewed' : 'Click once you have reviewed this alert'}">
          ${a.ack ? '✓ Reviewed' : 'Mark Reviewed'}
        </button>
      </td>
      <td onclick="event.stopPropagation()">
        <button class="btn label-btn tp ${a.label === 'tp' ? 'active' : ''}" onclick="labelAlert(${a.id}, ${a.label === 'tp' ? 'null' : "'tp'"})"
                title="Mark this as a genuine attack or intrusion">Real Threat</button>
        <button class="btn label-btn fp ${a.label === 'fp' ? 'active' : ''}" onclick="labelAlert(${a.id}, ${a.label === 'fp' ? 'null' : "'fp'"})"
                title="Mark this as normal traffic that was flagged by mistake">False Alarm</button>
      </td>
    </tr>
    <tr class="detail-row ${expandedAlerts.has(a.timestamp) ? '' : 'hidden'}"
        data-detail-ts="${a.timestamp}">
      <td colspan="7">
        <div class="detail-inner">
          <div class="detail-kv"><span class="dk">Active Flows</span><span class="dv">${a.active_flows}</span></div>
          <div class="detail-kv"><span class="dk">Total Packets</span><span class="dv">${a.total_packets}</span></div>
          <div class="detail-kv"><span class="dk">Total Bytes</span><span class="dv">${a.total_bytes}</span></div>
          <div class="detail-kv"><span class="dk">Avg Pkt/Flow</span><span class="dv">${fmtNum(a.avg_packets_per_flow)}</span></div>
          <div class="detail-kv"><span class="dk">Avg B/Flow</span><span class="dv">${fmtNum(a.avg_bytes_per_flow)}</span></div>
          <div class="detail-kv"><span class="dk">Unique Dsts</span><span class="dv">${a.unique_destinations}</span></div>
          <div class="detail-kv"><span class="dk">Unique Ports</span><span class="dv">${a.unique_ports}</span></div>
        </div>
        <div class="section-label" style="margin-top:0.9rem">Why this was flagged</div>
        ${renderAttribution(a.attribution)}
        <div class="section-label" style="margin-top:0.9rem">Traffic breakdown</div>
        ${renderTopTalkersDetail(a.top_talkers)}
      </td>
    </tr>`).join('');
}

// anomaly score chart  

const scorePager = makePager('score', SCORE_LIMIT);
onChangeFns.score = () => refreshChart();

async function fetchScoredWindows() {
  const data = await fetch(`/api/monitor?limit=${SCORE_LIMIT}&offset=${scorePager.state.offset}`).then(r => r.json());
  scorePager.state.total = data.total;
  scorePager.render(data.rows.length);
  return data.rows.filter(r => r.score != null).reverse();
}

async function initChart() {
  chartReady = true;
  const rows = await fetchScoredWindows();
  const ctx  = document.getElementById('score-chart').getContext('2d');
  const c = chartColors();

  scoreChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: rows.map(r => fmtTime(r.timestamp)),
      datasets: [
        {
          label: 'Anomaly Score',
          data: rows.map(r => r.score),
          borderColor: '#f97316',
          backgroundColor: 'rgba(249, 115, 22, 0.06)',
          borderWidth: 1.5,
          pointRadius: rows.map(r => r.score < alertThreshold ? 4 : 2),
          pointBackgroundColor: rows.map(r => r.score < alertThreshold ? '#ef4444' : '#f97316'),
          pointBorderColor: '#0f0f0f',
          pointBorderWidth: 1,
          tension: 0.3,
          fill: true,
        },
        {
          label: 'Alert Threshold',
          data: rows.map(() => alertThreshold),
          borderColor: 'rgba(239, 68, 68, 0.45)',
          borderWidth: 1,
          borderDash: [5, 4],
          pointRadius: 0,
          fill: false,
        },
      ],
    },
    options: {
      responsive: true,
      animation: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: c.tooltipBg, borderColor: c.tooltipBorder, borderWidth: 1,
          titleColor: c.tooltipTitle, bodyColor: c.tooltipBody,
          filter: item => item.datasetIndex === 0,
        },
      },
      scales: {
        x: { ticks: { color: c.tick, maxTicksLimit: 8, font: { size: 11 } }, grid: { color: c.grid } },
        y: { ticks: { color: c.tick, font: { size: 11 } }, grid: { color: c.grid } },
      },
    },
  });
}

async function refreshChart() {
  if (!chartReady || !scoreChart) return;
  const rows = await fetchScoredWindows();
  scoreChart.data.labels                    = rows.map(r => fmtTime(r.timestamp));
  scoreChart.data.datasets[0].data          = rows.map(r => r.score);
  scoreChart.data.datasets[0].pointRadius   = rows.map(r => r.score < alertThreshold ? 4 : 2);
  scoreChart.data.datasets[0].pointBackgroundColor = rows.map(r => r.score < alertThreshold ? '#ef4444' : '#f97316');
  scoreChart.data.datasets[1].data          = rows.map(() => alertThreshold);
  scoreChart.update('none');
}

// Score distribution histogram 

const thresholdLinePlugin = {
  id: 'thresholdLine',
  afterDraw(chart, args, opts) {
    if (opts.index == null) return;
    const { ctx, chartArea, scales } = chart;
    if (!scales.x) return;
    const x = scales.x.getPixelForValue(opts.index);
    ctx.save();
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(239, 68, 68, 0.9)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.moveTo(x, chartArea.top);
    ctx.lineTo(x, chartArea.bottom);
    ctx.stroke();
    ctx.restore();
  },
};
Chart.register(thresholdLinePlugin);

function bucketIndexForThreshold(buckets, threshold) {
  if (!buckets.length) return null;
  for (let i = 0; i < buckets.length; i++) {
    if (threshold >= buckets[i].start && threshold <= buckets[i].end) return i;
  }
  return threshold < buckets[0].start ? 0 : buckets.length - 1;
}

async function initHistChart() {
  histReady = true;
  const data = await fetch('/api/scores/histogram?limit=1000&bins=24').then(r => r.json());
  const ctx  = document.getElementById('hist-chart').getContext('2d');
  const c = chartColors();
  const buckets = data.buckets || [];
  const idx = bucketIndexForThreshold(buckets, alertThreshold);

  histChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: buckets.map(b => b.start.toFixed(2)),
      datasets: [{
        label: 'Windows',
        data: buckets.map(b => b.count),
        backgroundColor: buckets.map(b => b.end <= alertThreshold ? 'rgba(239,68,68,0.6)' : 'rgba(249,115,22,0.5)'),
        borderWidth: 0,
      }],
    },
    options: {
      responsive: true,
      animation: false,
      plugins: {
        legend: { display: false },
        thresholdLine: { index: idx },
        tooltip: {
          backgroundColor: c.tooltipBg, borderColor: c.tooltipBorder, borderWidth: 1,
          titleColor: c.tooltipTitle, bodyColor: c.tooltipBody,
        },
      },
      scales: {
        x: { ticks: { color: c.tick, maxTicksLimit: 8, font: { size: 10 } }, grid: { color: c.grid } },
        y: { ticks: { color: c.tick, font: { size: 10 } }, grid: { color: c.grid } },
      },
    },
  });
}

async function refreshHistChart() {
  if (!histReady || !histChart) return;
  const data = await fetch('/api/scores/histogram?limit=1000&bins=24').then(r => r.json());
  const buckets = data.buckets || [];
  const idx = bucketIndexForThreshold(buckets, alertThreshold);
  histChart.data.labels = buckets.map(b => b.start.toFixed(2));
  histChart.data.datasets[0].data = buckets.map(b => b.count);
  histChart.data.datasets[0].backgroundColor = buckets.map(b => b.end <= alertThreshold ? 'rgba(239,68,68,0.6)' : 'rgba(249,115,22,0.5)');
  histChart.options.plugins.thresholdLine.index = idx;
  histChart.update('none');
}

// Graphs tab (additional per-window metrics, also scrollable) 

const graphsPager = makePager('graphs', GRAPHS_LIMIT);
onChangeFns.graphs = () => {
  document.querySelector('[data-section="graphs"] .graphs-grid')
    ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  refreshGraphs(true);
};

async function fetchGraphsRows() {
  const data = await fetch(`/api/monitor?limit=${GRAPHS_LIMIT}&offset=${graphsPager.state.offset}`).then(r => r.json());
  graphsPager.state.total = data.total;
  graphsPager.render(data.rows.length);
  return data.rows.slice().reverse();
}

function makeLineChart(canvasId, rows, key, color) {
  const ctx = document.getElementById(canvasId).getContext('2d');
  const c = chartColors();
  return new Chart(ctx, {
    type: 'line',
    data: {
      labels: rows.map(r => fmtTime(r.timestamp)),
      datasets: [{
        data: rows.map(r => r[key]),
        borderColor: color,
        backgroundColor: color + '18',
        borderWidth: 1.5,
        pointRadius: 2,
        pointBackgroundColor: color,
        tension: 0.3,
        fill: true,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: c.tooltipBg, borderColor: c.tooltipBorder, borderWidth: 1,
          titleColor: c.tooltipTitle, bodyColor: c.tooltipBody,
        },
      },
      scales: {
        x: { ticks: { color: c.tick, maxTicksLimit: 6, font: { size: 10 } }, grid: { color: c.grid } },
        y: { ticks: { color: c.tick, font: { size: 10 } }, grid: { color: c.grid } },
      },
    },
  });
}

function updateLineChart(chart, rows, key, animate) {
  chart.data.labels = rows.map(r => fmtTime(r.timestamp));
  chart.data.datasets[0].data = rows.map(r => r[key]);
  chart.update(animate ? undefined : 'none');
}

function makeAvgChart(canvasId, rows) {
  const ctx = document.getElementById(canvasId).getContext('2d');
  const c = chartColors();
  return new Chart(ctx, {
    type: 'line',
    data: {
      labels: rows.map(r => fmtTime(r.timestamp)),
      datasets: [
        {
          label: 'Avg Packets/Flow', data: rows.map(r => r.avg_packets_per_flow),
          borderColor: '#f97316', backgroundColor: 'transparent', borderWidth: 1.5,
          pointRadius: 2, pointBackgroundColor: '#f97316', tension: 0.3, yAxisID: 'y',
        },
        {
          label: 'Avg Bytes/Flow', data: rows.map(r => r.avg_bytes_per_flow),
          borderColor: '#3b82f6', backgroundColor: 'transparent', borderWidth: 1.5,
          pointRadius: 2, pointBackgroundColor: '#3b82f6', tension: 0.3, yAxisID: 'y1',
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { display: true, labels: { color: c.tick, font: { size: 10 }, boxWidth: 12 } },
        tooltip: {
          backgroundColor: c.tooltipBg, borderColor: c.tooltipBorder, borderWidth: 1,
          titleColor: c.tooltipTitle, bodyColor: c.tooltipBody,
        },
      },
      scales: {
        x: { ticks: { color: c.tick, maxTicksLimit: 6, font: { size: 10 } }, grid: { color: c.grid } },
        y:  { position: 'left',  ticks: { color: c.tick, font: { size: 10 } }, grid: { color: c.grid } },
        y1: { position: 'right', ticks: { color: c.tick, font: { size: 10 } }, grid: { drawOnChartArea: false } },
      },
    },
  });
}

function updateAvgChart(chart, rows, animate) {
  chart.data.labels = rows.map(r => fmtTime(r.timestamp));
  chart.data.datasets[0].data = rows.map(r => r.avg_packets_per_flow);
  chart.data.datasets[1].data = rows.map(r => r.avg_bytes_per_flow);
  chart.update(animate ? undefined : 'none');
}

async function initGraphs() {
  graphsReady = true;
  const rows = await fetchGraphsRows();
  gBytesChart = makeLineChart('g-bytes-chart', rows, 'total_bytes', '#f97316');
  gFlowsChart = makeLineChart('g-flows-chart', rows, 'active_flows', '#3b82f6');
  gDestsChart = makeLineChart('g-dests-chart', rows, 'unique_destinations', '#a855f7');
  gPortsChart = makeLineChart('g-ports-chart', rows, 'unique_ports', '#22c55e');
  gAvgChart   = makeAvgChart('g-avg-chart', rows);
}

async function refreshGraphs(animate) {
  if (!graphsReady) { await initGraphs(); return; }
  const rows = await fetchGraphsRows();
  updateLineChart(gBytesChart, rows, 'total_bytes', animate);
  updateLineChart(gFlowsChart, rows, 'active_flows', animate);
  updateLineChart(gDestsChart, rows, 'unique_destinations', animate);
  updateLineChart(gPortsChart, rows, 'unique_ports', animate);
  updateAvgChart(gAvgChart, rows, animate);
}

// Monitor table 

function buildMonitorQuery(limit, offset) {
  const params = new URLSearchParams();
  params.set('limit', limit);
  params.set('offset', offset);
  if (monitorFilters.start != null) params.set('start', monitorFilters.start);
  if (monitorFilters.end != null) params.set('end', monitorFilters.end);
  return params.toString();
}

function updateMonitorExportLink() {
  const params = new URLSearchParams();
  if (monitorFilters.start != null) params.set('start', monitorFilters.start);
  if (monitorFilters.end != null) params.set('end', monitorFilters.end);
  document.getElementById('mon-export').href = '/api/monitor/export?' + params.toString();
}

document.getElementById('mon-filter-apply').addEventListener('click', () => {
  monitorFilters.start = localInputToEpoch('mon-start');
  monitorFilters.end   = localInputToEpoch('mon-end');
  monitorOffset = 0;
  updateMonitorExportLink();
  loadMonitorPage();
});

document.getElementById('mon-filter-clear').addEventListener('click', () => {
  document.getElementById('mon-start').value = '';
  document.getElementById('mon-end').value = '';
  monitorFilters = { start: null, end: null };
  monitorOffset = 0;
  updateMonitorExportLink();
  loadMonitorPage();
});

updateMonitorExportLink();

async function loadMonitorPage() {
  const data  = await fetch(`/api/monitor?${buildMonitorQuery(MONITOR_LIMIT, monitorOffset)}`).then(r => r.json());
  const tbody = document.getElementById('monitor-body');

  tbody.innerHTML = data.rows.length
    ? data.rows.map(r => `
        <tr>
          <td>${fmtTime(r.timestamp)}</td>
          <td>${r.active_flows}</td>
          <td>${r.total_packets}</td>
          <td>${r.total_bytes}</td>
          <td>${fmtNum(r.avg_packets_per_flow)}</td>
          <td>${fmtNum(r.avg_bytes_per_flow)}</td>
          <td>${r.unique_destinations}</td>
          <td>${r.unique_ports}</td>
          <td><span class="score">${r.score != null ? fmtScore(r.score) : '-'}</span></td>
        </tr>`).join('')
    : '<tr><td class="empty" colspan="9">No monitor data yet</td></tr>';

  const start = data.total ? monitorOffset + 1 : 0;
  const end   = Math.min(monitorOffset + data.rows.length, data.total);
  document.getElementById('mon-page-info').textContent =
    data.total ? `${start}–${end} of ${data.total}` : '0 rows';

  document.getElementById('mon-prev').disabled = monitorOffset === 0;
  document.getElementById('mon-next').disabled = end >= data.total;
}

document.getElementById('mon-prev').addEventListener('click', () => {
  monitorOffset = Math.max(0, monitorOffset - MONITOR_LIMIT);
  loadMonitorPage();
});

document.getElementById('mon-next').addEventListener('click', () => {
  monitorOffset += MONITOR_LIMIT;
  loadMonitorPage();
});

// Logs 

document.getElementById('log-pin-btn').addEventListener('click', () => {
  logPinned = !logPinned;
  const btn = document.getElementById('log-pin-btn');
  btn.textContent = logPinned ? 'Unpin scroll' : 'Pin scroll';
  btn.classList.toggle('active', logPinned);
});

async function refreshLogs() {
  const data = await fetch('/api/logs').then(r => r.json());
  const box  = document.getElementById('log-box');
  box.innerHTML = data.lines.map(line => {
    let cls = 'info';
    if (line.includes('[ALERT]'))   cls = 'alert';
    else if (line.includes('[WARN]'))    cls = 'warn';
    else if (line.includes('[STARTUP]')) cls = 'start';
    return `<div class="log-line ${cls}">${line}</div>`;
  }).join('');
  if (!logPinned) box.scrollTop = box.scrollHeight;
}

// Poll 

async function refresh() {
  const active = document.querySelector('section.active')?.dataset.section;

  const [status, backend, latestAlerts] = await Promise.all([
    fetch('/api/status').then(r => r.json()),
    fetch('/api/backend-status').then(r => r.json()),
    fetch('/api/alerts?limit=1').then(r => r.json()),
  ]);

  refreshBanner(backend, latestAlerts, status.capture_stale);
  refreshOverview(status, backend);
  refreshSparkline();
  refreshTopTalkers();
  checkNewAlert(latestAlerts);

  if (active === 'status')   refreshSystem();
  if (active === 'alerts')   { refreshAlertsTable(); refreshChart(); refreshHistChart(); }
  if (active === 'monitor')  loadMonitorPage();
  if (active === 'graphs')   refreshGraphs();
  if (active === 'logs')     refreshLogs();
}

async function init() {
  try {
    const sys = await fetch('/api/system').then(r => r.json());
    windowSeconds = sys.window || 60;
    if (sys.alert_threshold != null) alertThreshold = sys.alert_threshold;
  } catch {}
  refresh();
}

init();
setInterval(refresh, 5000);
