const { chromium } = require('playwright');

async function scrapeGoldPrice() {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    await page.goto('https://gold.bdfl.bt/', { waitUntil: 'networkidle', timeout: 30000 });

    // Wait for skeleton loaders to disappear and real content to appear
    await page.waitForFunction(() => {
      const skeletons = document.querySelectorAll('[data-slot="skeleton"]');
      return skeletons.length === 0;
    }, { timeout: 20000 });

    // Extract page text and look for 24k gold price
    const text = await page.innerText('body');
    const price = parse24kPrice(text);

    if (price !== null) {
      return { price, source: 'gold.bdfl.bt', updatedAt: new Date().toISOString() };
    }

    // Try to find price elements more specifically
    const priceEl = await page.$('[class*="price"], [class*="gold"], h1, h2, h3');
    if (priceEl) {
      const elText = await priceEl.innerText();
      const p = parse24kPrice(elText);
      if (p !== null) {
        return { price: p, source: 'gold.bdfl.bt', updatedAt: new Date().toISOString() };
      }
    }

    throw new Error('Could not parse 24k price from page');
  } finally {
    if (browser) await browser.close();
  }
}

function parse24kPrice(text) {
  // Look for patterns like "24K ... $3,200" or "24 Karat ... 3200.50"
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/24\s*[kK]/i.test(line)) {
      // Check this line and next 3 lines for a price
      const searchLines = lines.slice(i, i + 4).join(' ');
      const match = searchLines.match(/\$?\s*([\d,]+(?:\.\d{1,2})?)/);
      if (match) {
        const val = parseFloat(match[1].replace(/,/g, ''));
        if (val > 100 && val < 1000000) return val;
      }
    }
  }

  // Broader: find any dollar amount that looks like a gold price per gram or per troy oz
  const dollarMatches = text.match(/\$\s*([\d,]+(?:\.\d{1,2})?)/g);
  if (dollarMatches) {
    for (const m of dollarMatches) {
      const val = parseFloat(m.replace(/[$,\s]/g, ''));
      // Gold per gram is roughly $90-200, per troy oz $2500-4000
      if (val > 1000 && val < 10000) return val;
    }
  }

  return null;
}

async function getFallbackPrice() {
  // Uses open gold price data from public sources
  const res = await fetch('https://api.metals.dev/v1/latest?api_key=demo&base=USD&currencies=XAU');
  if (res.ok) {
    const data = await res.json();
    const pricePerOz = data?.currencies?.XAU ? 1 / data.currencies.XAU : null;
    if (pricePerOz) return { price: pricePerOz, source: 'metals.dev', updatedAt: new Date().toISOString() };
  }

  // Second fallback: goldprice.org JSON feed
  const res2 = await fetch('https://data-asg.goldprice.org/dbXRates/USD');
  if (res2.ok) {
    const data = await res2.json();
    const pricePerOz = data?.items?.[0]?.xauPrice;
    if (pricePerOz) return { price: pricePerOz, source: 'goldprice.org', updatedAt: new Date().toISOString() };
  }

  throw new Error('All price sources failed');
}

async function getGoldPrice() {
  try {
    return await scrapeGoldPrice();
  } catch (err) {
    console.warn('[scraper] Primary source failed:', err.message, '— trying fallback');
    return await getFallbackPrice();
  }
}

module.exports = { getGoldPrice };
