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
let VAPID_PUBLIC  = (process.env.VAPID_PUBLIC_KEY  || '').replace(/^["']|["']$/g, '').trim();
let VAPID_PRIVATE = (process.env.VAPID_PRIVATE_KEY || '').replace(/^["']|["']$/g, '').trim();
const VAPID_EMAIL = (process.env.VAPID_EMAIL || 'mailto:rikselt@gmail.com').replace(/^["']|["']$/g, '').trim();

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
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..');
const SUBS_FILE = path.join(DATA_DIR, 'subscriptions.json');

function loadSubs() {
  try {
    const fileSubs = JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8'));
    if (fileSubs.length > 0) return fileSubs;
  } catch {}
  try {
    const envSubs = process.env.PUSH_SUBSCRIPTIONS;
    console.log('[subs] PUSH_SUBSCRIPTIONS env length:', envSubs ? envSubs.length : 'NOT SET');
    if (envSubs) {
      const parsed = JSON.parse(envSubs);
      console.log('[subs] Loaded', parsed.length, 'subscription(s) from env var');
      return parsed;
    }
  } catch (e) {
    console.error('[subs] Failed to parse PUSH_SUBSCRIPTIONS env var:', e.message);
  }
  return [];
}

function saveSubs(subs) {
  try { fs.writeFileSync(SUBS_FILE, JSON.stringify(subs, null, 2)); } catch {}
  // Log the subscription so user can back it up in Railway Variables
  console.log('[subs] Current subscriptions (save as PUSH_SUBSCRIPTIONS in Railway Variables):');
  console.log(JSON.stringify(subs));
}

// ── Price cache ──────────────────────────────────────────────────────────────
const CACHE_FILE = path.join(DATA_DIR, 'price-cache.json');
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

// ── TER price ────────────────────────────────────────────────────────────────
const https = require('https');
let terCache = null;
let terCacheTime = 0;
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 8000 }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function httpGetDetailed(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        'Accept': 'application/json, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Origin': 'https://ter.bt',
        'Referer': 'https://ter.bt/',
        ...headers,
      },
      timeout: 12000,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function getTerPrice() {
  // Log detailed response to diagnose what's blocking us
  try {
    const { status, body, headers } = await httpGetDetailed('https://api.ter.bt/prices');
    console.log('[ter] api.ter.bt status:', status);
    console.log('[ter] api.ter.bt cors header:', headers['access-control-allow-origin']);
    console.log('[ter] api.ter.bt body (100 chars):', body.slice(0, 100));
    const parsed = JSON.parse(body);
    if (Array.isArray(parsed) && parsed.length > 0) {
      const usd = parsed.find(d => d.product_symbol === 'TERUSD');
      const btn = parsed.find(d => d.product_symbol === 'TERBTN');
      if (usd) {
        console.log('[ter] price fetched: USD buy=' + (usd.ask_price / 10000));
        return {
          buy: (usd.ask_price / 10000).toFixed(4),
          sell: (usd.bid_price / 10000).toFixed(4),
          btnBuy: btn ? (btn.ask_price / 10000).toFixed(4) : null,
          btnSell: btn ? (btn.bid_price / 10000).toFixed(4) : null,
          updatedAt: usd.effective_at,
        };
      }
    }
    throw new Error('Bad response: ' + body.slice(0, 80));
  } catch (e) {
    console.warn('[ter] direct fetch error:', e.message);
    throw e;
  }
}

// ── Routes ───────────────────────────────────────────────────────────────────
app.get('/price', async (req, res) => {
  if (!priceCache) await refreshPrice();
  if (!priceCache) return res.status(503).json({ error: 'Price unavailable — all sources failed' });
  res.json(priceCache);
});

app.get('/ter-price', async (req, res) => {
  try {
    // Serve cache if less than 30 seconds old
    if (terCache && Date.now() - terCacheTime < 30000) return res.json(terCache);
    const ter = await getTerPrice();
    terCache = ter;
    terCacheTime = Date.now();
    res.json(ter);
  } catch (e) {
    if (terCache) return res.json(terCache); // serve stale cache on error
    res.status(503).json({ error: e.message });
  }
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
  console.log(`[alert] Checking ${subs.length} subscription(s), price: ${priceCache.price}`);
  if (subs.length === 0) {
    console.log('[alert] No subscriptions found — check PUSH_SUBSCRIPTIONS env var');
    return;
  }

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
        console.error(`[alert] Push error code: ${err.statusCode}, body: ${err.body}, message: ${err.message}`);
        if (err.statusCode === 410 || err.statusCode === 404 || err.statusCode === 400) {
          console.log(`[alert] Removing dead subscription (${err.statusCode})`);
          dead.push(entry.subscription.endpoint);
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
