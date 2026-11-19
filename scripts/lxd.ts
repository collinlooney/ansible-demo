import { execFileSync, execOrThrow } from './run.ts';
import { logger } from './logger.ts';

export interface LxdInstance {
  readonly name: string;
  readonly state?: {
    readonly network?: Record<string, { readonly addresses?: ReadonlyArray<{ readonly family: string; readonly address: string; readonly scope: string }> }>;
  };
}

export function ensureLxd(): void {
  const init = execFileSync('sudo', ['lxd', 'init', '--minimal'], { timeout: 60000 });
  if (init.status !== 0 && !init.stderr.includes('has already been initialized') && !init.stdout.includes('has already been initialized')) {
    logger.error(init.stderr);
  }
  const pools = execFileSync('lxc', ['storage', 'list', '--format', 'csv'], {});
  if (pools.status !== 0 || !pools.stdout.includes('default')) {
    throw new Error(`LXD storage is not initialized.\n${pools.stdout}\n${pools.stderr}`);
  }
  const networks = execFileSync('lxc', ['network', 'list', '--format', 'csv'], {});
  if (networks.status !== 0 || !networks.stdout.includes('lxdbr0')) {
    throw new Error(`LXD lxdbr0 network is not initialized.\n${networks.stdout}\n${networks.stderr}`);
  }
}

const TMPFS_POOL = 'tmpfs';
const TMPFS_MOUNT_POINT = '/var/tmp/ansible-demo-tmpfs';

/**
 * Prep the optional tmpfs backing for throwaway targets (flag: --tmpfs).
 * Mounts a ramdisk on the host and creates a LXD dir pool on it, so the
 * container's whole rootfs lives in RAM: dpkg unpack and MySQL/Liquibase
 * fsyncs become memory operations instead of disk syncs (docs/perf.md).
 * Default tmpfs size is the kernel's (half of RAM); set LXC_TMPFS_SIZE
 * (e.g. "4G") to cap it. Idempotent — the mount and pool are left in place
 * after runs for reuse and cost no RAM while idle.
 */
export function ensureTmpfsPool(): void {
  const mount = execFileSync('findmnt', ['-n', '-o', 'FSTYPE', '-M', TMPFS_MOUNT_POINT], {});
  if (mount.status === 0) {
    if (mount.stdout.trim() !== 'tmpfs') {
      throw new Error(
        `${TMPFS_MOUNT_POINT} is a mountpoint but not tmpfs (${mount.stdout.trim()}); refusing to shadow it`,
      );
    }
  } else {
    execOrThrow('sudo', ['mkdir', '-p', TMPFS_MOUNT_POINT], {});
    const size = process.env.LXC_TMPFS_SIZE;
    const mountArgs = ['mount', '-t', 'tmpfs'];
    if (size != null && size !== '') {
      mountArgs.push('-o', `size=${size}`);
    }
    execOrThrow('sudo', [...mountArgs, 'tmpfs', TMPFS_MOUNT_POINT], {});
    logger.log(`[lxd] mounted tmpfs at ${TMPFS_MOUNT_POINT}${size != null && size !== '' ? ` (size=${size})` : ''}`);
  }

  const source = execFileSync('lxc', ['storage', 'get', TMPFS_POOL, 'source'], {});
  if (source.status === 0) {
    const existing = source.stdout.trim();
    if (existing !== TMPFS_MOUNT_POINT) {
      throw new Error(
        `storage pool '${TMPFS_POOL}' exists but is not sourced at ${TMPFS_MOUNT_POINT} ` +
          `(got '${existing || '(default)'}'); remove or rename it`,
      );
    }
    return;
  }
  execOrThrow('lxc', ['storage', 'create', TMPFS_POOL, 'dir', `source=${TMPFS_MOUNT_POINT}`], { timeout: 60000 });
  logger.log(`[lxd] storage pool '${TMPFS_POOL}' created on ${TMPFS_MOUNT_POINT}`);
}

/**
 * lxdbr0's host-side IPv4 — the gateway containers use to reach the host —
 * or null when LXD networking isn't initialized.
 */
export function getLxdBridgeIp(): string | null {
  const res = execFileSync('lxc', ['network', 'get', 'lxdbr0', 'ipv4.address'], {});
  if (res.status !== 0) {
    return null;
  }
  const address = res.stdout.trim().split('/')[0] ?? '';
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(address) ? address : null;
}

/**
 * Target-side apt configuration, written before Ansible runs so both
 * `ansible.builtin.apt` and raw `apt-get` (bench) pick it up:
 * always `Acquire::Retries` (absorbs flaky mirror connections), plus the
 * local apt-cacher-ng proxy when one was probed. proxyUrl=null keeps the
 * target fetching mirrors directly.
 */
export function configureTargetApt(name: string, proxyUrl: string | null): void {
  const lines = ['Acquire::Retries "3";'];
  if (proxyUrl != null) {
    lines.push(`Acquire::http::Proxy "${proxyUrl}";`);
  }
  const result = execFileSync('lxc', ['exec', name, '--', 'sh', '-c', 'cat > /etc/apt/apt.conf.d/99acquire'], {
    input: `${lines.join('\n')}\n`,
    timeout: 60000,
  });
  if (result.status !== 0) {
    throw new Error(`failed to write apt config in ${name}: ${result.stderr}`);
  }
}

export interface LaunchOptions {
  /** Back the container's rootfs with tmpfs (see ensureTmpfsPool). */
  readonly tmpfs?: boolean;
}

export function launchContainer(name: string, options: LaunchOptions = {}): void {
  const args = ['launch', 'ubuntu:26.04', name];
  if (options.tmpfs === true) {
    ensureTmpfsPool();
    args.push('-s', TMPFS_POOL);
    logger.log(`[lxd] ${name}: rootfs on tmpfs pool '${TMPFS_POOL}'`);
  }
  execOrThrow('lxc', args, { timeout: 300000 });
}

export function waitForCloudInit(name: string): void {
  execOrThrow('lxc', ['exec', name, '--', 'cloud-init', 'status', '--wait'], { timeout: 300000 });
}

export function publishPublicKey(name: string, publicKey: string): void {
  const script = [
    'install -d -m 700 -o ubuntu -g ubuntu /home/ubuntu/.ssh',
    'cat > /home/ubuntu/.ssh/authorized_keys',
    'chown ubuntu:ubuntu /home/ubuntu/.ssh/authorized_keys',
    'chmod 600 /home/ubuntu/.ssh/authorized_keys',
  ].join('; ');
  const result = execFileSync('lxc', ['exec', name, '--', 'sh', '-c', script], {
    input: `${publicKey}\n`,
    timeout: 60000,
  });
  if (result.status !== 0) {
    throw new Error(`failed to publish public key: ${result.stderr}`);
  }
}

export function getContainerIpv4(name: string): string {
  const result = execFileSync('lxc', ['list', name, '--format', 'json'], {});
  if (result.status !== 0) {
    throw new Error(`lxc list failed: ${result.stderr}`);
  }
  const instances = JSON.parse(result.stdout) as LxdInstance[];
  const target = instances.find((instance) => instance.name === name);
  if (target == null) {
    throw new Error(`container ${name} not found in lxc list`);
  }
  const networks = target.state?.network ?? {};
  for (const networkName of Object.keys(networks)) {
    const addresses = networks[networkName]?.addresses ?? [];
    for (const addr of addresses) {
      if (addr.family === 'inet' && addr.scope === 'global' && !addr.address.startsWith('127.')) {
        return addr.address;
      }
    }
  }
  throw new Error(`no IPv4 address for container ${name}`);
}

export function waitForSsh(ip: string, privateKeyPath: string): void {
  const args = [
    '-i', privateKeyPath,
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=5',
    `ubuntu@${ip}`,
    'true',
  ];
  const deadline = Date.now() + 120000;
  let lastStderr = '';
  while (Date.now() < deadline) {
    const res = execFileSync('ssh', args, { timeout: 20000 });
    if (res.status === 0) {
      return;
    }
    lastStderr = res.stderr;
    sleepMs(2000);
  }
  throw new Error(`SSH not ready for ${ip}: ${lastStderr}`);
}

export function readContainerLogs(name: string): string {
  const res = execFileSync(
    'lxc',
    ['exec', name, '--', 'journalctl', '-u', 'node-express-app', '-u', 'keycloak', '-u', 'mysql', '-n', '400', '--no-pager'],
    { timeout: 60000 },
  );
  return `${res.stdout}\n${res.stderr}`;
}

export function destroyContainer(name: string): void {
  execFileSync('lxc', ['delete', name, '--force'], { timeout: 120000 });
}

function sleepMs(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // Busy wait is acceptable for light, short readiness pauses.
  }
}
