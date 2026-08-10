import { Connection, PublicKey } from '@solana/web3.js';
import { PrismaClient } from '@prisma/client';
import { Program, AnchorProvider, Idl, EventParser, BorshCoder } from '@coral-xyz/anchor';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from './logger';

dotenv.config();

const prisma = new PrismaClient();

// Use Helius or custom RPC in SOLANA_RPC_URL to avoid rate limits
const RPC_URL_DEVNET = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
const PROGRAM_ID_DEVNET = process.env.STABLEPERP_PROGRAM_ID || '';

const RPC_URL_MAINNET = process.env.SOLANA_RPC_URL_MAINNET || 'https://api.mainnet-beta.solana.com';
const PROGRAM_ID_MAINNET = process.env.STABLEPERP_PROGRAM_ID_MAINNET || '';

if (!PROGRAM_ID_DEVNET) {
  logger.error('❌ STABLEPERP_PROGRAM_ID is not set in .env');
  process.exit(1);
}

const connectionDevnet = new Connection(RPC_URL_DEVNET, 'confirmed');
const programPublicKeyDevnet = new PublicKey(PROGRAM_ID_DEVNET);

let connectionMainnet: Connection | null = null;
let programPublicKeyMainnet: PublicKey | null = null;

if (PROGRAM_ID_MAINNET && PROGRAM_ID_MAINNET.length >= 32) {
  connectionMainnet = new Connection(RPC_URL_MAINNET, 'confirmed');
  try {
    programPublicKeyMainnet = new PublicKey(PROGRAM_ID_MAINNET);
  } catch (e) {
    logger.warn('⚠️ Invalid Mainnet Program ID, mainnet indexer will not run.');
  }
}

logger.info(`🔌 Connecting to Devnet RPC at ${RPC_URL_DEVNET}`);
logger.info(`📡 Listening for Devnet events on Program: ${PROGRAM_ID_DEVNET}`);
if (connectionMainnet && programPublicKeyMainnet) {
  logger.info(`🔌 Connecting to Mainnet RPC at ${RPC_URL_MAINNET}`);
  logger.info(`📡 Listening for Mainnet events on Program: ${PROGRAM_ID_MAINNET}`);
}

// Load IDL
const idlPath = path.join(__dirname, 'idl', 'stableperp.json');
let idl: Idl;
try {
  idl = JSON.parse(fs.readFileSync(idlPath, 'utf8'));
} catch (e) {
  logger.error('❌ Failed to load IDL at src/idl/stableperp.json. Did you copy it?');
  process.exit(1);
}

const coder = new BorshCoder(idl);

function setupListener(conn: Connection, progId: PublicKey, network: string, progIdStr: string) {
  conn.onLogs(
    progId,
    async (logs, ctx) => {
      if (logs.err) {
        return; // Transaction failed, ignore
      }

      logger.info(`\n🔔 New Transaction Detected (${network}): ${logs.signature}`);
      
      try {
        // Adding a slight delay can sometimes help if the RPC is lagging behind the log notification
        await new Promise(resolve => setTimeout(resolve, 2000));

        const tx = await conn.getParsedTransaction(logs.signature, {
          maxSupportedTransactionVersion: 0,
        });

        if (!tx) {
          logger.warn(`⚠️ Transaction ${logs.signature} not found or not confirmed yet.`);
          return;
        }

        const signer = tx.transaction.message.accountKeys.find((k) => k.signer)?.pubkey.toBase58() || 'Unknown';
        
        // Find our program's instructions
        const instructions = tx.transaction.message.instructions;
        for (const ix of instructions) {
          if (!('programId' in ix)) continue;
          if (ix.programId.toBase58() !== progIdStr) continue;

          // Parse instruction using Anchor coder
          if (!('data' in ix)) continue; // Must be partially compiled instruction with data
          const decoded = coder.instruction.decode(ix.data, 'base58');
          
          if (!decoded) continue;

          logger.info(`📜 Decoded Instruction: ${decoded.name}`);
          
          let action = '';
          let quantity = 0;
          let price = 0;

          if (decoded.name === 'writeOption') {
            action = 'WRITE';
            quantity = (decoded.data as any).qty.toNumber();
            price = (decoded.data as any).premiumAsk.toNumber(); // Stored in IDL as u64 (might be basis points or raw token amount)
          } else if (decoded.name === 'buyOption') {
            action = 'BUY';
            quantity = (decoded.data as any).qty.toNumber();
            // Price is not in buyOption args directly (it's taken from market), we'll default to 0 or fetch from market
          }

          if (action) {
            // Find or create a dummy market if none exists (In production, the market account is passed in instruction)
            let market = await prisma.market.findFirst({ where: { network } });
            if (!market) {
              market = await prisma.market.create({
                data: {
                  address: PublicKey.unique().toBase58(), // Dummy address
                  symbol: 'SOL/USDC',
                  strike: 100,
                  expiry: new Date(Date.now() + 86400000), // +1 day
                  totalLiquidity: 1000,
                  premiumAsk: price > 0 ? price : 5.5,
                  optionMint: PublicKey.unique().toBase58(),
                  underlyingMint: PublicKey.unique().toBase58(),
                  quoteMint: PublicKey.unique().toBase58(),
                  network
                } as any
              });
              logger.info(`Created mock market for SOL/USDC inside indexer (${network})`);
            }

            // Check if already recorded
            const existingTx = await prisma.tradeHistory.findUnique({
              where: { txSignature: logs.signature }
            });

            if (!existingTx) {
              await prisma.tradeHistory.create({
                data: {
                  userAddress: signer,
                  marketId: market.id,
                  action,
                  quantity,
                  price: price > 0 ? price : (market.premiumAsk || 0),
                  txSignature: logs.signature,
                  network
                }
              });
              logger.info(`✅ Logged ${action} for ${signer} in tx ${logs.signature} (${network})`);
            }
          }
        }
      } catch (err) {
        logger.error(`❌ Error parsing transaction ${logs.signature} (${network}):`, err);
      }
    },
    'confirmed'
  );
}

export async function startIndexer() {
  setupListener(connectionDevnet, programPublicKeyDevnet, 'devnet', PROGRAM_ID_DEVNET);
  
  if (connectionMainnet && programPublicKeyMainnet) {
    setupListener(connectionMainnet, programPublicKeyMainnet, 'mainnet', PROGRAM_ID_MAINNET);
  }
}
