const https = require('https');

function get(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; GoldAlert/1.0)',
        'Accept': 'application/json, text/plain, */*',
      },
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

async function getGoldPrice() {
  const errors = [];

  // Source 1: goldprice.org
  try {
    const { status, body } = await get('https://data-asg.goldprice.org/dbXRates/USD');
    console.log('[scraper] goldprice.org status:', status, 'body:', body.slice(0, 100));
    const data = JSON.parse(body);
    const price = data?.items?.[0]?.xauPrice;
    if (price && price > 100) return { price, source: 'goldprice.org', updatedAt: new Date().toISOString() };
    errors.push('goldprice.org: no price in response');
  } catch (e) { errors.push('goldprice.org: ' + e.message); }

  // Source 2: Stooq CSV (very reliable)
  try {
    const { status, body } = await get('https://stooq.com/q/l/?s=xauusd&f=sd2t2ohlcv&h&e=csv');
    console.log('[scraper] stooq status:', status, 'body:', body.slice(0, 100));
    const lines = body.trim().split('\n');
    const values = lines[1]?.split(',');
    const price = parseFloat(values?.[4]); // Close price
    if (price && price > 100) return { price, source: 'stooq.com', updatedAt: new Date().toISOString() };
    errors.push('stooq: no price in response');
  } catch (e) { errors.push('stooq: ' + e.message); }

  // Source 3: Yahoo Finance
  try {
    const { status, body } = await get('https://query2.finance.yahoo.com/v8/finance/chart/GC%3DF?interval=1d&range=1d');
    console.log('[scraper] yahoo status:', status, 'body:', body.slice(0, 100));
    const data = JSON.parse(body);
    const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
    if (price && price > 100) return { price, source: 'Yahoo Finance', updatedAt: new Date().toISOString() };
    errors.push('yahoo: no price in response');
  } catch (e) { errors.push('yahoo: ' + e.message); }

  // Source 4: Frankfurter
  try {
    const { status, body } = await get('https://api.frankfurter.app/latest?from=XAU&to=USD');
    console.log('[scraper] frankfurter status:', status, 'body:', body.slice(0, 100));
    const data = JSON.parse(body);
    const price = data?.rates?.USD;
    if (price && price > 100) return { price, source: 'frankfurter', updatedAt: new Date().toISOString() };
    errors.push('frankfurter: no price in response');
  } catch (e) { errors.push('frankfurter: ' + e.message); }

  console.error('[scraper] All sources failed:', errors.join(' | '));
  throw new Error('All price sources failed: ' + errors.join(', '));
}

module.exports = { getGoldPrice };
