let swRegistration = null;
let currentSubscription = null;
let currentPrice = null;

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
    await currentSubscription.unsubscribe();
    currentSubscription = null;
  }
  setAlertEnabled(false);
  statusEl.textContent = 'Alerts disabled.';
}

function setAlertEnabled(enabled) {
  document.getElementById('subscribe-btn').style.display = enabled ? 'none' : 'block';
  document.getElementById('unsubscribe-btn').style.display = enabled ? 'block' : 'none';
  document.getElementById('subscribe-btn').disabled = false;
}

// ── Install guide ─────────────────────────────────────────────────────────────
function checkStandaloneMode() {
  const isStandalone = window.navigator.standalone || window.matchMedia('(display-mode: standalone)').matches;
  if (!isStandalone) {
    document.getElementById('install-guide').style.display = 'block';
  }
}

// ── TER price ─────────────────────────────────────────────────────────────────
async function fetchTerPrice() {
  const URLS = [
    'https://api.ter.bt/prices',
    'https://api.allorigins.win/raw?url=' + encodeURIComponent('https://api.ter.bt/prices'),
    'https://corsproxy.io/?' + encodeURIComponent('https://api.ter.bt/prices'),
  ];
  let data = null;
  for (const url of URLS) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
      if (!res.ok) continue;
      data = await res.json();
      if (Array.isArray(data) && data.length > 0) break;
      data = null;
    } catch { continue; }
  }
  if (!data) { console.warn('TER price: all sources failed'); return; }
  const usd = data.find(d => d.product_symbol === 'TERUSD');
  const btn = data.find(d => d.product_symbol === 'TERBTN');
  if (!usd) return;
  document.getElementById('ter-buy').textContent = `$${(usd.ask_price / 10000).toFixed(4)}`;
  document.getElementById('ter-sell').textContent = `$${(usd.bid_price / 10000).toFixed(4)}`;
  if (btn) {
    document.getElementById('ter-btn-buy').textContent = `Nu. ${(btn.ask_price / 10000).toFixed(4)}`;
    document.getElementById('ter-btn-sell').textContent = `Nu. ${(btn.bid_price / 10000).toFixed(4)}`;
  }
  const ts = new Date(usd.effective_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  document.getElementById('ter-updated').textContent = `per TER token · updated ${ts}`;
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

  // Service worker + push setup (best effort — don't block price display)
  try {
    swRegistration = await registerSW();
    if (swRegistration && swRegistration.pushManager) {
      const existing = await swRegistration.pushManager.getSubscription();
      if (existing) {
        currentSubscription = existing;
        setAlertEnabled(true);
        document.getElementById('alert-status').textContent = 'Alerts are active.';
      }
    }
  } catch (e) {
    console.warn('Push setup failed (expected in Chrome/non-standalone):', e.message);
  }
})();
