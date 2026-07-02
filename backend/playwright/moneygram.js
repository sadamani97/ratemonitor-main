// MoneyGram — patchright + real Chrome to pass DataDome.
// Loads the CAD→INR converter once, then switches receive country via the
// "Sending to" dropdown to trigger fee-quote API calls for each currency.

import { chromium } from 'patchright';
import path from 'path';
import os from 'os';

const PROFILE_DIR = process.env.MONEYGRAM_PROFILE_DIR
  || path.join(os.tmpdir(), 'ratemonitor-moneygram-profile');

const SUPPORTED = ['INR', 'PHP', 'LKR', 'UAH', 'NPR', 'BDT', 'PKR'];

/** Country name as shown in the MoneyGram "Sending to" picker. */
const COUNTRY_LABEL = {
  INR: 'India',
  PHP: 'Philippines',
  LKR: 'Sri Lanka',
  UAH: 'Ukraine',
  NPR: 'Nepal',
  BDT: 'Bangladesh',
  PKR: 'Pakistan',
};

function waitForFeeQuote(page, currency, timeoutMs = 35000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (quote) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      page.off('response', onResponse);
      resolve(quote);
    };

    const onResponse = async (r) => {
      if (!r.url().includes('fee-quote/v2') || r.status() !== 200) return;
      const ct = r.headers()['content-type'] || '';
      if (!ct.includes('json')) return;
      try {
        const body = await r.json();
        const quote = body?.feeQuotesByCurrency?.[currency];
        if (quote) finish(quote);
      } catch {}
    };

    page.on('response', onResponse);
    const timer = setTimeout(() => finish(null), timeoutMs);
  });
}

async function acceptCookies(page) {
  const btn = page.locator('button:has-text("Accept")').first();
  if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await btn.click().catch(() => {});
    await page.waitForTimeout(500);
  }
}

async function selectReceiveCountry(page, currency) {
  const label = COUNTRY_LABEL[currency];
  if (!label) return false;

  const picker = page.locator('button[aria-label="Sending to"]').first();
  await picker.waitFor({ state: 'visible', timeout: 15000 });
  await picker.click();

  const search = page.locator('input[type="search"], input[placeholder*="Search"], input[placeholder*="search"]').first();
  if (await search.isVisible({ timeout: 3000 }).catch(() => false)) {
    await search.fill(label);
    await page.waitForTimeout(600);
  }

  const option = page.locator(`[role="option"]:has-text("${label}"), li:has-text("${label}")`).first();
  await option.waitFor({ state: 'visible', timeout: 10000 });
  await option.click();
  return true;
}

export async function scrapeMoneyGram(fromCur = 'CAD', toCurrencies = SUPPORTED) {
  // DataDome challenges are intermittent in unattended runs — a second
  // attempt a few seconds later frequently succeeds where the first didn't.
  let results = await scrapeMoneyGramOnce(fromCur, toCurrencies);
  if (results.length === 0) {
    console.warn('[MoneyGram] First attempt returned no data — retrying once');
    await new Promise(r => setTimeout(r, 5000));
    results = await scrapeMoneyGramOnce(fromCur, toCurrencies);
  }
  return results;
}

async function scrapeMoneyGramOnce(fromCur, toCurrencies) {
  const results = [];
  let context;

  const headless = process.env.MONEYGRAM_HEADLESS === 'true';
  const launchOpts = {
    channel: 'chrome',
    headless,
    locale: 'en-CA',
    timezoneId: 'America/Toronto',
    viewport: headless ? { width: 1440, height: 900 } : null,
    args: ['--disable-blink-features=AutomationControlled'],
  };
  if (process.env.MONEYGRAM_PROXY) {
    launchOpts.proxy = { server: process.env.MONEYGRAM_PROXY };
  }

  try {
    try {
      context = await chromium.launchPersistentContext(PROFILE_DIR, launchOpts);
    } catch (e) {
      // Profile may be locked if a previous Chrome session is still open
      if (/existing browser session/i.test(e.message)) {
        const fallbackDir = `${PROFILE_DIR}-${process.pid}`;
        console.warn('[MoneyGram] Profile locked — using fallback browser profile');
        context = await chromium.launchPersistentContext(fallbackDir, launchOpts);
      } else {
        throw e;
      }
    }
    const page = context.pages()[0] || await context.newPage();

    await page.goto(
      'https://www.moneygram.com/ca/en/currency-converter/cad-to-inr',
      { waitUntil: 'domcontentloaded', timeout: 60000 }
    );
    await acceptCookies(page);

    // Warm up DataDome session on the first page load
    const warmed = await waitForFeeQuote(page, 'INR', 45000);
    if (!warmed) {
      // The page can crash mid-challenge (DataDome killing the tab) — treat
      // that the same as a soft block instead of letting it blow up as an
      // uncaught "Target crashed" error.
      const blocked = await page.evaluate(() =>
        document.title?.includes('blocked') || document.body?.innerText?.includes('You have been blocked')
      ).catch(() => null);
      if (blocked) {
        console.warn('[MoneyGram] DataDome hard block — requires Google Chrome (headed). Set MONEYGRAM_PROXY for server use.');
      } else {
        console.warn('[MoneyGram] DataDome still blocking (or tab crashed) — ensure Google Chrome is installed');
      }
      return [];
    }

    console.log('[MoneyGram] Session established — fetching all currencies');

    const targets = toCurrencies.filter(cur => COUNTRY_LABEL[cur]);

    for (const cur of targets) {
      let quote = null;

      if (cur === 'INR') {
        quote = warmed;
      } else {
        const quotePromise = waitForFeeQuote(page, cur);
        try {
          const selected = await selectReceiveCountry(page, cur);
          if (!selected) {
            console.warn(`[MoneyGram] ${cur}: country picker not found`);
            continue;
          }
          quote = await quotePromise;
        } catch (e) {
          console.warn(`[MoneyGram] ${cur}: UI selection failed — ${e.message?.slice(0, 80)}`);
          continue;
        }
      }

      if (!quote) {
        console.warn(`[MoneyGram] ${cur}: fee-quote not received`);
        continue;
      }

      const fxRate    = parseFloat(quote.fxRate);
      const sendFee   = parseFloat(quote.sendFee ?? 0);
      const promoRate = quote.promo
        ? parseFloat(quote.promo.fxRate ?? quote.promo.exchangeRate ?? quote.promo.rate ?? 0)
        : 0;

      if (fxRate > 0 && fxRate < 1_000_000) {
        results.push({
          fromCurrency:    fromCur,
          toCurrency:      cur,
          exchangeRate:    fxRate,
          promotionalRate: promoRate > 0 && promoRate !== fxRate ? promoRate : null,
          fee:             isNaN(sendFee) ? null : sendFee,
          deliveryTime:    null,
          transferType:    'Online',
        });
        console.log(`[MoneyGram] ${cur}: rate=${fxRate}, promo=${promoRate || 'none'}, fee=${sendFee}`);
      }

      await page.waitForTimeout(1000);
    }

    if (results.length === 0) {
      console.warn('[MoneyGram] No valid rates returned');
    }
  } catch (e) {
    console.error('[MoneyGram]', e.message?.slice(0, 120));
  } finally {
    if (context) await context.close().catch(() => {});
  }

  return results;
}
