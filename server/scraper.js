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

  // Source 1: Yahoo Finance (gold futures GC=F)
  try {
    const { status, body } = await get('https://query1.finance.yahoo.com/v8/finance/chart/GC%3DF?interval=1d&range=1d');
    console.log('[scraper] yahoo status:', status);
    const data = JSON.parse(body);
    const pricePerOz = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
    console.log('[scraper] yahoo pricePerOz:', pricePerOz);
    if (pricePerOz && pricePerOz > 100) {
      const price = parseFloat(((pricePerOz / 31.1035) * 20 * 1.0493).toFixed(2));
      console.log('[scraper] yahoo converted price:', price);
      return { price, source: 'live market', updatedAt: new Date().toISOString() };
    }
    errors.push('yahoo: no price in response');
  } catch (e) { errors.push('yahoo: ' + e.message); }

  // Source 2: Swissquote
  try {
    const { status, body } = await get('https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/XAU/USD');
    console.log('[scraper] swissquote status:', status);
    const data = JSON.parse(body);
    const pricePerOz = data?.[0]?.spreadProfilePrices?.[0]?.ask;
    console.log('[scraper] swissquote pricePerOz:', pricePerOz);
    if (pricePerOz && pricePerOz > 100) {
      const price = parseFloat(((pricePerOz / 31.1035) * 20 * 1.0493).toFixed(2));
      return { price, source: 'live market', updatedAt: new Date().toISOString() };
    }
    errors.push('swissquote: no price');
  } catch (e) { errors.push('swissquote: ' + e.message); }

  console.error('[scraper] All sources failed:', errors.join(' | '));
  throw new Error('All price sources failed');
}

module.exports = { getGoldPrice };
