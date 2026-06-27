const https = require('https');

function get(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GoldAlert/1.0)', 'Accept': '*/*' },
      timeout: 8000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function scrapeFromBdfl() {
  const { chromium } = require('playwright');
  let browser;
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    await page.goto('https://gold.bdfl.bt/', { waitUntil: 'networkidle', timeout: 30000 });

    // Wait for skeleton loaders to disappear
    await page.waitForFunction(() => {
      const skeletons = document.querySelectorAll('[data-slot="skeleton"]');
      return skeletons.length === 0;
    }, { timeout: 20000 }).catch(() => {});

    const text = await page.innerText('body');
    console.log('[scraper] bdfl.bt page text (first 300):', text.slice(0, 300));

    // Find price in page text
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(/^\$?([\d,]+(?:\.\d{1,2})?)$/);
      if (match) {
        const val = parseFloat(match[1].replace(/,/g, ''));
        if (val > 500 && val < 100000) {
          console.log('[scraper] bdfl.bt price found:', val);
          return { price: val, source: 'gold.bdfl.bt', updatedAt: new Date().toISOString() };
        }
      }
    }
    throw new Error('Could not find price in page');
  } finally {
    if (browser) await browser.close();
  }
}

async function getGoldPrice() {
  // Try bdfl.bt directly first
  try {
    return await scrapeFromBdfl();
  } catch (e) {
    console.warn('[scraper] bdfl.bt failed:', e.message, '— using fallback');
  }

  // Fallback: Yahoo Finance
  try {
    const { status, body } = await get('https://query1.finance.yahoo.com/v8/finance/chart/GC%3DF?interval=1d&range=1d');
    console.log('[scraper] yahoo status:', status);
    const data = JSON.parse(body);
    const pricePerOz = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
    if (pricePerOz && pricePerOz > 100) {
      const price = parseFloat(((pricePerOz / 31.1035) * 20 * 1.0493).toFixed(2));
      console.log('[scraper] yahoo fallback price:', price);
      return { price, source: 'live market (approx)', updatedAt: new Date().toISOString() };
    }
  } catch (e) { console.warn('[scraper] yahoo failed:', e.message); }

  // Fallback: Swissquote
  try {
    const { status, body } = await get('https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/XAU/USD');
    const data = JSON.parse(body);
    const pricePerOz = data?.[0]?.spreadProfilePrices?.[0]?.ask;
    if (pricePerOz && pricePerOz > 100) {
      const price = parseFloat(((pricePerOz / 31.1035) * 20 * 1.0493).toFixed(2));
      return { price, source: 'live market (approx)', updatedAt: new Date().toISOString() };
    }
  } catch (e) { console.warn('[scraper] swissquote failed:', e.message); }

  throw new Error('All price sources failed');
}

module.exports = { getGoldPrice };
