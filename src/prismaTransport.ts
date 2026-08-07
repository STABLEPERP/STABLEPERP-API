import Transport from 'winston-transport';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export class PrismaTransport extends Transport {
  constructor(opts?: any) {
    super(opts);
  }

  log(info: any, callback: () => void) {
    setImmediate(() => {
      this.emit('logged', info);
    });

    const env = process.env.NODE_ENV === 'production' ? 'prod' : 'dev';
    
    const { level, message, timestamp, ...metadata } = info;

    // Save to DB (fire and forget to not block logging)
    prisma.systemLog.create({
      data: {
        level,
        message,
        environment: env,
        metadata: Object.keys(metadata).length > 0 ? metadata : null,
      }
    }).catch(err => {
      // Don't crash the app if logging to DB fails, just output to console
      console.error("Failed to log to Prisma:", err);
    });

    callback();
  }
}
