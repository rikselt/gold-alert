let swRegistration = null;
let currentSubscription = null;
let currentPrice = null;

// ── Price fetching ────────────────────────────────────────────────────────────
async function fetchPrice() {
  const metaEl = document.getElementById('price-meta-text');
  const valEl = document.getElementById('price-val');
  metaEl.textContent = 'Refreshing…';

  try {
    const res = await fetch('/price');
    if (!res.ok) throw new Error('Server error');
    const data = await res.json();
    currentPrice = data.price;

    valEl.textContent = data.price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const ts = new Date(data.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    metaEl.textContent = `Updated ${ts} · ${data.source}`;

    updateThresholdStatus(data.price);
  } catch (err) {
    metaEl.textContent = 'Failed to load — tap ↻ to retry';
    valEl.textContent = '–––';
  }
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

// ── Init ──────────────────────────────────────────────────────────────────────
(async () => {
  checkStandaloneMode();
  swRegistration = await registerSW();

  // Check if already subscribed
  if (swRegistration) {
    const existing = await swRegistration.pushManager.getSubscription();
    if (existing) {
      currentSubscription = existing;
      setAlertEnabled(true);
      document.getElementById('alert-status').textContent = 'Alerts are active.';
    }
  }

  await fetchPrice();
  // Refresh price every 60 seconds while page is visible
  setInterval(() => { if (!document.hidden) fetchPrice(); }, 60000);
})();
