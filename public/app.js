let swRegistration = null;
let currentSubscription = null;
let currentPrice = null;

// ── Theme toggle ──────────────────────────────────────────────────────────────
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  document.getElementById('theme-toggle').textContent = theme === 'light' ? '☀️' : '🌙';
  const metaTheme = document.querySelector('meta[name="theme-color"]');
  if (metaTheme) metaTheme.setAttribute('content', theme === 'light' ? '#f5f5f5' : '#0f0f0f');
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'dark';
  const next = current === 'light' ? 'dark' : 'light';
  localStorage.setItem('theme', next);
  applyTheme(next);
}

applyTheme(localStorage.getItem('theme') || 'dark');

// ── Price fetching ────────────────────────────────────────────────────────────
async function fetchPrice(isRetry = false) {
  const metaEl = document.getElementById('price-meta-text');
  const valEl = document.getElementById('price-val');
  if (!isRetry) metaEl.textContent = 'Loading…';

  try {
    const res = await fetch('/price');
    if (!res.ok) throw new Error('Server error ' + res.status);
    const data = await res.json();
    currentPrice = data.price;

    valEl.textContent = data.price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const ts = new Date(data.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    metaEl.textContent = `Updated ${ts} · ${data.source}`;

    updateThresholdStatus(data.price);
    return true;
  } catch (err) {
    metaEl.textContent = 'Retrying…';
    valEl.textContent = '–––';
    return false;
  }
}

async function fetchPriceWithRetry() {
  for (let i = 0; i < 5; i++) {
    const ok = await fetchPrice(i > 0);
    if (ok) return;
    await new Promise(r => setTimeout(r, 3000)); // wait 3s between retries
  }
  document.getElementById('price-meta-text').textContent = 'Failed to load — tap ↻ to retry';
}

function updateThresholdStatus(price) {
  const threshold = parseFloat(document.getElementById('threshold-input').value) || 2500;
  const el = document.getElementById('threshold-status');
  if (price < threshold) {
    el.innerHTML = `<span class="status-badge below">🔔 Alert will fire — price is below $${threshold.toLocaleString()}</span>`;
  } else {
    el.innerHTML = `<span class="status-badge above">✓ Watching — alert fires if price drops below $${threshold.toLocaleString()}</span>`;
  }
}

document.getElementById('threshold-input').addEventListener('input', () => {
  if (currentPrice) updateThresholdStatus(currentPrice);
});

// ── Service Worker & Push ────────────────────────────────────────────────────
async function registerSW() {
  if (!('serviceWorker' in navigator)) return null;
  try {
    return await navigator.serviceWorker.register('/service-worker.js');
  } catch (err) {
    console.error('SW registration failed:', err);
    return null;
  }
}

function urlBase64ToUint8Array(base64String) {
  const str = base64String.trim();
  const padding = '='.repeat((4 - str.length % 4) % 4);
  const base64 = (str + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

async function getVapidKey() {
  const res = await fetch('/vapid-public-key');
  const { key } = await res.json();
  return key;
}

async function handleSubscribe() {
  const btn = document.getElementById('subscribe-btn');
  const statusEl = document.getElementById('alert-status');
  btn.disabled = true;
  statusEl.textContent = 'Setting up alerts…';

  try {
    const isStandalone = window.navigator.standalone || window.matchMedia('(display-mode: standalone)').matches;
    if (!isStandalone) throw new Error('Please open this app from your home screen icon, not Safari — then try again');

    if (!('Notification' in window)) throw new Error('Notifications not supported in this browser');

    const permission = await Notification.requestPermission();
    if (permission === 'denied') throw new Error('Notifications are blocked — go to iPhone Settings → Notifications → Ter Gold Alert and turn them on');
    if (permission !== 'granted') throw new Error('Notification permission was not granted — please try again and tap Allow');

    statusEl.textContent = 'Registering service worker…';
    if (!swRegistration) swRegistration = await registerSW();
    if (!swRegistration) throw new Error('Service Worker failed to register — try reloading the app');

    statusEl.textContent = 'Subscribing to push…';
    const vapidKey = await getVapidKey();
    let subscription;
    try {
      subscription = await swRegistration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidKey),
      });
    } catch (pushErr) {
      throw new Error(`Push subscribe failed: ${pushErr.message} — try removing the app from home screen, re-adding it in Safari, and trying again`);
    }

    const threshold = parseFloat(document.getElementById('threshold-input').value) || 2500;
    statusEl.textContent = 'Saving your alert…';
    const res = await fetch('/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription, threshold }),
    });
    if (!res.ok) throw new Error('Server failed to save subscription — is the server still running?');

    currentSubscription = subscription;
    setAlertEnabled(true);
    statusEl.textContent = `✓ Alerts enabled — you'll be notified when gold drops below $${threshold.toLocaleString()}`;
  } catch (err) {
    statusEl.textContent = `❌ ${err.message}`;
    btn.disabled = false;
  }
}

async function handleUnsubscribe() {
  const statusEl = document.getElementById('alert-status');
  if (currentSubscription) {
    await fetch('/unsubscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: currentSubscription.endpoint }),
    });
    if (!terAlertActive) {
      await currentSubscription.unsubscribe();
      currentSubscription = null;
    }
  }
  setAlertEnabled(false);
  statusEl.textContent = 'Alerts disabled.';
}

function setAlertEnabled(enabled) {
  document.getElementById('subscribe-btn').style.display = enabled ? 'none' : 'block';
  document.getElementById('unsubscribe-btn').style.display = enabled ? 'block' : 'none';
  document.getElementById('subscribe-btn').disabled = false;
}

// ── TER Alert ─────────────────────────────────────────────────────────────────
let terAlertActive = false;

async function handleTerSubscribe() {
  const btn = document.getElementById('ter-subscribe-btn');
  const statusEl = document.getElementById('ter-alert-status');
  btn.disabled = true;
  statusEl.textContent = 'Setting up alerts…';

  try {
    const isStandalone = window.navigator.standalone || window.matchMedia('(display-mode: standalone)').matches;
    if (!isStandalone) throw new Error('Please open this app from your home screen icon, not Safari — then try again');

    if (!('Notification' in window)) throw new Error('Notifications not supported in this browser');

    const permission = await Notification.requestPermission();
    if (permission === 'denied') throw new Error('Notifications are blocked — go to iPhone Settings → Notifications → Ter Gold Alert and turn them on');
    if (permission !== 'granted') throw new Error('Notification permission was not granted — please try again and tap Allow');

    statusEl.textContent = 'Registering service worker…';
    if (!swRegistration) swRegistration = await registerSW();
    if (!swRegistration) throw new Error('Service Worker failed to register — try reloading the app');

    statusEl.textContent = 'Subscribing to push…';
    let subscription = currentSubscription;
    if (!subscription) {
      const vapidKey = await getVapidKey();
      try {
        subscription = await swRegistration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(vapidKey),
        });
      } catch (pushErr) {
        throw new Error(`Push subscribe failed: ${pushErr.message} — try removing the app from home screen, re-adding it in Safari, and trying again`);
      }
      currentSubscription = subscription;
    }

    const priceType = document.getElementById('ter-alert-pricetype').value;
    const direction = document.getElementById('ter-alert-direction').value;
    const threshold = parseFloat(document.getElementById('ter-threshold-input').value) || 1.30;
    statusEl.textContent = 'Saving your alert…';
    const res = await fetch('/subscribe-ter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription, priceType, direction, threshold }),
    });
    if (!res.ok) throw new Error('Server failed to save subscription — is the server still running?');

    terAlertActive = true;
    setTerAlertEnabled(true);
    statusEl.textContent = `✓ Alerts enabled — you'll be notified when TER ${priceType} price ${direction === 'below' ? 'drops below' : 'rises above'} Nu. ${threshold}`;
  } catch (err) {
    statusEl.textContent = `❌ ${err.message}`;
    btn.disabled = false;
  }
}

async function handleTerUnsubscribe() {
  const statusEl = document.getElementById('ter-alert-status');
  if (currentSubscription) {
    await fetch('/unsubscribe-ter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: currentSubscription.endpoint }),
    });
    terAlertActive = false;
    const goldAlertActive = document.getElementById('unsubscribe-btn').style.display === 'block';
    if (!goldAlertActive) {
      await currentSubscription.unsubscribe();
      currentSubscription = null;
    }
  }
  setTerAlertEnabled(false);
  statusEl.textContent = 'Alerts disabled.';
}

function setTerAlertEnabled(enabled) {
  document.getElementById('ter-subscribe-btn').style.display = enabled ? 'none' : 'block';
  document.getElementById('ter-unsubscribe-btn').style.display = enabled ? 'block' : 'none';
  document.getElementById('ter-subscribe-btn').disabled = false;
}

// ── Install guide ─────────────────────────────────────────────────────────────
function checkStandaloneMode() {
  const isStandalone = window.navigator.standalone || window.matchMedia('(display-mode: standalone)').matches;
  if (isStandalone) return;

  const isAndroid = /Android/i.test(navigator.userAgent);
  const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);

  if (isAndroid) {
    document.getElementById('install-guide-android').style.display = 'block';
  } else if (isIOS) {
    document.getElementById('install-guide').style.display = 'block';
  }
}

// ── Price History Chart ───────────────────────────────────────────────────────
let currentHistoryRange = '24h';

async function fetchHistory(range) {
  try {
    const res = await fetch(`/history?range=${range}`);
    if (!res.ok) return;
    const data = await res.json();
    renderHistoryChart(data, range);
  } catch (e) {
    console.warn('History fetch failed:', e.message);
  }
}

function formatChartTime(ts, range) {
  const d = new Date(ts);
  if (range === '24h') return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function fmtPrice(n) {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function renderHistoryChart(candles, range) {
  const svg = document.getElementById('history-chart');
  const emptyEl = document.getElementById('history-empty');

  if (!candles || candles.length < 2) {
    svg.style.display = 'none';
    emptyEl.style.display = 'block';
    return;
  }
  svg.style.display = 'block';
  emptyEl.style.display = 'none';

  const isDark = (document.documentElement.getAttribute('data-theme') || 'dark') !== 'light';
  const gridColor = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
  const mutedColor = isDark ? '#888' : '#666';

  const W = 400, H = 220;
  const PAD_LEFT = 8, PAD_RIGHT = 46, PAD_TOP = 40, PAD_BOTTOM = 22;
  const plotW = W - PAD_LEFT - PAD_RIGHT;
  const plotH = H - PAD_TOP - PAD_BOTTOM;

  const allHighs = candles.map(c => c.h);
  const allLows = candles.map(c => c.l);
  const min = Math.min(...allLows);
  const max = Math.max(...allHighs);
  const range_ = (max - min) || 1;
  const padRange = range_ * 0.08; // breathing room top/bottom
  const scaleMin = min - padRange;
  const scaleMax = max + padRange;
  const scaleRange = scaleMax - scaleMin;

  const yFor = (price) => PAD_TOP + plotH - ((price - scaleMin) / scaleRange) * plotH;
  const slotW = plotW / candles.length;
  const bodyW = Math.max(2, Math.min(14, slotW * 0.6));

  const first = candles[0];
  const last = candles[candles.length - 1];
  const isUp = last.c >= first.o;
  const trendColor = isUp ? '#22c55e' : '#ef4444';
  const change = last.c - first.o;
  const pctChange = first.o ? ((change / first.o) * 100).toFixed(2) : '0.00';
  const changeLabel = (change >= 0 ? '+' : '') + change.toFixed(2) + ' (' + (change >= 0 ? '+' : '') + pctChange + '%)';

  // Gridlines + right-side price labels (4 lines)
  const GRID_LINES = 4;
  let gridSvg = '';
  for (let i = 0; i <= GRID_LINES; i++) {
    const price = scaleMax - (i / GRID_LINES) * scaleRange;
    const y = yFor(price);
    gridSvg += `<line x1="${PAD_LEFT}" y1="${y.toFixed(1)}" x2="${W - PAD_RIGHT}" y2="${y.toFixed(1)}" stroke="${gridColor}" stroke-width="1" />`;
    gridSvg += `<text x="${W - PAD_RIGHT + 6}" y="${(y + 3.5).toFixed(1)}" font-size="9" fill="${mutedColor}">${price.toLocaleString('en-US', { maximumFractionDigits: 0 })}</text>`;
  }

  // Candlesticks
  let candleSvg = '';
  candles.forEach((c, i) => {
    const x = PAD_LEFT + i * slotW + slotW / 2;
    const yH = yFor(c.h), yL = yFor(c.l), yO = yFor(c.o), yC = yFor(c.c);
    const up = c.c >= c.o;
    const color = up ? '#22c55e' : '#ef4444';
    const bodyTop = Math.min(yO, yC);
    const bodyH = Math.max(1.5, Math.abs(yC - yO));
    candleSvg += `<line x1="${x.toFixed(1)}" y1="${yH.toFixed(1)}" x2="${x.toFixed(1)}" y2="${yL.toFixed(1)}" stroke="${color}" stroke-width="1" />`;
    candleSvg += `<rect x="${(x - bodyW / 2).toFixed(1)}" y="${bodyTop.toFixed(1)}" width="${bodyW.toFixed(1)}" height="${bodyH.toFixed(1)}" fill="${color}" />`;
  });

  // X-axis time labels (first, middle, last)
  const labelIdxs = [0, Math.floor((candles.length - 1) / 2), candles.length - 1];
  let xLabelSvg = '';
  labelIdxs.forEach((idx, k) => {
    const x = PAD_LEFT + idx * slotW + slotW / 2;
    const anchor = k === 0 ? 'start' : k === labelIdxs.length - 1 ? 'end' : 'middle';
    xLabelSvg += `<text x="${x.toFixed(1)}" y="${H - 6}" text-anchor="${anchor}" font-size="10" fill="${mutedColor}">${formatChartTime(candles[idx].t, range)}</text>`;
  });

  svg.innerHTML = `
    <text x="4" y="14" font-size="11" font-weight="700" fill="${mutedColor}">O <tspan fill="${isUp ? '#22c55e' : '#ef4444'}">${fmtPrice(first.o)}</tspan></text>
    <text x="96" y="14" font-size="11" font-weight="700" fill="${mutedColor}">H <tspan fill="var(--text)">${fmtPrice(max)}</tspan></text>
    <text x="188" y="14" font-size="11" font-weight="700" fill="${mutedColor}">L <tspan fill="var(--text)">${fmtPrice(min)}</tspan></text>
    <text x="280" y="14" font-size="11" font-weight="700" fill="${mutedColor}">C <tspan fill="${trendColor}">${fmtPrice(last.c)}</tspan></text>
    <text x="4" y="30" font-size="11" font-weight="700" fill="${trendColor}">${changeLabel}</text>
    ${gridSvg}
    ${candleSvg}
    ${xLabelSvg}
  `;
}

function setHistoryRange(range) {
  currentHistoryRange = range;
  document.querySelectorAll('.range-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.range === range);
  });
  fetchHistory(range);
}

// ── TER Calculator ────────────────────────────────────────────────────────────
let currentTerSell = null;
let currentTerBtnSell = null;

function updateTerCalc() {
  const amount = parseFloat(document.getElementById('ter-amount').value);
  if (!amount || isNaN(amount) || !currentTerSell) {
    document.getElementById('ter-calc-usd').textContent = '$–––';
    document.getElementById('ter-calc-btn').textContent = 'Nu. –––';
    return;
  }
  const usd = (amount * currentTerSell).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  document.getElementById('ter-calc-usd').textContent = `$${usd}`;
  if (currentTerBtnSell) {
    const btn = (amount * currentTerBtnSell).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    document.getElementById('ter-calc-btn').textContent = `Nu. ${btn}`;
  }
}

document.getElementById('ter-amount').addEventListener('input', updateTerCalc);

// ── TER price ─────────────────────────────────────────────────────────────────
async function fetchTerPrice() {
  try {
    const res = await fetch('/ter-price');
    if (!res.ok) return;
    const raw = await res.json();
    if (raw.error) return;
    const data = raw;
    document.getElementById('ter-buy').textContent = `$${data.buy}`;
    document.getElementById('ter-sell').textContent = `$${data.sell}`;
    if (data.btnBuy) document.getElementById('ter-btn-buy').textContent = `Nu. ${data.btnBuy}`;
    if (data.btnSell) document.getElementById('ter-btn-sell').textContent = `Nu. ${data.btnSell}`;
    const ts = new Date(data.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    document.getElementById('ter-updated').textContent = `per TER token · updated ${ts}`;
    currentTerSell = parseFloat(data.sell);
    currentTerBtnSell = data.btnSell ? parseFloat(data.btnSell) : null;
    updateTerCalc();
  } catch (e) {
    console.warn('TER price fetch failed:', e.message);
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────
(async () => {
  checkStandaloneMode();

  // Fetch price first — always works regardless of notifications support
  await fetchPriceWithRetry();
  setInterval(() => { if (!document.hidden) fetchPriceWithRetry(); }, 60000);

  // TER price
  fetchTerPrice();
  setInterval(() => { if (!document.hidden) fetchTerPrice(); }, 30000);

  // Price history chart
  fetchHistory(currentHistoryRange);
  setInterval(() => { if (!document.hidden) fetchHistory(currentHistoryRange); }, 60000);

  // Service worker + push setup (best effort — don't block price display)
  try {
    swRegistration = await registerSW();
    if (swRegistration && swRegistration.pushManager) {
      const existing = await swRegistration.pushManager.getSubscription();
      if (existing) {
        currentSubscription = existing;
        try {
          const res = await fetch(`/alert-status?endpoint=${encodeURIComponent(existing.endpoint)}`);
          const status = await res.json();
          if (status.gold) {
            setAlertEnabled(true);
            document.getElementById('alert-status').textContent = 'Alerts are active.';
          }
          if (status.ter) {
            terAlertActive = true;
            setTerAlertEnabled(true);
            document.getElementById('ter-alert-status').textContent = 'Alerts are active.';
            document.getElementById('ter-alert-pricetype').value = status.ter.priceType;
            document.getElementById('ter-alert-direction').value = status.ter.direction;
            document.getElementById('ter-threshold-input').value = status.ter.threshold;
          }
        } catch (e) {
          console.warn('Failed to fetch alert status:', e.message);
        }
      }
    }
  } catch (e) {
    console.warn('Push setup failed (expected in Chrome/non-standalone):', e.message);
  }
})();
