import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import ratesRoutes from './routes/rates.routes.js';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: '*' }));
app.use(express.json());

// Primary API — provider rates with VS Remitbee comparison
app.use('/api/rates', ratesRoutes);

// Export for Netlify serverless functions
export default app;

if (!process.env.NETLIFY) {
  app.listen(PORT, () => console.log(`Rate Monitor backend running on port ${PORT}`));
}

process.on('uncaughtException', err => console.error('Uncaught exception:', err));
