import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { PublicKey, Keypair, Connection } from "@solana/web3.js";
import { PrismaClient } from "@prisma/client";
import fs from 'fs';
import path from 'path';
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotent, createMint } from '@solana/spl-token';
import { logger } from './logger';

const prisma = new PrismaClient();

// In a real production scenario, base prices should be dynamically fetched from Pyth Network.
const stocks = [
  { symbol: 'TSLA', basePrice: 200, isSynthetic: true, type: 'us_stocks' },
  { symbol: 'AAPL', basePrice: 150, isSynthetic: true, type: 'us_stocks' },
  { symbol: 'NVDA', basePrice: 900, isSynthetic: true, type: 'us_stocks' },
  { symbol: 'MSFT', basePrice: 400, isSynthetic: true, type: 'us_stocks' },
  { symbol: 'AMZN', basePrice: 180, isSynthetic: true, type: 'us_stocks' },
  { symbol: 'GOOGL', basePrice: 160, isSynthetic: true, type: 'us_stocks' },
  { symbol: 'META', basePrice: 480, isSynthetic: true, type: 'us_stocks' },
  { symbol: 'NFLX', basePrice: 600, isSynthetic: true, type: 'us_stocks' },
  { symbol: 'AMD', basePrice: 160, isSynthetic: true, type: 'us_stocks' },
  { symbol: 'COIN', basePrice: 200, isSynthetic: true, type: 'us_stocks' },
  { symbol: 'SPY', basePrice: 510, isSynthetic: true, type: 'us_stocks' },
  { symbol: 'QQQ', basePrice: 440, isSynthetic: true, type: 'us_stocks' },
  { symbol: 'GME', basePrice: 20, isSynthetic: true, type: 'us_stocks' },
  { symbol: 'BTC', basePrice: 65000, isSynthetic: false, type: 'crypto' },
  { symbol: 'SOL', basePrice: 150, isSynthetic: false, type: 'crypto' },
  { symbol: 'ETH', basePrice: 3500, isSynthetic: false, type: 'crypto' },
  { symbol: 'JUP', basePrice: 1.00, isSynthetic: false, type: 'crypto' },
  { symbol: 'JTO', basePrice: 2.50, isSynthetic: false, type: 'crypto' },
  { symbol: 'PYTH', basePrice: 0.30, isSynthetic: false, type: 'crypto' },
  { symbol: 'WIF', basePrice: 1.50, isSynthetic: false, type: 'crypto' },
  { symbol: 'BONK', basePrice: 0.00002, isSynthetic: false, type: 'crypto' },
  { symbol: 'RAY', basePrice: 2.00, isSynthetic: false, type: 'crypto' },
  { symbol: 'RENDER', basePrice: 6.00, isSynthetic: false, type: 'crypto' },
];

export async function generateOptionChains() {
  const envMode = process.env.AUTO_CHAIN_MODE || 'devnet';
  
  if (envMode === 'off') {
    logger.info('🛑 Auto Option Chain Generator is OFF');
    return;
  }

  const modes = envMode === 'both' ? ['devnet', 'mainnet'] : [envMode];
  logger.info(`🚀 Starting Auto Option Chain Generator for [${modes.join(', ').toUpperCase()}]`);

  const keypairPath = path.resolve(process.env.HOME || '', '.config/solana/id.json');
  if (!fs.existsSync(keypairPath)) {
    logger.error(`❌ Keypair not found at ${keypairPath}`);
    return;
  }

  const secretKey = Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, 'utf8')));
  const payer = Keypair.fromSecretKey(secretKey);

  for (const mode of modes) {
    logger.info(`\n🌐 Processing Network: ${mode.toUpperCase()}...`);
    
    const rpcUrl = mode === 'mainnet' 
      ? process.env.SOLANA_RPC_URL_MAINNET 
      : process.env.SOLANA_RPC_URL;
      
    if (!rpcUrl) {
      logger.error(`❌ RPC URL not found in env for ${mode}`);
      continue;
    }

    const connection = new Connection(rpcUrl, 'confirmed');
    const wallet = new anchor.Wallet(payer);
    const provider = new anchor.AnchorProvider(connection, wallet, { commitment: 'confirmed' });
    anchor.setProvider(provider);

    const idlPath = path.resolve(__dirname, '../../stableperp-web/src/idl/stableperp.json');
    const idl = JSON.parse(fs.readFileSync(idlPath, 'utf8'));
    
    const programIdStr = mode === 'mainnet' 
      ? process.env.STABLEPERP_PROGRAM_ID_MAINNET 
      : process.env.STABLEPERP_PROGRAM_ID;

    if (programIdStr) {
        idl.address = programIdStr;
    }

    const program = new Program(idl, provider);
    
    let quoteMintStr = mode === 'mainnet' 
      ? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" 
      : null; 
      
    let quoteMint: PublicKey;
    if (quoteMintStr) {
        quoteMint = new PublicKey(quoteMintStr);
    } else {
        quoteMint = await createMint(connection, payer, payer.publicKey, null, 6);
        logger.info(`✅ Created Mock Quote Mint (USDC): ${quoteMint.toBase58()}`);
    }

    const [factoryPda] = PublicKey.findProgramAddressSync([Buffer.from('factory_config')], program.programId);
    const [creatorPda] = PublicKey.findProgramAddressSync([Buffer.from('market_creator'), payer.publicKey.toBuffer()], program.programId);

    const expiryDays = [7, 14, 30];
    const strikeMultipliers = [0.95, 0.975, 1.0, 1.025, 1.05]; 
    const networkTag = mode === 'mainnet' ? 'mainnet-beta' : 'devnet';

    for (const stock of stocks) {
      logger.info(`\n📈 Processing Option Chain for ${stock.symbol}...`);
      
      const underlyingMint = await createMint(connection, payer, payer.publicKey, null, 6);
      
      for (const days of expiryDays) {
        const expiryTs = Math.floor(Date.now() / 1000) + days * 24 * 60 * 60;
        
        for (const mult of strikeMultipliers) {
          const strikePriceRaw = stock.basePrice * mult;
          const strike = Math.round(strikePriceRaw * 1e6);
          
          const marketSymbol = stock.isSynthetic ? `${stock.symbol}x/USDC` : `${stock.symbol}/USDC`;

          const existingMarket = await prisma.market.findFirst({
              where: {
                  symbol: marketSymbol,
                  strike: strikePriceRaw,
                  network: networkTag
              }
          });

          if (existingMarket) {
              logger.info(`   ⏩ Skip: ${stock.symbol} Strike $${strikePriceRaw} Expiry ${days}d (Already Exists)`);
              continue;
          }

          const strikeBuffer = Buffer.alloc(8);
          strikeBuffer.writeBigUInt64LE(BigInt(strike));
          const expiryBuffer = Buffer.alloc(8);
          expiryBuffer.writeBigInt64LE(BigInt(expiryTs));

          const [marketPda] = PublicKey.findProgramAddressSync(
            [Buffer.from('market'), underlyingMint.toBuffer(), quoteMint.toBuffer(), strikeBuffer, expiryBuffer],
            program.programId
          );

          const [optionMintPda] = PublicKey.findProgramAddressSync([Buffer.from('option_mint'), marketPda.toBuffer()], program.programId);

          try {
            await createAssociatedTokenAccountIdempotent(connection, payer, underlyingMint, marketPda, { commitment: 'confirmed' }, undefined, undefined, true);
            await createAssociatedTokenAccountIdempotent(connection, payer, quoteMint, marketPda, { commitment: 'confirmed' }, undefined, undefined, true);

            const payoutCap = new BN(500000 * 1e6);

            const tx = await program.methods.initMarket(
              new BN(strike),
              new BN(expiryTs),
              new BN(86400),
              stock.isSynthetic,
              payoutCap
            ).accounts({
              market: marketPda,
              marketCreator: creatorPda,
              factoryConfig: factoryPda,
              creator: payer.publicKey,
              underlyingMint: underlyingMint,
              quoteMint: quoteMint,
              optionMint: optionMintPda,
              collateralVault: getAssociatedTokenAddressSync(underlyingMint, marketPda, true),
              quoteVault: getAssociatedTokenAddressSync(quoteMint, marketPda, true),
              systemProgram: anchor.web3.SystemProgram.programId,
              tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
              associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
            }).rpc();

            logger.info(`   ✅ Created: ${stock.symbol} Strike $${strikePriceRaw} Expiry ${days}d -> ${marketPda.toBase58()}`);

            await prisma.market.create({
              data: {
                address: marketPda.toBase58(),
                symbol: marketSymbol,
                strike: strikePriceRaw,
                expiry: new Date(expiryTs * 1000),
                isSynthetic: stock.isSynthetic,
                underlyingMint: underlyingMint.toBase58(),
                quoteMint: quoteMint.toBase58(),
                optionMint: optionMintPda.toBase58(),
                type: stock.type,
                premiumAsk: stock.basePrice * 0.05, 
                totalLiquidity: 0,
                network: networkTag,
              }
            });

          } catch (e) {
            logger.error(`   ❌ Failed to create ${stock.symbol} Strike $${strikePriceRaw}: ${e}`);
          }
        }
      }
    }
  }
  logger.info(`🎉 Auto Option Chain Generator Completed for [${envMode.toUpperCase()}]`);
}
