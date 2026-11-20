// CLI wrapper for import-users. Parses command-line arguments and invokes the
// programmatic API in scripts/lib/import-users.ts.
//
// Usage:
//   node scripts/import-users.ts [--dry-run]
//
// Env: MYSQL_HOST/PORT/USER/PASSWORD/DATABASE (MYSQL_PASSWORD required),
//   KC_URL, KC_REALM, KC_ADMIN_USERNAME, KC_ADMIN_PASSWORD

import { readMysqlConfig } from './lib/mysql-config.ts';
import { readKeycloakAdminConfig } from './lib/keycloak-admin.ts';
import { importUsers } from './lib/import-users.ts';
import { logger } from './lib/logger.ts';

function parseArgs(argv: readonly string[]): { dryRun: boolean } {
  let dryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    } else {
      logger.error(`unknown option: ${arg}`);
      printUsage();
      process.exit(2);
    }
  }
  return { dryRun };
}

function printUsage(): void {
  logger.log('Usage: node scripts/import-users.ts [options]');
  logger.log('');
  logger.log('Options:');
  logger.log('  --dry-run    Print the import plan without writing to Keycloak');
  logger.log('  --help       Show this help');
  logger.log('');
  logger.log('Env: MYSQL_HOST/PORT/USER/PASSWORD/DATABASE (MYSQL_PASSWORD required),');
  logger.log('  KC_URL, KC_REALM, KC_ADMIN_USERNAME, KC_ADMIN_PASSWORD');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const mysqlConfig = readMysqlConfig();
  const keycloakConfig = readKeycloakAdminConfig();

  const result = await importUsers(mysqlConfig, keycloakConfig, { dryRun: args.dryRun });

  logger.log(
    `[import] summary: ${result.classified} classified, ${result.withCredentials} with credentials, ${result.disabled} disabled, ${result.created} created, ${result.updated} updated`,
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  logger.error(`[import] FAILED: ${message}`);
  process.exit(1);
});
