import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, execOrThrow } from './run.ts';
import { getLxdBridgeIp } from './lxd.ts';
import { probeAptCache } from './apt-cache.ts';
import { logger } from './logger.ts';

/**
 * Host-side setup for the local apt cache (`npm run ensure:apt-cache`).
 *
 * Optional by design: inttest and bench:apt probe for the cache and fall
 * back to direct mirror fetches when it isn't there (CI stays unchanged).
 * Installs apt-cacher-ng, binds it to the LXD bridge only — this build has
 * no client ACLs, so the listen address IS the access control, and the LAN
 * must never see an open caching proxy — then restarts and verifies.
 * The cache directory persists across restarts; first target run warms it.
 *
 * Mirror preference is LOCAL configuration and must never be hardcoded in
 * this repo: the fastest mirror depends on where the machine physically
 * lives (a university mirror near you beats the Canonical endpoints, which
 * are not CDN-routed and may throttle a chatty client). Configure it via the
 * APT_CACHE_MIRRORS env var (space-separated) or an untracked
 * `.apt-cache-mirrors` file in the repo root (one `host/path` entry per
 * line, `#` comments). With mirrors configured, apt-cacher-ng fetches each
 * file once from the first healthy entry and serves every container from
 * local disk afterwards — one polite upstream relationship, no repeat
 * traffic, and a dead mirror fails over down the list.
 *
 * Gotcha, verified at IP level with strace: referencing the stock empty
 * `file:backends_ubuntu` in a Remap target list silently discards the WHOLE
 * list — target lists are raw URLs only.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIRRORS_FILE = join(REPO_ROOT, '.apt-cache-mirrors');

/** Strips scheme and trailing slashes: acng targets are `host/path`, http assumed. */
function normalizeMirror(entry: string): string {
  return entry.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

/**
 * Preferred mirrors from outside the repo. A set APT_CACHE_MIRRORS (even
 * empty) takes precedence exclusively over the file, so a shell can override
 * or disable the local list for one invocation.
 */
function loadPreferredMirrors(): { mirrors: string[]; source: string } {
  const fromEnv = process.env.APT_CACHE_MIRRORS;
  if (fromEnv != null) {
    const mirrors = fromEnv.split(/\s+/).filter((entry) => entry !== '').map(normalizeMirror);
    return { mirrors, source: 'APT_CACHE_MIRRORS' };
  }
  let raw: string;
  try {
    raw = readFileSync(MIRRORS_FILE, 'utf8');
  } catch {
    return { mirrors: [], source: MIRRORS_FILE };
  }
  const mirrors = raw
    .split('\n')
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter((line) => line !== '')
    .map(normalizeMirror)
    .filter((entry) => entry !== '');
  return { mirrors, source: MIRRORS_FILE };
}

async function main(): Promise<void> {
  try {
    const status = execFileSync('dpkg-query', ['-W', '-f=${Status}', 'apt-cacher-ng'], {});
    if (status.status !== 0 || !status.stdout.includes('install ok installed')) {
      logger.log('[ensure-apt-cache] installing apt-cacher-ng...');
      execOrThrow('sudo', ['apt-get', 'install', '-y', 'apt-cacher-ng'], {
        env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' },
        timeout: 600000,
      });
    }

    const bridgeIp = getLxdBridgeIp();
    if (bridgeIp == null) {
      throw new Error('lxdbr0 is not initialized — run `npm run ensure:lxd` first');
    }

    const { mirrors, source } = loadPreferredMirrors();

    // BindAddress is the only access control this build has (no client
    // ACLs): the LAN must never see an open caching proxy, so bind to the LXD
    // bridge only. The Remap lines merge into the stock ones (repeated Remap
    // lines for a repo merge their URL lists): order = preference, first
    // success sticks, timeouts fail over, and keyfile=Release makes a mirror
    // serving 404-for-everything fail over too. Without configured mirrors
    // the Remap lines are omitted entirely: stock apt-cacher-ng behavior
    // (fetch from the requested host, still cached). security.ubuntu.com in
    // the ubusec target list is the stock Ubuntu security endpoint every
    // sources.list already uses — a last resort for local mirrors that don't
    // carry the -security pocket, not a mirror preference.
    const configLines = [`BindAddress: ${bridgeIp}`];
    if (mirrors.length > 0) {
      const targets = mirrors.join(' ');
      configLines.push(
        `Remap-uburep: file:ubuntu_mirrors /ubuntu ; ${targets} ; keyfile=Release`,
        `Remap-ubusec: security.ubuntu.com/ubuntu ; ${targets} security.ubuntu.com ; keyfile=Release`,
      );
      logger.log(`[ensure-apt-cache] preferred mirrors from ${source}: ${mirrors.join(', ')}`);
    } else {
      logger.log(`[ensure-apt-cache] no preferred mirrors configured (${source} not found) —`);
      logger.log('[ensure-apt-cache] stock passthrough only. Set your nearest mirror for');
      logger.log('[ensure-apt-cache] failover + a single polite upstream: see README.');
    }
    execOrThrow('sudo', ['sh', '-c', 'cat > /etc/apt-cacher-ng/99lxd-bridge.conf'], {
      input: `${configLines.join('\n')}\n`,
    });
    execOrThrow('sudo', ['systemctl', 'enable', '--quiet', 'apt-cacher-ng'], {});
    execOrThrow('sudo', ['systemctl', 'restart', 'apt-cacher-ng'], {});

    let cacheUrl: string | null = null;
    const deadline = Date.now() + 5000;
    while (cacheUrl == null && Date.now() < deadline) {
      cacheUrl = await probeAptCache();
      if (cacheUrl == null) {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
    if (cacheUrl == null) {
      throw new Error(`apt-cacher-ng not answering on ${bridgeIp}:3142 after restart`);
    }
    logger.log(`[ensure-apt-cache] OK — cache at ${cacheUrl} (report: ${cacheUrl}/acng-report.html)`);
    logger.log('[ensure-apt-cache] inttest/bench use it automatically; the first run warms it.');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[ensure-apt-cache] FAILED: ${message}`);
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  logger.error(message);
  process.exit(1);
});
