import { getLatestRates, getRemitbeeRates, saveRates, saveLog } from '../models/rateModel.js';
import { scrapeRemitbee }   from '../playwright/remitbee.js';
import { scrapeRemitly }    from '../playwright/remitly.js';
import { scrapeTapTapSend } from '../playwright/taptapsend.js';
import { scrapeLemFi }      from '../playwright/lemfi.js';
import { scrapeInstarem }   from '../playwright/instarem.js';
import { scrapeKabayanRemit } from '../playwright/kabayanremit.js';
// MoneyGram excluded: requires headed Google Chrome + DataDome bypass (local-only)
// import { scrapeMoneyGram } from '../playwright/moneygram.js';


const TO_CURRENCIES = ['INR', 'PHP', 'LKR', 'UAH', 'NPR', 'BDT', 'PKR'];
const PROVIDERS = [
  { name: 'Remitbee',      fn: scrapeRemitbee    },
  { name: 'Remitly',       fn: scrapeRemitly     },
  { name: 'Instarem',      fn: scrapeInstarem    },
  // TapTap Send & LemFi use standard headless Chromium — work on Render free tier
  { name: 'TapTap Send',   fn: scrapeTapTapSend  },
  { name: 'LemFi',         fn: scrapeLemFi       },
  // Kabayan Remit: CAD→PHP only; scraper handles geo-block gracefully (returns [])
  { name: 'Kabayan Remit', fn: scrapeKabayanRemit },
  // MoneyGram is EXCLUDED: requires headed real Google Chrome + DataDome bypass.
  // This is impossible on any Linux server (Render, Railway, Fly.io, etc.) regardless
  // of plan. It only works on a local Windows/Mac machine with Chrome installed.
  // { name: 'MoneyGram', fn: scrapeMoneyGram },
];

// Per-currency in-memory cache (5 min) — keyed by currency code or 'all'
const memCache = {};

export async function getRates(req, res) {
  const toCurrency = req.query.to || null;
  const cacheKey = toCurrency || 'all';

  try {
    // ── Try MySQL ──────────────────────────────────────────────────────────
    const rows = await getLatestRates(toCurrency);
    if (rows.length > 0) {
      const remitbeeMap = await getRemitbeeRates();
      return res.json({ success: true, source: 'db', data: attachVsRemitbee(rows, remitbeeMap) });
    }
  } catch {
    // MySQL not configured — fall through to live scraping
  }

  // ── Live scraping fallback (Netlify / no DB) ────────────────────────────
  const now = Date.now();
  const cached = memCache[cacheKey];
  if (cached && now - cached.ts < 5 * 60 * 1000) {
    return res.json({ success: true, source: 'cache', data: cached.data });
  }

  try {
    const currencies = toCurrency ? [toCurrency] : TO_CURRENCIES;

    // Each provider gets a timeout — MoneyGram gets up to 80s, others 45s
    const withTimeout = (promise, ms) => Promise.race([
      promise,
      new Promise(resolve => setTimeout(() => resolve([]), ms)),
    ]);

    const allRates = await Promise.allSettled(
      PROVIDERS.map(p => {
        const timeoutMs = p.name === 'MoneyGram' ? 80000 : 45000;
        return withTimeout(
          p.fn('CAD', currencies).then(rates => rates.map(r => ({ ...r, provider: p.name }))),
          timeoutMs
        );
      })
    );

    const rows = allRates
      .filter(r => r.status === 'fulfilled')
      .flatMap(r => r.value)
      .map(r => ({
        provider:         r.provider,
        from_currency:    r.fromCurrency || 'CAD',
        to_currency:      r.toCurrency,
        exchange_rate:    r.exchangeRate,
        promotional_rate: r.promotionalRate,
        fee:              r.fee,
        delivery_time:    r.deliveryTime,
        transfer_type:    r.transferType,
        last_updated:     new Date().toISOString(),
      }));

    const remitbeeMap = {};
    rows.filter(r => r.provider === 'Remitbee').forEach(r => { remitbeeMap[r.to_currency] = r; });

    const result = attachVsRemitbee(rows, remitbeeMap);
    memCache[cacheKey] = { data: result, ts: now };

    // Persist live-scraped data to MySQL in background (don't block the response)
    Promise.allSettled(
      PROVIDERS.map(p => {
        const providerRows = rows.filter(r => r.provider === p.name);
        if (providerRows.length === 0) return Promise.resolve();
        const rates = providerRows.map(r => ({
          fromCurrency:    r.from_currency,
          toCurrency:      r.to_currency,
          exchangeRate:    r.exchange_rate,
          promotionalRate: r.promotional_rate,
          fee:             r.fee,
          deliveryTime:    r.delivery_time,
          transferType:    r.transfer_type,
        }));
        return saveRates(p.name, rates)
          .then(() => saveLog(p.name, 'success', `Live: saved ${rates.length} rates`))
          .catch(() => {}); // silently skip if DB not configured
      })
    ).catch(() => {});

    return res.json({ success: true, source: 'live', data: result });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

function attachVsRemitbee(rows, remitbeeMap) {
  return rows.map(r => {
    const bee = remitbeeMap[r.to_currency];
    const beeRate = parseFloat(bee?.exchange_rate ?? bee?.exchangeRate ?? 0);
    const myRate  = parseFloat(r.exchange_rate ?? r.exchangeRate ?? 0);

    let vsRemitbee = null;
    let vsLabel    = null;
    let vsColor    = null;

    if (r.provider !== 'Remitbee' && beeRate > 0 && myRate > 0) {
      const diff = myRate - beeRate;
      vsRemitbee = diff;
      if (Math.abs(diff) < 0.0001) {
        vsLabel = 'Equal'; vsColor = 'gray';
      } else if (diff > 0) {
        vsLabel = '▲ Better'; vsColor = 'green';
      } else {
        vsLabel = '▼ Lower'; vsColor = 'red';
      }
    }

    return { ...r, vsRemitbee, vsLabel, vsColor };
  });
}
