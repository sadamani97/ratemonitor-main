import pool from './config/database.js';

(async () => {
  try {
    const [rows] = await pool.execute('SELECT * FROM scrape_logs WHERE provider = "MoneyGram" ORDER BY id DESC LIMIT 5');
    console.log(JSON.stringify(rows, null, 2));
  } catch (err) {
    console.error(err);
  }
  process.exit(0);
})();
