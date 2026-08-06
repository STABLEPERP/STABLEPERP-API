import express from 'express';
import type { Request, Response } from 'express';
import cors from 'cors';
import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const prisma = new PrismaClient();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Basic health check
app.get('/', (req: Request, res: Response) => {
  res.send('Stableperp API is running');
});

// GET /api/markets
// Fetch all active markets with their liquidity and current premium
app.get('/api/markets', async (req: Request, res: Response) => {
  try {
    const markets = await prisma.market.findMany({
      orderBy: { createdAt: 'desc' }
    });
    res.json({ success: true, data: markets });
  } catch (error) {
    console.error('Error fetching markets:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch markets' });
  }
});

// GET /api/portfolio/:wallet
// Fetch positions and trade history for a specific wallet
app.get('/api/portfolio/:wallet', async (req: Request, res: Response) => {
  const wallet = req.params.wallet as string;
  
  if (!wallet) {
    return res.status(400).json({ success: false, error: 'Wallet address is required' });
  }

  try {
    const positions = await prisma.optionPosition.findMany({
      where: { ownerAddress: wallet },
      include: { market: true },
      orderBy: { createdAt: 'desc' }
    });

    const trades = await prisma.tradeHistory.findMany({
      where: { userAddress: wallet },
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
    console.error('Error fetching portfolio:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch portfolio' });
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`🚀 Stableperp API Server running on port ${PORT}`);
});
