async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function getGoldPrice() {
  const errors = [];

  // Source 1: goldprice.org
  try {
    const res = await fetchWithTimeout('https://data-asg.goldprice.org/dbXRates/USD');
    if (res.ok) {
      const data = await res.json();
      const price = data?.items?.[0]?.xauPrice;
      if (price && price > 100) {
        console.log('[scraper] goldprice.org:', price);
        return { price, source: 'goldprice.org', updatedAt: new Date().toISOString() };
      }
    }
  } catch (e) { errors.push('goldprice.org: ' + e.message); }

  // Source 2: Yahoo Finance gold futures
  try {
    const res = await fetchWithTimeout(
      'https://query1.finance.yahoo.com/v8/finance/chart/GC%3DF?interval=1m&range=1d',
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    if (res.ok) {
      const data = await res.json();
      const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
      if (price && price > 100) {
        console.log('[scraper] yahoo finance:', price);
        return { price, source: 'Yahoo Finance', updatedAt: new Date().toISOString() };
      }
    }
  } catch (e) { errors.push('yahoo: ' + e.message); }

  // Source 3: metals.live
  try {
    const res = await fetchWithTimeout('https://api.metals.live/v1/spot/gold');
    if (res.ok) {
      const data = await res.json();
      const price = data?.[0]?.price;
      if (price && price > 100) {
        console.log('[scraper] metals.live:', price);
        return { price, source: 'metals.live', updatedAt: new Date().toISOString() };
      }
    }
  } catch (e) { errors.push('metals.live: ' + e.message); }

  // Source 4: Frankfurter (XAU/USD via currency rates)
  try {
    const res = await fetchWithTimeout('https://api.frankfurter.app/latest?from=XAU&to=USD');
    if (res.ok) {
      const data = await res.json();
      const price = data?.rates?.USD;
      if (price && price > 100) {
        console.log('[scraper] frankfurter:', price);
        return { price, source: 'frankfurter', updatedAt: new Date().toISOString() };
      }
    }
  } catch (e) { errors.push('frankfurter: ' + e.message); }

  console.error('[scraper] All sources failed:', errors.join(' | '));
  throw new Error('All price sources failed: ' + errors.join(', '));
}

module.exports = { getGoldPrice };
