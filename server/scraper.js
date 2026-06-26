async function getGoldPrice() {
  // Try goldprice.org JSON feed
  try {
    const res = await fetch('https://data-asg.goldprice.org/dbXRates/USD');
    if (res.ok) {
      const data = await res.json();
      const pricePerOz = data?.items?.[0]?.xauPrice;
      if (pricePerOz) return { price: pricePerOz, source: 'goldprice.org', updatedAt: new Date().toISOString() };
    }
  } catch (e) { console.warn('[scraper] goldprice.org failed:', e.message); }

  // Try metals-api
  try {
    const res = await fetch('https://api.metals.live/v1/spot/gold');
    if (res.ok) {
      const data = await res.json();
      const price = data?.[0]?.price;
      if (price) return { price, source: 'metals.live', updatedAt: new Date().toISOString() };
    }
  } catch (e) { console.warn('[scraper] metals.live failed:', e.message); }

  // Try frankfurter / open exchange as last resort
  try {
    const res = await fetch('https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/XAU/USD');
    if (res.ok) {
      const data = await res.json();
      const price = data?.[0]?.spreadProfilePrices?.[0]?.ask;
      if (price) return { price, source: 'swissquote', updatedAt: new Date().toISOString() };
    }
  } catch (e) { console.warn('[scraper] swissquote failed:', e.message); }

  throw new Error('All price sources failed');
}

module.exports = { getGoldPrice };
