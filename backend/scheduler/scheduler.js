import cron from 'node-cron';
import path from 'path';
import fs from 'fs';

const ROOT_DIR = path.basename(process.cwd()) === 'backend'
  ? path.resolve(process.cwd(), '..')
  : process.cwd();
const SCREENSHOT_DIR = path.resolve(ROOT_DIR, 'screenshots');

import { scrapeRemitbee }  from '../playwright/remitbee.js';
import { scrapeRemitly }   from '../playwright/remitly.js';
import { scrapeTapTapSend } from '../playwright/taptapsend.js';
import { scrapeLemFi }     from '../playwright/lemfi.js';
import { scrapeInstarem }  from '../playwright/instarem.js';
import { scrapeMoneyGram }    from '../playwright/moneygram.js';
import { scrapeKabayanRemit } from '../playwright/kabayanremit.js';
import { saveRates, saveLog } from '../models/rateModel.js';

const FROM_CUR     = 'CAD';
const TO_CURRENCIES = ['INR', 'PHP', 'LKR', 'UAH', 'NPR', 'BDT', 'PKR'];

const PROVIDERS = [
  { name: 'Remitbee',      fn: scrapeRemitbee    },
  { name: 'Remitly',       fn: scrapeRemitly     },
  { name: 'TapTap Send',   fn: scrapeTapTapSend  },
  { name: 'LemFi',         fn: scrapeLemFi       },
  { name: 'Instarem',      fn: scrapeInstarem    },
  { name: 'MoneyGram',     fn: scrapeMoneyGram   },
  { name: 'Kabayan Remit', fn: scrapeKabayanRemit },
];

const MAX_RETRIES  = 3;
const RETRY_DELAY  = 8000; // ms

async function runWithRetry(fn, maxRetries = MAX_RETRIES) {
  let lastErr;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries) {
        console.warn(`  ↻ Retry ${attempt}/${maxRetries - 1} after ${RETRY_DELAY / 1000}s...`);
        await sleep(RETRY_DELAY * attempt);
      }
    }
  }
  throw lastErr;
}

async function runAllProviders() {
  const started = new Date();
  console.log(`\n═══════════════════════════════════════════`);
  console.log(`▶ Scrape run started at ${started.toISOString()}`);
  console.log(`═══════════════════════════════════════════`);

  for (const provider of PROVIDERS) {
    const label = provider.name;
    console.log(`\n── ${label} ──`);
    try {
      const rates = await runWithRetry(() => provider.fn(FROM_CUR, TO_CURRENCIES));
      await saveRates(label, rates);
      const msg = `Scraped ${rates.length} rate(s) for ${rates.map(r => r.toCurrency).join(', ')}`;
      await saveLog(label, 'success', msg);
      console.log(`  ✔ ${msg}`);
    } catch (err) {
      const msg = err.message || String(err);
      console.error(`  ✘ ${label} failed: ${msg}`);
      // Take screenshot if playwright was involved
      const screenshotPath = await captureErrorScreenshot(label);
      await saveLog(label, 'error', msg, screenshotPath).catch(() => {});
      // Continue with next provider — never stop the scheduler
    }
  }

  const elapsed = ((Date.now() - started.getTime()) / 1000).toFixed(1);
  console.log(`\n═══════════════════════════════════════════`);
  console.log(`✔ Scrape run complete in ${elapsed}s`);
  console.log(`═══════════════════════════════════════════\n`);
}

async function captureErrorScreenshot(providerName) {
  try {
    let chromium;
    try { ({ chromium } = await import('playwright')); } catch { return null; }
    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const page = await (await browser.newContext()).newPage();
    const filePath = path.join(SCREENSHOT_DIR, `${providerName.replace(/\s+/g, '_')}_${Date.now()}.png`);
    await page.screenshot({ path: filePath });
    await browser.close();
    return filePath;
  } catch {
    return null;
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Schedule: every 2 hours ────────────────────────────────────────────────
cron.schedule('0 */2 * * *', () => {
  runAllProviders().catch(err => console.error('Scheduler top-level error:', err));
});

// ── Run immediately on startup ─────────────────────────────────────────────
runAllProviders().catch(err => console.error('Initial run error:', err));

console.log('Scheduler started — runs every 2 hours (cron: 0 */2 * * *)');
