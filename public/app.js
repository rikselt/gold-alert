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
    statusEl.textContent = `✓ Alerts enabled — you'll be notified when TER ${priceType} price ${direction === 'below' ? 'drops below' : 'rises above'} $${threshold}`;
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
  if (!isStandalone) {
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

function renderHistoryChart(data, range) {
  const svg = document.getElementById('history-chart');
  const emptyEl = document.getElementById('history-empty');

  if (!data || data.length < 2) {
    svg.style.display = 'none';
    emptyEl.style.display = 'block';
    return;
  }
  svg.style.display = 'block';
  emptyEl.style.display = 'none';

  const W = 400, H = 140, PAD = 8;
  const prices = data.map(d => d.p);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range_ = max - min || 1;

  const points = data.map((d, i) => {
    const x = PAD + (i / (data.length - 1)) * (W - PAD * 2);
    const y = H - PAD - ((d.p - min) / range_) * (H - PAD * 2);
    return [x, y];
  });

  const linePath = points.map((p, i) => (i === 0 ? 'M' : 'L') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
  const areaPath = linePath + ` L${points[points.length - 1][0].toFixed(1)},${H - PAD} L${points[0][0].toFixed(1)},${H - PAD} Z`;

  const isUp = prices[prices.length - 1] >= prices[0];
  const lineColor = isUp ? '#22c55e' : '#ef4444';

  svg.innerHTML = `
    <defs>
      <linearGradient id="chartFade" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${lineColor}" stop-opacity="0.25" />
        <stop offset="100%" stop-color="${lineColor}" stop-opacity="0" />
      </linearGradient>
    </defs>
    <path d="${areaPath}" fill="url(#chartFade)" />
    <path d="${linePath}" fill="none" stroke="${lineColor}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
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
