// CLI wrapper for seed-test-db. Parses command-line arguments and invokes the
// programmatic API in scripts/lib/seed-test-db.ts.
//
// Usage:
//   node scripts/seed-test-db.ts --count 20 --extra-users extra-users.json
//
// Env: MYSQL_HOST/PORT/USER/PASSWORD/DATABASE (MYSQL_PASSWORD required)

import { readMysqlConfig, type MysqlConfig } from './lib/mysql-config.ts';
import { seedTestDb, type ExtraUserSpec } from './lib/seed-test-db.ts';
import { logger } from './lib/logger.ts';
import * as fs from 'node:fs';

interface CliArgs {
  count?: number;
  extraUsers?: string;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--count') {
      args.count = Number(argv[++i]);
    } else if (arg.startsWith('--count=')) {
      args.count = Number(arg.slice('--count='.length));
    } else if (arg === '--extra-users') {
      args.extraUsers = argv[++i];
    } else if (arg.startsWith('--extra-users=')) {
      args.extraUsers = arg.slice('--extra-users='.length);
    } else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    } else {
      logger.error(`unknown option: ${arg}`);
      printUsage();
      process.exit(2);
    }
  }
  return args;
}

function printUsage(): void {
  logger.log('Usage: node scripts/seed-test-db.ts [options]');
  logger.log('');
  logger.log('Options:');
  logger.log('  --count N              Number of generated test users (default: 10)');
  logger.log('  --extra-users PATH     JSON file with additional specific users');
  logger.log('  --help                 Show this help');
  logger.log('');
  logger.log('Env: MYSQL_HOST/PORT/USER/PASSWORD/DATABASE (MYSQL_PASSWORD required)');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  let extraUsers: readonly ExtraUserSpec[] = [];
  if (args.extraUsers != null) {
    const raw = fs.readFileSync(args.extraUsers, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error(`--extra-users file must contain a JSON array`);
    }
    extraUsers = parsed;
  }

  const config = readMysqlConfig();
  const result = await seedTestDb(config, { count: args.count, extraUsers });

  logger.log(
    `[seed] done: ${result.adminRoles} roles, ${result.usersCreated} users, ${result.bcryptHashed} bcrypt-hashed`,
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  logger.error(`[seed] FAILED: ${message}`);
  process.exit(1);
});
