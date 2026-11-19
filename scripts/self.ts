import { execFileSync } from './run.ts';
import { runAnsiblePlaybook, printProfileRecap } from './ansible.ts';
import { createStepTimer } from './timing.ts';
import * as path from 'node:path';
import { platform } from 'node:process';
import { logger } from './logger.ts';

if (platform !== 'linux') {
  logger.error('[self] LXC and Ansible control node require Linux. Use WSL2 on Windows; not supported on macOS.');
  process.exit(2);
}

const appUrl = process.env.APP_URL ?? 'http://127.0.0.1:3000';
const timer = createStepTimer('self');

try {
  logger.log('[self] deploying on localhost');
  await timer.run('ansible-playbook site.yml', () => {
    const result = runAnsiblePlaybook({
      inventoryPath: path.join(process.cwd(), 'inventories', 'self', 'hosts.ini'),
    });
    printProfileRecap(result.stdout);
  });

  logger.log('[self] running tests');
  await timer.run('HTTP assertions', () => {
    const result = execFileSync('node', [path.join(process.cwd(), 'scripts', 'test-http-run.ts')], {
      env: { ...process.env, APP_URL: appUrl },
      timeout: 120000,
    });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    if (result.status !== 0) {
      throw new Error('integration tests failed');
    }
  });

  logger.log('[self] PASS');
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  logger.error(`[self] FAILED: ${message}`);
  process.exitCode = 1;
} finally {
  logger.log(timer.report());
}
