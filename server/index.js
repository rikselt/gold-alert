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
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const VAPID_EMAIL   = process.env.VAPID_EMAIL || 'mailto:admin@gold-alert.local';

if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
  const wp = require('web-push');
  const keys = wp.generateVAPIDKeys();
  const envPath = path.join(__dirname, '../.env');
  const envContent = [
    `VAPID_PUBLIC_KEY=${keys.publicKey}`,
    `VAPID_PRIVATE_KEY=${keys.privateKey}`,
    `VAPID_EMAIL=${VAPID_EMAIL}`,
    `PORT=3000`,
  ].join('\n');
  fs.writeFileSync(envPath, envContent);
  console.log('[setup] Generated VAPID keys and wrote .env — please restart the server.');
  process.exit(0);
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
let priceCache = null;

async function refreshPrice() {
  try {
    priceCache = await getGoldPrice();
    console.log(`[price] ${priceCache.price} USD/oz (${priceCache.source})`);
  } catch (err) {
    console.error('[price] Failed to fetch:', err.message);
  }
}

// ── Routes ───────────────────────────────────────────────────────────────────
app.get('/price', async (req, res) => {
  if (!priceCache) await refreshPrice();
  if (!priceCache) return res.status(503).json({ error: 'Price unavailable' });
  res.json(priceCache);
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

// Initial price fetch + cron
refreshPrice();
cron.schedule('* * * * *', refreshPrice);        // refresh price every 1 minute
cron.schedule('*/5 * * * *', checkAndAlert);     // check alerts every 5 minutes
