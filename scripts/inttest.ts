import { execFileSync, execOrThrow } from './run.ts';
import {
  ensureLxd,
  launchContainer,
  waitForCloudInit,
  publishPublicKey,
  getContainerIpv4,
  waitForSsh,
  readContainerLogs,
  destroyContainer,
} from './lxd.ts';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { logger } from './logger.ts';
import { TEST_USERS } from './test-users.ts';

interface RunState {
  readonly id: string;
  readonly containerName: string;
  readonly runDir: string;
  readonly keyPath: string;
  readonly inventoryPath: string;
}

function makeRunState(): RunState {
  const id = `${Date.now().toString(36)}-${process.pid}`;
  const runDir = path.join(process.cwd(), '.run', id);
  const keyPath = path.join(runDir, 'id_ed25519');
  const containerName = `node-express-inttest-${id.replace(/\./g, '-')}`.toLowerCase();
  return {
    id,
    containerName,
    runDir,
    keyPath,
    inventoryPath: path.join(runDir, 'hosts.ini'),
  };
}

function renderInventory(ip: string, state: RunState): string {
  const commonArgs = '-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null';
  return `[lxc]
${ip} ansible_host=${ip} ansible_port=22 ansible_user=ubuntu ansible_ssh_private_key_file=${state.keyPath} ansible_ssh_common_args="${commonArgs}"
`;
}

function readEnv(name: string, defaultValue: string): string {
  const value = process.env[name];
  return value == null || value === '' ? defaultValue : value;
}

function randomPassword(): string {
  return randomBytes(18).toString('base64url');
}

async function waitForKeycloakReady(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'unknown';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
      lastError = `readiness status ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    const delay = Math.min(2000, Math.max(0, deadline - Date.now()));
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  throw new Error(`Keycloak not ready within ${timeoutMs}ms: ${lastError}`);
}

interface IdpRunContext {
  readonly keycloakUrl: string;
  readonly bootstrapPassword: string;
  readonly importerPassword: string;
  readonly testPasswordsJson: string;
}

/**
 * Workstation-side scripts (seed/import/rehash assertions) reach the target
 * machine's MySQL exactly the way an operator would against prod: over an SSH
 * local port-forward to 127.0.0.1:3306. MySQL itself stays loopback-bound and
 * remote-root-less — nothing in the deploy is loosened for tests.
 */
async function openMysqlTunnel(state: RunState, ip: string): Promise<{
  process: ChildProcess;
  localPort: number;
}> {
  // Grab a free local port race-free.
  const localPort = await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address == null || typeof address === 'string') {
        server.close();
        reject(new Error('could not allocate local tunnel port'));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
    server.once('error', reject);
  });

  const tunnel = spawn(
    'ssh',
    [
      '-N',
      '-L', `127.0.0.1:${localPort}:127.0.0.1:3306`,
      '-i', state.keyPath,
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'UserKnownHostsFile=/dev/null',
      '-o', 'ExitOnForwardFailure=yes',
      `ubuntu@${ip}`,
    ],
    { stdio: 'ignore' },
  );

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const open = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ host: '127.0.0.1', port: localPort });
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (open) {
      return { process: tunnel, localPort };
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  tunnel.kill();
  throw new Error('MySQL SSH tunnel did not open within 30s');
}

async function main(): Promise<void> {
  const state = makeRunState();
  fs.mkdirSync(state.runDir, { recursive: true });

  let created = false;
  let failed = false;

  try {
    logger.log(`[inttest] run id ${state.id}`);
    logger.log('[inttest] ensuring LXD...');
    ensureLxd();

    logger.log('[inttest] generating SSH key...');
    execOrThrow('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', state.keyPath, '-q']);
    const publicKey = fs.readFileSync(`${state.keyPath}.pub`, 'utf8').trim();

    logger.log(`[inttest] launching container ${state.containerName}`);
    launchContainer(state.containerName);
    created = true;

    logger.log('[inttest] waiting for cloud-init...');
    waitForCloudInit(state.containerName);

    logger.log('[inttest] publishing SSH key...');
    publishPublicKey(state.containerName, publicKey);

    logger.log('[inttest] discovering container IP...');
    const ip = getContainerIpv4(state.containerName);
    logger.log(`[inttest] container IP ${ip}`);

    logger.log('[inttest] waiting for SSH...');
    waitForSsh(ip, state.keyPath);

    logger.log('[inttest] rendering inventory...');
    fs.writeFileSync(state.inventoryPath, renderInventory(ip, state));

    const idpEnabled = readEnv('INTTEST_IDP', '1') !== '0';

    const extraVarValues: Record<string, unknown> = {
      app_backend: 'native',
      app_name: 'node-express-app',
      app_port: 3000,
      app_log_level: readEnv('APP_LOG_LEVEL', 'info'),
    };

    // Per-run IdP stack: MySQL (test datastore) + Keycloak, with generated
    // secrets that never outlive this run.
    let idpContext: IdpRunContext | null = null;
    if (idpEnabled) {
      const importerPassword = randomPassword();
      const keycloakDbPassword = randomPassword();
      const bootstrapPassword = randomPassword();
      const testPasswords: Record<string, string> = {};
      for (const user of TEST_USERS) {
        if (user.password) {
          testPasswords[user.email] = randomPassword();
        }
      }
      Object.assign(extraVarValues, {
        mysql_enabled: true,
        keycloak_enabled: true,
        mysql_databases: [{ name: 'dc' }, { name: 'keycloak' }],
        mysql_users: [
          {
            name: 'importer',
            host: 'localhost',
            password: importerPassword,
            priv: 'dc.*:ALL/keycloak.*:SELECT',
          },
          {
            name: 'keycloak',
            host: 'localhost',
            password: keycloakDbPassword,
            priv: 'keycloak.*:ALL',
          },
        ],
        keycloak_db_password: keycloakDbPassword,
        keycloak_bootstrap_admin_username: 'kcadmin',
        keycloak_bootstrap_admin_password: bootstrapPassword,
        keycloak_after_units: 'network.target mysql.service',
        keycloak_ssl_required: 'none',
      });
      idpContext = {
        keycloakUrl: `http://${ip}:8080`,
        bootstrapPassword,
        importerPassword,
        testPasswordsJson: JSON.stringify(testPasswords),
      };
    }

    const extraVars = JSON.stringify(extraVarValues);

    logger.log('[inttest] deploying with Ansible...');
    execOrThrow('ansible-playbook', [
      '-i', state.inventoryPath,
      path.join(process.cwd(), 'playbooks', 'site.yml'),
      '--extra-vars', extraVars,
    ]);

    const appUrl = `http://${ip}:3000`;
    logger.log(`[inttest] APP_URL=${appUrl}`);

    logger.log('[inttest] running HTTP assertions...');
    const testResult = execFileSync('node', [path.join(process.cwd(), 'scripts', 'test-http-run.ts')], {
      env: { ...process.env, APP_URL: appUrl },
      timeout: 300000,
    });
    process.stdout.write(testResult.stdout);
    process.stderr.write(testResult.stderr);
    if (testResult.status !== 0) {
      throw new Error('integration tests failed');
    }

    if (idpContext != null) {
      // Measured on the workstation repro (Keycloak 26.8.2, fresh schema):
      // cold first boot ~250s (Liquibase DDL dominates), warm restart ~10s.
      // 600s leaves headroom for slower server disks; warm boots, the only
      // case that is real downtime, never come close.
      const readyTimeoutMs = Number(readEnv('KEYCLOAK_READY_TIMEOUT_MS', '600000'));

      logger.log('[inttest] waiting for Keycloak readiness (/health/ready)...');
      await waitForKeycloakReady(`http://${ip}:9000/health/ready`, readyTimeoutMs);

      logger.log('[inttest] opening MySQL SSH tunnel...');
      const tunnel = await openMysqlTunnel(state, ip);
      try {
        const mysqlEnv = {
          MYSQL_HOST: '127.0.0.1',
          MYSQL_PORT: String(tunnel.localPort),
          MYSQL_USER: 'importer',
          MYSQL_PASSWORD: idpContext.importerPassword,
          MYSQL_DATABASE: 'dc',
        };

        logger.log('[inttest] seeding test database...');
        execOrThrow(
          'node',
          [path.join(process.cwd(), 'scripts', 'seed-test-db.ts')],
          { env: { ...process.env, ...mysqlEnv, IMPORT_TEST_PASSWORDS: idpContext.testPasswordsJson } },
        );

        logger.log('[inttest] importing users into Keycloak...');
        execOrThrow(
          'node',
          [path.join(process.cwd(), 'scripts', 'import-users.ts')],
          {
            env: {
              ...process.env,
              ...mysqlEnv,
              KC_URL: idpContext.keycloakUrl,
              KC_ADMIN_USERNAME: 'kcadmin',
              KC_ADMIN_PASSWORD: idpContext.bootstrapPassword,
            },
          },
        );

        logger.log('[inttest] running credential assertions...');
        const credentialResult = execFileSync(
          'node',
          [path.join(process.cwd(), 'scripts', 'test-credentials-run.ts')],
          {
            env: {
              ...process.env,
              ...mysqlEnv,
              KEYCLOAK_URL: idpContext.keycloakUrl,
              IMPORT_TEST_PASSWORDS: idpContext.testPasswordsJson,
            },
            timeout: 300000,
          },
        );
        process.stdout.write(credentialResult.stdout);
        process.stderr.write(credentialResult.stderr);
        if (credentialResult.status !== 0) {
          throw new Error('credential tests failed');
        }
      } finally {
        tunnel.process.kill();
      }
    }

    logger.log('[inttest] PASS');
  } catch (error) {
    failed = true;
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[inttest] FAILED: ${message}`);
    if (created) {
      try {
        logger.error('[inttest] collecting container journal...');
        const logs = readContainerLogs(state.containerName);
        logger.error(logs);
      } catch (logError) {
        const logMessage = logError instanceof Error ? logError.message : String(logError);
        logger.error(`[inttest] diagnostics failed: ${logMessage}`);
      }
    }
    process.exitCode = 1;
  } finally {
    if (created) {
      try {
        logger.log('[inttest] destroying container...');
        destroyContainer(state.containerName);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`[inttest] destroy failed: ${message}`);
        process.exitCode = 1;
      }
    }
    if (!failed) {
      fs.rmSync(state.runDir, { recursive: true, force: true });
    } else {
      logger.error(`[inttest] run artifacts retained at ${state.runDir}`);
    }
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  logger.error(message);
  process.exit(1);
});
