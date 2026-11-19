import { execFile } from './lib/run.ts';
import { runAnsiblePlaybook, printProfileRecap } from './lib/ansible.ts';
import { createStepTimer } from './lib/timing.ts';
import { createUi } from './lib/ui.ts';
import * as path from 'node:path';
import { platform } from 'node:process';
import { logger } from './lib/logger.ts';
import {
  parseScriptFlags,
  DEFAULT_SCRIPT_FLAGS,
  resolveOutputFlags,
  OUTPUT_FLAG_USAGE,
} from './lib/flags.ts';

const FLAG_USAGE = [
  'Usage: npm run inttest:self -- [options]',
  '',
  'Deploys to this machine over Ansible; takes no throwaway-target flags',
  '(production-shaped path — see inttest/bench:apt for those).',
  '',
  OUTPUT_FLAG_USAGE,
  '  --help',
].join('\n');

if (platform !== 'linux') {
  logger.error('[self] LXC and Ansible control node require Linux. Use WSL2 on Windows; not supported on macOS.');
  process.exit(2);
}

const flags = parseScriptFlags(process.argv.slice(2), DEFAULT_SCRIPT_FLAGS, FLAG_USAGE, { perf: false });
const output = resolveOutputFlags(flags);
const ui = createUi({ prefix: 'self', rich: output.rich });
const appUrl = process.env.APP_URL ?? 'http://127.0.0.1:3000';
const timer = createStepTimer('self', ui);

try {
  ui.log('[self] deploying on localhost');
  await timer.run('ansible-playbook site.yml', async (ctx) => {
    const result = await runAnsiblePlaybook({
      inventoryPath: path.join(process.cwd(), 'inventories', 'self', 'hosts.ini'),
      preview: ctx.preview,
    });
    if (output.profile) {
      printProfileRecap(result.stdout, ui.log);
    }
  }, { previewLines: 8 });

  ui.log('[self] running tests');
  await timer.run('HTTP assertions', async (ctx) => {
    const result = await execFile(
      'npx',
      ['vitest', 'run', 'test/test-http.test.ts'],
      {
        env: { ...process.env, APP_URL: appUrl },
        timeout: 120000,
        preview: ctx.preview,
      },
    );
    if (ctx.preview == null) {
      process.stdout.write(result.stdout);
      process.stderr.write(result.stderr);
    }
    if (result.status !== 0) {
      throw new Error('integration tests failed');
    }
  }, { previewLines: 12 });

  ui.log('[self] PASS');
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  ui.error(`[self] FAILED: ${message}`);
  process.exitCode = 1;
} finally {
  if (output.timing) {
    ui.log(timer.report());
  }
}
