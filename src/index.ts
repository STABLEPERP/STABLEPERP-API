import express from 'express';
import type { Request, Response } from 'express';
import cors from 'cors';
import morgan from 'morgan';
import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';
import https from 'https';
import cron from 'node-cron';
import { startIndexer } from './indexer';
import { generateOptionChains } from './auto-chain-generator';
import { logger } from './logger';

dotenv.config();

const app = express();
const prisma = new PrismaClient();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Add morgan middleware to log HTTP requests
app.use(morgan('combined', {
  stream: {
    write: (message) => logger.info(message.trim())
  }
}));

// Basic health check
app.get('/', (req: Request, res: Response) => {
  res.send('Stableperp API is running');
});

// GET /api/markets
// Fetch all active markets with their liquidity and current premium
app.get('/api/markets', async (req: Request, res: Response) => {
  const network = (req.query.network as string) || 'devnet';
  try {
    const markets = await prisma.market.findMany({
      where: { network },
      orderBy: { createdAt: 'desc' }
    });
    res.json({ success: true, data: markets });
  } catch (error) {
    logger.error('Error fetching markets:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch markets' });
  }
});

// GET /api/portfolio/:wallet
// Fetch positions and trade history for a specific wallet
app.get('/api/portfolio/:wallet', async (req: Request, res: Response) => {
  const wallet = req.params.wallet as string;
  const network = (req.query.network as string) || 'devnet';
  
  if (!wallet) {
    return res.status(400).json({ success: false, error: 'Wallet address is required' });
  }

  try {
    const positions = await prisma.optionPosition.findMany({
      where: { ownerAddress: wallet, network },
      include: { market: true },
      orderBy: { createdAt: 'desc' }
    });

    const trades = await prisma.tradeHistory.findMany({
      where: { userAddress: wallet, network },
      include: { market: true },
      orderBy: { createdAt: 'desc' }
    });

    res.json({
      success: true,
      data: {
        positions,
        trades
      }
    });
  } catch (error) {
    logger.error('Error fetching portfolio:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch portfolio' });
  }
});

// GET /api/stocks/change
// Fetch daily change percentages for US stocks via Yahoo Finance
app.get('/api/stocks/change', async (req: Request, res: Response) => {
  const symbols = (req.query.symbols as string || '').split(',').filter(Boolean);
  if (symbols.length === 0) return res.json({ success: true, data: {} });

  try {
    const promises = symbols.map(sym => new Promise<{symbol: string, change24h: number, volume24h: number}>((resolve, reject) => {
      https.get(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}`, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (response) => {
        let data = '';
        response.on('data', chunk => data += chunk);
        response.on('end', () => {
          try {
            const json = JSON.parse(data);
            const meta = json?.chart?.result?.[0]?.meta;
            if (meta && meta.regularMarketPrice && meta.previousClose) {
              const change24h = ((meta.regularMarketPrice - meta.previousClose) / meta.previousClose) * 100;
              resolve({ symbol: sym, change24h, volume24h: meta.regularMarketVolume || 0 });
            } else {
              resolve({ symbol: sym, change24h: 0, volume24h: 0 });
            }
          } catch (e) {
            resolve({ symbol: sym, change24h: 0, volume24h: 0 });
          }
        });
      }).on('error', () => resolve({ symbol: sym, change24h: 0, volume24h: 0 }));
    }));

    const results = await Promise.all(promises);
    const dataMap: Record<string, {change24h: number, volume24h: number}> = {};
    results.forEach(r => {
      dataMap[r.symbol] = { change24h: r.change24h, volume24h: r.volume24h };
    });

    res.json({ success: true, data: dataMap });
  } catch (error) {
    logger.error('Error fetching stock changes:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch stock changes' });
  }
});

// Start the server and Indexer
app.listen(PORT, () => {
  logger.info(`🚀 Stableperp API Server running on port ${PORT}`);
  
  // Start the background indexer in the same process
  startIndexer().then(() => {
    logger.info('✅ Background Indexer initialized');
  }).catch(err => {
    logger.error('❌ Failed to start background indexer:', err);
  });

  // Schedule the Auto Option Chain Generator
  const cronSchedule = process.env.CRON_SCHEDULE || '0 0 * * *';
  cron.schedule(cronSchedule, () => {
    logger.info('⏰ Running Scheduled Auto Option Chain Generator...');
    generateOptionChains().catch(err => {
      logger.error('❌ Scheduled Option Chain Generator Failed:', err);
    });
  });
  logger.info(`⏰ Auto Option Chain Generator scheduled with cron: '${cronSchedule}'`);
});
