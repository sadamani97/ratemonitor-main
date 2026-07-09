// LemFi — Playwright scrapes rendered page text
// The "rate" field in /api/lemonade/v2/exchange is a bogus scientific number (4.3e+23)
// Correct rate is shown on the page as "1 CAD = 66.45 INR" — we scrape that.
// Fee comes from the network API's transaction_fee field (that field IS valid).
//
// Currencies run in PARALLEL (each currency gets its own page in the same browser context)
// so total time ≈ slowest single currency (~15s) instead of 7 × 15s = 105s.

const SUPPORTED = ['INR', 'PHP', 'LKR', 'UAH', 'NPR', 'BDT', 'PKR'];

const COUNTRY_MAP = {
  INR: 'india', PHP: 'philippines', LKR: 'sri-lanka',
  UAH: 'ukraine', NPR: 'nepal', BDT: 'bangladesh',
  PKR: 'pakistan',
};

async function scrapeCurrency(ctx, fromCur, toCur) {
  const country = COUNTRY_MAP[toCur];
  if (!country) return null;

  const page = await ctx.newPage();
  let networkFee = null;

  // Capture fee from the exchange API — transaction_fee IS accurate (rate field is NOT)
  const feeCapture = page.waitForResponse(
    r => r.url().includes('/api/lemonade/v2/exchange'),
    { timeout: 20000 }
  ).then(async (r) => {
    try {
      const body = await r.json();
      const fee = parseFloat(body?.data?.transaction_fee);
      if (!isNaN(fee)) networkFee = fee;
    } catch { }
  }).catch(() => { });

  try {
    await page.goto(
      `https://lemfi.com/en-ca/international-money-transfer/${country}?amount=100&amountType=sending`,
      { waitUntil: 'domcontentloaded', timeout: 35000 }
    );

    // Wait until an actual rate number appears after "1 CAD = " in the DOM
    // The page briefly shows "1 CAD = " (loading), then fills in the rate number
    await page.waitForFunction(
      () => document.body && /1\s+CAD\s*=\s*[\d.]{4,}/.test(document.body.innerText),
      { timeout: 25000 }
    ).catch(() => { });

    // Allow the fee API to complete
    await Promise.race([feeCapture, page.waitForTimeout(2000)]);

    // Scrape the exchange rate from the rendered page
    const pageData = await page.evaluate((toCur) => {
      const text = document.body.innerText;

      // Primary pattern: "1 CAD = 66.45 INR"
      let rate = null;
      const p1 = new RegExp(`1\\s+CAD\\s*=\\s*([\\d.,]+)\\s+${toCur}`, 'i');
      const m1 = text.match(p1);
      if (m1) rate = parseFloat(m1[1].replace(',', ''));

      // Pattern 2: "1 CAD = 66.45" (no currency suffix)
      if (!rate) {
        const m2 = text.match(/1\s+CAD\s*=\s*([\d.,]+)/i);
        if (m2) rate = parseFloat(m2[1].replace(',', ''));
      }

      // Pattern 3: recipient gets X {CUR} for 100 CAD → rate = X / 100
      if (!rate) {
        const p3 = new RegExp(`([\\d,]+\\.\\d+)\\s*${toCur}`, 'gi');
        const matches = [...text.matchAll(p3)];
        for (const m of matches) {
          const val = parseFloat(m[1].replace(',', ''));
          if (val > 100 && val < 10_000_000) { rate = val / 100; break; }
        }
      }

      // Fee from page text
      let fee = null;
      const feePatterns = [
        /transfer\s+fees?\s*[\n\r]+\$?([\d.]+)/i,
        /(?:transaction|transfer|send(?:ing)?)\s*fee\s*[:\s]+\$?([\d.]+)/i,
        /fee\s*[:\s]+\$?([\d.]+)/i,
      ];
      for (const p of feePatterns) {
        const m = text.match(p);
        if (m) { fee = parseFloat(m[1]); break; }
      }

      return { rate, fee };
    }, toCur);

    const rate = pageData?.rate;
    const fee = networkFee ?? pageData?.fee;

    if (rate && rate > 0 && rate < 1_000_000) {
      console.log(`[LemFi] ${toCur}: rate=${rate.toFixed(4)}, fee=${fee}`);
      return {
        fromCurrency: fromCur,
        toCurrency: toCur,
        exchangeRate: Math.round(rate * 10000) / 10000,
        promotionalRate: null,
        fee: fee ?? null,
        deliveryTime: 'Minutes',
        transferType: 'Online',
      };
    } else {
      console.log(`[LemFi] ${toCur}: not supported or rate not found`);
      return null;
    }
  } catch (e) {
    console.error(`[LemFi] ${toCur}:`, e.message?.slice(0, 80));
    return null;
  } finally {
    await page.close();
  }
}

export async function scrapeLemFi(fromCur = 'CAD', toCurrencies = SUPPORTED) {
  let chromium;
  try { ({ chromium } = await import('playwright')); } catch { return []; }

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
    });

    const ctx = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
      locale: 'en-CA',
      extraHTTPHeaders: { 'Accept-Language': 'en-CA,en;q=0.9' },
    });

    await ctx.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    // Run requested currencies in parallel (usually just 1 currency target requested)
    const targets = toCurrencies.filter(cur => SUPPORTED.includes(cur));
    const results = await Promise.all(
      targets.map(toCur => scrapeCurrency(ctx, fromCur, toCur))
    );

    return results.filter(Boolean);
  } finally {
    if (browser) await browser.close();
  }
}
