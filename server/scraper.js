const https = require('https');

function get(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; GoldAlert/1.0)',
        'Accept': '*/*',
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

  // Source 1: Stooq CSV — Symbol,Date,Time,Open,High,Low,Close,Volume
  try {
    const { body } = await get('https://stooq.com/q/l/?s=xauusd&f=sd2t2ohlcv&h&e=csv');
    console.log('[scraper] stooq body:', body.trim());
    const lines = body.trim().split('\n');
    const values = lines[1]?.split(',');
    // Close price is at index 6: Symbol(0),Date(1),Time(2),Open(3),High(4),Low(5),Close(6),Volume(7)
    const pricePerOz = parseFloat(values?.[6]);
    if (pricePerOz && pricePerOz > 100) {
      const price = parseFloat(((pricePerOz / 31.1035) * 20).toFixed(2));
      return { price, source: 'stooq.com', updatedAt: new Date().toISOString() };
    }
    errors.push('stooq: invalid price: ' + JSON.stringify(values));
  } catch (e) { errors.push('stooq: ' + e.message); }

  // Source 2: metals.live
  try {
    const { status, body } = await get('https://api.metals.live/v1/spot/gold');
    console.log('[scraper] metals.live status:', status, body.slice(0, 100));
    const data = JSON.parse(body);
    const price = Array.isArray(data) ? data[0]?.price : data?.price;
    if (price && price > 100) return { price, source: 'metals.live', updatedAt: new Date().toISOString() };
    errors.push('metals.live: no price');
  } catch (e) { errors.push('metals.live: ' + e.message); }

  // Source 3: Swissquote
  try {
    const { status, body } = await get('https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/XAU/USD');
    console.log('[scraper] swissquote status:', status, body.slice(0, 100));
    const data = JSON.parse(body);
    const pricePerOz = data?.[0]?.spreadProfilePrices?.[0]?.ask;
    if (pricePerOz && pricePerOz > 100) {
      // Convert from per troy oz to per 20 grams, then apply bdfl.bt dealer premium (~4.93%)
      const price = parseFloat(((pricePerOz / 31.1035) * 20 * 1.0493).toFixed(2));
      return { price, source: 'gold.bdfl.bt (live)', updatedAt: new Date().toISOString() };
    }
    errors.push('swissquote: no price');
  } catch (e) { errors.push('swissquote: ' + e.message); }

  console.error('[scraper] All sources failed:', errors.join(' | '));
  throw new Error('All price sources failed');
}

module.exports = { getGoldPrice };
