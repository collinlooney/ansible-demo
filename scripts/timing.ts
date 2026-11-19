import type { StepContext, StepOptions, Ui } from './ui.ts';

export interface StepRecord {
  readonly name: string;
  readonly ms: number;
}

export interface StepTimer {
  /**
   * Runs fn as a named step: displays it through the ui (tasuku task in
   * rich mode, `[prefix] > name` / `< name (dur)` logger lines in plain
   * mode), records the duration, and rethrows failures (the failed step is
   * still recorded, so the breakdown shows where a run died).
   */
  run<T>(name: string, fn: (ctx: StepContext) => T | Promise<T>, options?: StepOptions): Promise<T>;
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
 * Step timer for the long-running scripts. Every logical phase of a run
 * becomes a step; the report is printed at the end (and on failure) when the
 * --timing flag enables it, so a slow phase is visible without re-running
 * with a profiler. Display lives in the ui: plain mode keeps the original
 * timestamped lines byte for byte, rich mode shows tasuku tasks with a live
 * per-step elapsed counter (making the breakdown redundant there — hence the
 * mode-dependent default).
 */
export function createStepTimer(prefix: string, ui: Ui): StepTimer {
  const records: StepRecord[] = [];
  return {
    async run<T>(name: string, fn: (ctx: StepContext) => T | Promise<T>, options?: StepOptions): Promise<T> {
      if (!ui.rich) {
        ui.log(`[${prefix}] > ${name}`);
      }
      const started = process.hrtime.bigint();
      try {
        return await ui.step(name, fn, options);
      } finally {
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        records.push({ name, ms });
        if (!ui.rich) {
          ui.log(`[${prefix}] < ${name} (${formatDuration(ms)})`);
        }
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
