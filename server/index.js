require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const express = require('express');
const webpush = require('web-push');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const { getGoldPrice } = require('./scraper');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ── VAPID setup ──────────────────────────────────────────────────────────────
let VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY;
let VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const VAPID_EMAIL = process.env.VAPID_EMAIL || 'mailto:admin@gold-alert.local';

if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
  const keys = webpush.generateVAPIDKeys();
  VAPID_PUBLIC  = keys.publicKey;
  VAPID_PRIVATE = keys.privateKey;
  console.log('[setup] No VAPID keys in environment — generated temporary keys.');
  console.log('[setup] Add these to your Railway Variables to make them permanent:');
  console.log(`VAPID_PUBLIC_KEY=${VAPID_PUBLIC}`);
  console.log(`VAPID_PRIVATE_KEY=${VAPID_PRIVATE}`);
}

webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC, VAPID_PRIVATE);

// ── Subscription storage ─────────────────────────────────────────────────────
const SUBS_FILE = path.join(__dirname, '../subscriptions.json');

function loadSubs() {
  try { return JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8')); }
  catch { return []; }
}

function saveSubs(subs) {
  fs.writeFileSync(SUBS_FILE, JSON.stringify(subs, null, 2));
}

// ── Price cache ──────────────────────────────────────────────────────────────
const CACHE_FILE = path.join(__dirname, '../price-cache.json');
let priceCache = null;

function loadCachedPrice() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { return null; }
}

function saveCachedPrice(data) {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(data)); } catch {}
}

async function refreshPrice() {
  try {
    priceCache = await getGoldPrice();
    saveCachedPrice(priceCache);
    console.log(`[price] ${priceCache.price} USD/20g (${priceCache.source})`);
  } catch (err) {
    console.error('[price] Failed to fetch:', err.message);
    if (!priceCache) priceCache = loadCachedPrice(); // use last known price
  }
}

// ── Routes ───────────────────────────────────────────────────────────────────
app.get('/price', async (req, res) => {
  if (!priceCache) await refreshPrice();
  if (!priceCache) return res.status(503).json({ error: 'Price unavailable — all sources failed' });
  res.json(priceCache);
});

app.get('/debug', async (req, res) => {
  const results = {};
  const sources = [
    ['goldprice.org', 'https://data-asg.goldprice.org/dbXRates/USD'],
    ['yahoo', 'https://query1.finance.yahoo.com/v8/finance/chart/GC%3DF?interval=1m&range=1d'],
    ['metals.live', 'https://api.metals.live/v1/spot/gold'],
    ['frankfurter', 'https://api.frankfurter.app/latest?from=XAU&to=USD'],
  ];
  for (const [name, url] of sources) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(5000), headers: { 'User-Agent': 'Mozilla/5.0' } });
      const text = await r.text();
      results[name] = { status: r.status, body: text.slice(0, 200) };
    } catch (e) {
      results[name] = { error: e.message };
    }
  }
  res.json(results);
});

app.get('/vapid-public-key', (req, res) => {
  res.json({ key: VAPID_PUBLIC });
});

app.post('/subscribe', (req, res) => {
  const { subscription, threshold } = req.body;
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: 'Invalid subscription' });
  }
  const subs = loadSubs().filter(s => s.subscription.endpoint !== subscription.endpoint);
  subs.push({ subscription, threshold: parseFloat(threshold) || 2500 });
  saveSubs(subs);
  res.json({ ok: true });
});

app.post('/unsubscribe', (req, res) => {
  const { endpoint } = req.body;
  const subs = loadSubs().filter(s => s.subscription.endpoint !== endpoint);
  saveSubs(subs);
  res.json({ ok: true });
});

// ── Alert cron (every 5 minutes) ─────────────────────────────────────────────
async function checkAndAlert() {
  await refreshPrice();
  if (!priceCache) return;

  const subs = loadSubs();
  if (subs.length === 0) return;

  const price = priceCache.price;
  const dead = [];

  for (const entry of subs) {
    if (price < entry.threshold) {
      const payload = JSON.stringify({
        title: '🪙 Gold Price Alert!',
        body: `24k Gold is now $${price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} / oz — below your $${entry.threshold} threshold`,
        icon: '/icon-192.png',
        badge: '/icon-192.png',
      });
      try {
        await webpush.sendNotification(entry.subscription, payload);
        console.log(`[alert] Sent push: $${price} < $${entry.threshold}`);
      } catch (err) {
        if (err.statusCode === 410 || err.statusCode === 404) {
          dead.push(entry.subscription.endpoint);
        } else {
          console.error('[alert] Push error:', err.message);
        }
      }
    }
  }

  if (dead.length > 0) {
    const cleaned = loadSubs().filter(s => !dead.includes(s.subscription.endpoint));
    saveSubs(cleaned);
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🪙  Gold Alert running at http://localhost:${PORT}`);
  console.log(`   Open in Safari on your iPhone, then Add to Home Screen\n`);
});

// Load last known price instantly, then refresh
priceCache = loadCachedPrice();
refreshPrice();
cron.schedule('* * * * *', refreshPrice);        // refresh price every 1 minute
cron.schedule('*/5 * * * *', checkAndAlert);     // check alerts every 5 minutes
