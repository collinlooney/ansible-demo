import { execFileSync } from './lib/run.ts';
import { ensureLxd } from './lib/lxd.ts';
import { logger } from './lib/logger.ts';

try {
  await ensureLxd();
  const info = execFileSync('lxc', ['info'], {});
  logger.log(info.stdout.split('\n').slice(0, 12).join('\n'));
  logger.log('[ensure-lxd] OK');
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  logger.error(`[ensure-lxd] FAILED: ${message}`);
  process.exit(1);
}
