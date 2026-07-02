import { scrapeMoneyGram } from './playwright/moneygram.js';
import { saveRates } from './models/rateModel.js';

(async () => {
  console.log("Starting scrape...");
  const results = await scrapeMoneyGram('CAD', ['INR', 'PHP', 'LKR', 'UAH', 'NPR', 'BDT', 'PKR']);
  console.log("Results:", results);
  
  if (results.length > 0) {
    await saveRates('MoneyGram', results);
    console.log("Saved to database!");
  }
  process.exit(0);
})();
