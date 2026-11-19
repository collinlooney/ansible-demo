import { logger } from './logger.ts';

/**
 * CLI flags shared by the throwaway-target test scripts (inttest, bench:apt)
 * and the output flags shared by every long-running script (inttest, self,
 * bench:apt).
 *
 * The perf optimizations exist purely for speed on clean, disposable LXC
 * targets and must never reach a real host: the roles' apt_dpkg_options
 * default stays stock (role defaults files), and only the throwaway scripts
 * opt in — self.ts and production deploys take no perf flags at all (the
 * parser rejects them there).
 *
 * The output flags select terminal presentation: rich tasuku rendering vs
 * the old timestamped plain logger, and whether the end-of-run timing
 * breakdown / ansible profile recap are printed.
 */
export interface PerfFlags {
  /** Pass --force-unsafe-io to dpkg during apt installs (inttest default: on). */
  readonly unsafeIo: boolean;
  /** Back the target container's rootfs with tmpfs (default: off). */
  readonly tmpfs: boolean;
  /** Use the local apt-cacher-ng when one answers (default: on; falls back to direct). */
  readonly aptCache: boolean;
}

export interface OutputFlags {
  /** Rich tasuku task list. undefined = auto (TTY and not CI). */
  readonly rich?: boolean;
  /** End-of-run timing breakdown. undefined = auto (plain: on, rich: off). */
  readonly timing?: boolean;
  /** Ansible tasks/roles profile recap. undefined = auto (plain: on, rich: off). */
  readonly profile?: boolean;
  /**
   * What to do with the LXC container and transient .run/ files after a run:
   *  - always:    tear down unconditionally
   *  - on-success: tear down only when the run passes (default)
   *  - never:     keep container and .run/ files for diagnostics
   */
  readonly teardownContainer?: 'always' | 'on-success' | 'never';
}

export interface ScriptFlags extends PerfFlags, OutputFlags {}

export const DEFAULT_PERF_FLAGS: PerfFlags = { unsafeIo: true, tmpfs: false, aptCache: true };
/** Everything resolves from the environment: see resolveOutputFlags. */
export const DEFAULT_OUTPUT_FLAGS: OutputFlags = {};
export const DEFAULT_SCRIPT_FLAGS: ScriptFlags = { ...DEFAULT_PERF_FLAGS, ...DEFAULT_OUTPUT_FLAGS, teardownContainer: 'on-success' };

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

/** Same env vars tasuku itself treats as "CI" (its append-only render mode). */
export function isCiEnvironment(): boolean {
  return Boolean(process.env.CI || process.env.CONTINUOUS_INTEGRATION || process.env.BUILD_NUMBER);
}

export interface ResolvedOutputFlags {
  readonly rich: boolean;
  readonly timing: boolean;
  readonly profile: boolean;
  readonly teardownContainer: 'always' | 'on-success' | 'never';
}

/**
 * Resolves the tri-state output flags against the environment:
 *  - rich: default on only for a real, non-CI terminal. tasuku redraws the
 *    task list with cursor escapes, which is exactly what you don't want in
 *    a pipe or a CI log, and an explicit --rich-output can't work without a
 *    TTY either (it degrades to plain with a warning).
 *  - timing/profile: default on in plain mode (the old output, byte for
 *    byte), off in rich mode (the task list already shows per-step elapsed
 *    times, and the recap would bury it).
 */
export function resolveOutputFlags(flags: OutputFlags): ResolvedOutputFlags {
  const tty = process.stdout.isTTY === true;
  let rich = flags.rich ?? (tty && !isCiEnvironment());
  if (rich && !tty) {
    logger.error('[flags] --rich-output needs a TTY; falling back to plain output');
    rich = false;
  }
  return {
    rich,
    timing: flags.timing ?? !rich,
    profile: flags.profile ?? !rich,
    teardownContainer: flags.teardownContainer ?? 'on-success',
  };
}

export interface ParseOptions {
  /** Whether the perf flags (--unsafe-io/--tmpfs/--apt-cache) are accepted here. */
  readonly perf: boolean;
}

/**
 * Parses the shared CLI flags; exits on bad input. Output flags are accepted
 * by every script; perf flags only where `perf: true` (never self.ts — that
 * is the production-shaped deploy path).
 */
export function parseScriptFlags(
  argv: readonly string[],
  defaults: ScriptFlags,
  usage: string,
  options: ParseOptions,
): ScriptFlags {
  let unsafeIo = defaults.unsafeIo;
  let tmpfs = defaults.tmpfs;
  let aptCache = defaults.aptCache;
  let rich = defaults.rich;
  let timing = defaults.timing;
  let profile = defaults.profile;
  let teardownContainer = defaults.teardownContainer;
  for (const arg of argv) {
    if (arg === '--unsafe-io' && options.perf) {
      unsafeIo = true;
    } else if (arg === '--no-unsafe-io' && options.perf) {
      unsafeIo = false;
    } else if (arg === '--tmpfs' && options.perf) {
      tmpfs = true;
    } else if (arg === '--no-tmpfs' && options.perf) {
      tmpfs = false;
    } else if (arg === '--apt-cache' && options.perf) {
      aptCache = true;
    } else if (arg === '--no-apt-cache' && options.perf) {
      aptCache = false;
    } else if (arg === '--rich-output') {
      rich = true;
    } else if (arg === '--no-rich-output') {
      rich = false;
    } else if (arg === '--timing') {
      timing = true;
    } else if (arg === '--no-timing') {
      timing = false;
    } else if (arg === '--profile') {
      profile = true;
    } else if (arg === '--no-profile') {
      profile = false;
    } else if (arg.startsWith('--teardown-container=')) {
      const value = arg.slice('--teardown-container='.length);
      if (value === 'always' || value === 'on-success' || value === 'never') {
        teardownContainer = value;
      } else {
        logger.error(`invalid --teardown-container value: ${value} (expected always, on-success, or never)`);
        logger.error(usage);
        process.exit(2);
      }
    } else if (arg === '--help' || arg === '-h') {
      logger.log(usage);
      process.exit(0);
    } else {
      logger.error(`unknown option: ${arg}`);
      logger.error(usage);
      process.exit(2);
    }
  }
  return { unsafeIo, tmpfs, aptCache, rich, timing, profile, teardownContainer };
}

/** The shared "Output" section of every script's --help text. */
export const OUTPUT_FLAG_USAGE: string = [
  'Output:',
  '  --rich-output / --no-rich-output  tasuku task list with live command output',
  '                                    previews (default: on when stdout is a TTY,',
  '                                    off when piped or running in CI)',
  '  --timing / --no-timing            end-of-run timing breakdown (default: on in',
  '                                    plain mode, off when rich)',
  '  --profile / --no-profile          ansible tasks/roles profile recap (default:',
  '                                    on in plain mode, off when rich)',
  '  --teardown-container=always       always tear down the container and .run/ files',
  '  --teardown-container=on-success   tear down only when the run passes (default)',
  '  --teardown-container=never        keep container and .run/ files for diagnostics',
].join('\n');
