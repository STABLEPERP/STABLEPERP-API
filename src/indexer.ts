import { Connection, PublicKey } from '@solana/web3.js';
import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';

dotenv.config();

const prisma = new PrismaClient();
const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
const PROGRAM_ID = process.env.STABLEPERP_PROGRAM_ID || '';

if (!PROGRAM_ID) {
  console.error('❌ STABLEPERP_PROGRAM_ID is not set in .env');
  process.exit(1);
}

const connection = new Connection(RPC_URL, 'confirmed');
const programPublicKey = new PublicKey(PROGRAM_ID);

console.log(`🔌 Connecting to Solana RPC at ${RPC_URL}`);
console.log(`📡 Listening for events on Program: ${PROGRAM_ID}`);

async function startIndexer() {
  // Subscribe to logs emitted by the Stableperp Program
  connection.onLogs(
    programPublicKey,
    async (logs, ctx) => {
      if (logs.err) {
        // Transaction failed, ignore
        return;
      }

      console.log(`\n🔔 New Transaction Detected: ${logs.signature}`);
      
      try {
        // Fetch the parsed transaction details
        // Note: Free RPCs might rate-limit this, so in production use a dedicated RPC
        const tx = await connection.getParsedTransaction(logs.signature, {
          maxSupportedTransactionVersion: 0,
        });

        if (!tx) return;

        // In a complete implementation, you would decode the instruction data using the Anchor IDL
        // Here we detect standard interactions and log them to the database
        const signer = tx.transaction.message.accountKeys.find((k) => k.signer)?.pubkey.toBase58() || 'Unknown';
        
        console.log(`👤 Signer: ${signer}`);
        
        // Mock recording a trade history event to Supabase/Prisma
        // This will create a generic trade history record for demonstration
        
        // Find or create a dummy market if none exists
        let market = await prisma.market.findFirst();
        if (!market) {
          market = await prisma.market.create({
            data: {
              address: PublicKey.unique().toBase58(),
              symbol: 'SOL/USDC',
              strike: 100,
              expiry: new Date(Date.now() + 86400000), // +1 day
              totalLiquidity: 1000,
              premiumAsk: 5.5
            }
          });
        }

        // Only record if this transaction hasn't been recorded yet
        const existingTx = await prisma.tradeHistory.findUnique({
          where: { txSignature: logs.signature }
        });

        if (!existingTx) {
          await prisma.tradeHistory.create({
            data: {
              userAddress: signer,
              marketId: market.id,
              action: 'WRITE_OR_BUY', // This would be parsed from IDL instructions
              quantity: 1,
              price: 5.5,
              txSignature: logs.signature,
            }
          });
          console.log(`✅ Recorded transaction ${logs.signature} to database`);
        }

      } catch (error) {
        console.error(`❌ Failed to process transaction ${logs.signature}:`, error);
      }
    },
    'confirmed'
  );
}

startIndexer().catch(console.error);
