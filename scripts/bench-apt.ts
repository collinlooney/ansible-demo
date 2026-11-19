import { execOrThrow } from './run.ts';
import {
  ensureLxd,
  launchContainer,
  waitForCloudInit,
  publishPublicKey,
  getContainerIpv4,
  waitForSsh,
  configureTargetApt,
  destroyContainer,
} from './lxd.ts';
import { probeAptCache } from './apt-cache.ts';
import { createRunState, renderInventory, generateSshKey } from './target.ts';
import { runAnsiblePlaybook, printProfileRecap, parseTaskTimes, getTaskTime } from './ansible.ts';
import {
  parsePerfFlags,
  DEFAULT_PERF_FLAGS,
  STOCK_DPKG_OPTIONS,
  UNSAFE_IO_DPKG_OPTIONS,
  dpkgOptionArgs,
} from './flags.ts';
import { createStepTimer, formatDuration } from './timing.ts';
import { logger } from './logger.ts';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Ansible-vs-manual benchmark for the deployment roles' apt tasks.
 *
 * Two fresh ubuntu:26.04 containers, identical starting state:
 *  - "manual": the raw `apt-get` commands an operator would type, via lxc exec;
 *  - "ansible": the real roles, filtered to the `apt`-tagged tasks
 *    (ansible-playbook --tags apt), so the compared task bodies are the ones
 *    the inttest actually deploys with.
 *
 * The delta is what Ansible's per-task machinery costs (SSH + module +
 * python-apt) over raw apt on the same boxes.
 *
 * Takes the same throwaway-target flags as inttest (--unsafe-io, --tmpfs);
 * both sides always run with identical dpkg options.
 */
const FLAG_USAGE = [
  'Usage: npm run bench:apt -- [options]',
  '',
  'Throwaway-target optimizations (mirrored on both sides of the comparison):',
  '  --unsafe-io / --no-unsafe-io  dpkg --force-unsafe-io during apt installs (default: on)',
  '  --tmpfs / --no-tmpfs          back the containers rootfs with tmpfs (default: off)',
  '  --apt-cache / --no-apt-cache  use the local apt cache if one answers (default: on;',
  '                                use --no-apt-cache to measure raw mirror behavior)',
  '  --help',
].join('\n');
interface AptOp {
  readonly label: string;
  /** Task name in the roles (tagged `apt`), as profile_tasks reports it. */
  readonly taskName: string;
  /** Raw apt-get arguments an operator would type. */
  readonly aptArgs: readonly string[];
}

// Both sides get identical dpkg options (flag-selected, mirroring what the
// inttest deploys with) — the delta stays "what Ansible costs", never
// "what --force-unsafe-io costs" (that A/B lives in docs/perf.md).
function buildAptOps(dpkgOptions: string): readonly AptOp[] {
  return [
    {
      label: 'refresh apt cache',
      taskName: 'Update apt cache',
      aptArgs: ['update'],
    },
    {
      label: 'install ca-certificates curl',
      taskName: 'Install base packages',
      aptArgs: ['install', '-y', ...dpkgOptionArgs(dpkgOptions), 'ca-certificates', 'curl'],
    },
    {
      label: 'install nodejs npm (--no-install-recommends)',
      taskName: 'Install Node.js and npm from Ubuntu packages',
      aptArgs: ['install', '-y', '--no-install-recommends', ...dpkgOptionArgs(dpkgOptions), 'nodejs', 'npm'],
    },
    {
      label: 'install mysql-server python3-pymysql',
      taskName: 'Install MySQL server and Python driver',
      aptArgs: ['install', '-y', ...dpkgOptionArgs(dpkgOptions), 'mysql-server', 'python3-pymysql'],
    },
    {
      label: 'install openjdk-21-jre-headless',
      taskName: 'Install OpenJDK 21 runtime',
      aptArgs: ['install', '-y', ...dpkgOptionArgs(dpkgOptions), 'openjdk-21-jre-headless'],
    },
  ];
}

interface ManualResult {
  readonly ms: number;
  /** apt's own "Need to get ... / Fetched ... / After this operation ..." lines. */
  readonly summary: readonly string[];
}

function runManualOp(containerName: string, op: AptOp): ManualResult {
  const started = process.hrtime.bigint();
  const result = execOrThrow(
    'lxc',
    ['exec', containerName, '--', 'env', 'DEBIAN_FRONTEND=noninteractive', 'apt-get', ...op.aptArgs],
    { timeout: 600000 },
  );
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  const summary = result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^(Need to get|After this operation|Fetched)/.test(line));
  return { ms, summary };
}

function writeBenchPlaybook(stateRunDir: string): string {
  // The real roles, restricted to their apt tasks via --tags apt at the CLI.
  const playbook = `---
- name: Benchmark the deployment roles' apt tasks
  hosts: all
  become: true
  gather_facts: false
  roles:
    - common
    - node_runtime
    - mysql
    - keycloak
`;
  const playbookPath = path.join(stateRunDir, 'bench-site.yml');
  fs.writeFileSync(playbookPath, playbook);
  return playbookPath;
}

function printComparison(
  ops: readonly AptOp[],
  taskTimes: Map<string, number>,
  manual: Map<string, ManualResult>,
): void {
  const labelWidth = Math.max(...ops.map((op) => op.label.length));
  logger.log(`[bench] ${'operation'.padEnd(labelWidth)}  ${'ansible'.padStart(9)}  ${'manual'.padStart(9)}  ${'delta'.padStart(9)}`);
  let ansibleTotal = 0;
  let manualTotal = 0;
  for (const op of ops) {
    const ansibleMs = getTaskTime(taskTimes, op.taskName);
    const manualMs = manual.get(op.taskName)?.ms;
    const ansibleCell = ansibleMs == null ? 'n/a' : formatDuration(ansibleMs);
    const manualCell = manualMs == null ? 'n/a' : formatDuration(manualMs);
    let deltaCell = 'n/a';
    if (ansibleMs != null && manualMs != null) {
      const delta = ansibleMs - manualMs;
      deltaCell = `${delta >= 0 ? '+' : '-'}${formatDuration(Math.abs(delta))}`;
      ansibleTotal += ansibleMs;
      manualTotal += manualMs;
    }
    logger.log(
      `[bench] ${op.label.padEnd(labelWidth)}  ${ansibleCell.padStart(9)}  ${manualCell.padStart(9)}  ${deltaCell.padStart(9)}`,
    );
  }
  logger.log(
    `[bench] ${'task total'.padEnd(labelWidth)}  ${formatDuration(ansibleTotal).padStart(9)}  ${formatDuration(manualTotal).padStart(9)}`,
  );
  for (const op of ops) {
    const summary = manual.get(op.taskName)?.summary ?? [];
    if (summary.length > 0) {
      logger.log(`[bench]   ${op.label}: ${summary.join(' | ')}`);
    }
  }
}

async function main(): Promise<void> {
  const flags = parsePerfFlags(process.argv.slice(2), DEFAULT_PERF_FLAGS, FLAG_USAGE);
  const dpkgOptions = flags.unsafeIo ? UNSAFE_IO_DPKG_OPTIONS : STOCK_DPKG_OPTIONS;
  const aptOps = buildAptOps(dpkgOptions);
  const state = createRunState('node-express-bench');
  fs.mkdirSync(state.runDir, { recursive: true });
  const timer = createStepTimer('bench');
  const manualName = `${state.containerName}-manual`;
  const ansibleName = `${state.containerName}-ansible`;

  let manualCreated = false;
  let ansibleCreated = false;
  let failed = false;

  try {
    logger.log(`[bench] run id ${state.id}`);
    logger.log(`[bench] flags: unsafe-io=${flags.unsafeIo ? 'on' : 'off'} tmpfs=${flags.tmpfs ? 'on' : 'off'} (dpkg: ${dpkgOptions})`);

    await timer.run('ensure LXD', () => ensureLxd());

    const aptCacheUrl = flags.aptCache
      ? await timer.run('probe apt cache', () => probeAptCache())
      : null;
    logger.log(
      `[bench] apt cache: ${aptCacheUrl ?? (flags.aptCache ? 'unavailable, mirrors direct' : 'disabled by flag')}`,
    );

    const manualTimes = new Map<string, ManualResult>();

    await timer.run(`launch manual container ${manualName}`, () => {
      launchContainer(manualName, { tmpfs: flags.tmpfs });
    });
    manualCreated = true;
    await timer.run('wait for cloud-init (manual)', () => waitForCloudInit(manualName));
    await timer.run('configure target apt (manual)', () => configureTargetApt(manualName, aptCacheUrl));

    logger.log('[bench] phase 1/2: raw apt-get via lxc exec');
    for (const op of aptOps) {
      const result = await timer.run(`manual: ${op.label}`, () => runManualOp(manualName, op));
      manualTimes.set(op.taskName, result);
    }

    const publicKey = await timer.run('generate SSH key', () => generateSshKey(state));
    await timer.run(`launch ansible container ${ansibleName}`, () => {
      launchContainer(ansibleName, { tmpfs: flags.tmpfs });
    });
    ansibleCreated = true;
    await timer.run('wait for cloud-init (ansible)', () => waitForCloudInit(ansibleName));
    await timer.run('configure target apt (ansible)', () => configureTargetApt(ansibleName, aptCacheUrl));
    await timer.run('publish SSH key', () => publishPublicKey(ansibleName, publicKey));
    const ip = await timer.run('discover container IP', () => getContainerIpv4(ansibleName));
    await timer.run('wait for SSH', () => waitForSsh(ip, state.keyPath));
    await timer.run('render inventory', () => {
      fs.writeFileSync(state.inventoryPath, renderInventory(ip, state));
    });
    const playbookPath = writeBenchPlaybook(state.runDir);

    logger.log('[bench] phase 2/2: the same operations through ansible.builtin.apt');
    const ansibleResult = await timer.run('ansible-playbook --tags apt', () =>
      runAnsiblePlaybook({
        inventoryPath: state.inventoryPath,
        playbookPath,
        extraVars: JSON.stringify({ apt_dpkg_options: dpkgOptions }),
        extraArgs: ['--tags', 'apt'],
        logPath: path.join(state.runDir, 'ansible.log'),
      }));

    const taskTimes = parseTaskTimes(ansibleResult.stdout);
    printProfileRecap(ansibleResult.stdout);
    printComparison(aptOps, taskTimes, manualTimes);

    const wallMs = timer.records.find((record) => record.name.startsWith('ansible-playbook'))?.ms ?? 0;
    const taskSumMs = [...taskTimes.values()].reduce((sum, ms) => sum + ms, 0);
    logger.log(
      `[bench] ansible wall ${formatDuration(wallMs)} vs task sum ${formatDuration(taskSumMs)} ` +
        `=> connection/module overhead ${formatDuration(Math.max(0, wallMs - taskSumMs))}`,
    );
    logger.log('[bench] PASS');
  } catch (error) {
    failed = true;
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[bench] FAILED: ${message}`);
    process.exitCode = 1;
  } finally {
    if (manualCreated) {
      try {
        await timer.run('destroy manual container', () => destroyContainer(manualName));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`[bench] destroy manual failed: ${message}`);
        process.exitCode = 1;
      }
    }
    if (ansibleCreated) {
      try {
        await timer.run('destroy ansible container', () => destroyContainer(ansibleName));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`[bench] destroy ansible failed: ${message}`);
        process.exitCode = 1;
      }
    }
    logger.log(timer.report());
    if (!failed) {
      fs.rmSync(state.runDir, { recursive: true, force: true });
    } else {
      logger.error(`[bench] run artifacts retained at ${state.runDir}`);
    }
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  logger.error(message);
  process.exit(1);
});
