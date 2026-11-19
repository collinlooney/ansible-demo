import { logger } from './logger.ts';

export interface StepRecord {
  readonly name: string;
  readonly ms: number;
}

export interface StepTimer {
  /**
   * Runs fn as a named step: logs start and finish, records the duration, and
   * rethrows failures (the failed step is still recorded, so the breakdown
   * shows where a run died).
   */
  run<T>(name: string, fn: () => T | Promise<T>): Promise<T>;
  /** Steps in completion order. */
  readonly records: readonly StepRecord[];
  /** Slowest-first breakdown with percentages; one line per step. */
  report(): string;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = ((ms % 60_000) / 1000).toFixed(1);
  return `${minutes}m${seconds}s`;
}

/**
 * Minimal step timer for the long-running scripts. Every logical phase of a
 * run becomes a step; the report is printed at the end (and on failure) so a
 * slow phase is visible without re-running with a profiler.
 */
export function createStepTimer(prefix: string): StepTimer {
  const records: StepRecord[] = [];
  return {
    async run<T>(name: string, fn: () => T | Promise<T>): Promise<T> {
      logger.log(`[${prefix}] > ${name}`);
      const started = process.hrtime.bigint();
      try {
        return await fn();
      } finally {
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        records.push({ name, ms });
        logger.log(`[${prefix}] < ${name} (${formatDuration(ms)})`);
      }
    },
    records,
    report(): string {
      if (records.length === 0) {
        return `[${prefix}] timing breakdown: no steps recorded`;
      }
      const total = records.reduce((sum, record) => sum + record.ms, 0);
      const width = Math.max(...records.map((record) => record.name.length));
      const lines = [...records]
        .sort((a, b) => b.ms - a.ms)
        .map((record) => {
          const percent = total > 0 ? Math.round((record.ms / total) * 100) : 0;
          const name = record.name.padEnd(width);
          const duration = formatDuration(record.ms).padStart(8);
          return `  ${name}  ${duration}  ${String(percent).padStart(3)}%`;
        });
      return [
        `[${prefix}] timing breakdown (total ${formatDuration(total)}, slowest first):`,
        ...lines,
      ].join('\n');
    },
  };
}
