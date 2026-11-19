import { logger } from './logger.ts';

/**
 * CLI flags shared by the throwaway-target test scripts (inttest, bench:apt).
 *
 * Both optimizations exist purely for speed on clean, disposable LXC targets
 * and must never reach a real host: the roles' apt_dpkg_options default stays
 * stock (role defaults files), and only these scripts opt in — self.ts and
 * production deploys take no flags at all.
 */
export interface PerfFlags {
  /** Pass --force-unsafe-io to dpkg during apt installs (inttest default: on). */
  readonly unsafeIo: boolean;
  /** Back the target container's rootfs with tmpfs (default: off). */
  readonly tmpfs: boolean;
  /** Use the local apt-cacher-ng when one answers (default: on; falls back to direct). */
  readonly aptCache: boolean;
}

export const DEFAULT_PERF_FLAGS: PerfFlags = { unsafeIo: true, tmpfs: false, aptCache: true };

/** Roles' stock dpkg options — the production-safe default. */
export const STOCK_DPKG_OPTIONS = 'force-confdef,force-confold';
/** Stock + force-unsafe-io: what these scripts pass as apt_dpkg_options. */
export const UNSAFE_IO_DPKG_OPTIONS = `${STOCK_DPKG_OPTIONS},force-unsafe-io`;

/**
 * apt-get's `-o Dpkg::Options::=...` flags for a dpkg_options value. The apt
 * module's format is comma-separated options without leading dashes (the
 * module adds "--" itself — expand_dpkg_options in ansible/modules/apt.py);
 * raw apt-get needs the dashes, so add them here.
 */
export function dpkgOptionArgs(dpkgOptions: string): string[] {
  return dpkgOptions.split(',').flatMap((option) => ['-o', `Dpkg::Options::=--${option}`]);
}

/** Parses --unsafe-io/--no-unsafe-io, --tmpfs/--no-tmpfs, --help; exits on bad input. */
export function parsePerfFlags(argv: readonly string[], defaults: PerfFlags, usage: string): PerfFlags {
  let unsafeIo = defaults.unsafeIo;
  let tmpfs = defaults.tmpfs;
  let aptCache = defaults.aptCache;
  for (const arg of argv) {
    if (arg === '--unsafe-io') {
      unsafeIo = true;
    } else if (arg === '--no-unsafe-io') {
      unsafeIo = false;
    } else if (arg === '--tmpfs') {
      tmpfs = true;
    } else if (arg === '--no-tmpfs') {
      tmpfs = false;
    } else if (arg === '--apt-cache') {
      aptCache = true;
    } else if (arg === '--no-apt-cache') {
      aptCache = false;
    } else if (arg === '--help' || arg === '-h') {
      logger.log(usage);
      process.exit(0);
    } else {
      logger.error(`unknown option: ${arg}`);
      logger.error(usage);
      process.exit(2);
    }
  }
  return { unsafeIo, tmpfs, aptCache };
}
