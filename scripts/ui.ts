import type { Writable } from 'node:stream';
import task from 'tasuku';
import { logger } from './logger.ts';

/**
 * Terminal presentation layer for the long-running scripts (inttest, self,
 * bench:apt), built on tasuku.
 *
 * Rich mode (default when stdout is a TTY and we're not in CI) renders a task
 * list: one line per step with a live elapsed-time counter and a scrolling
 * `streamPreview` of the step's subprocess output (ansible-playbook, lxc
 * launch, cloud-init, the test runners), so long phases are never a black
 * hole. Plain mode keeps the original timestamped logger lines — it is what
 * agents and CI get (tasuku's cursor-redraw rendering is garbage in a pipe,
 * so non-TTY output never uses it) and what `--no-rich-output` forces.
 *
 * Plain-mode step start/finish lines are emitted by the step timer
 * (timing.ts) so their format stays byte-identical to the old logger.
 */
export interface StepContext {
  /** Live subprocess output sink; null in plain mode (capture-only). */
  readonly preview: Writable | null;
  /** Rich only: append a dimmed status after the step title while it runs. */
  setStatus(status: string): void;
  /** Rich only: rewrite the step title while it runs. */
  setTitle(title: string): void;
  /** Extra detail line: logger line in plain mode, task output in rich mode. */
  setOutput(output: string): void;
}

export interface StepOptions {
  /** Height of the streamPreview in lines (tasuku default: 5). */
  readonly previewLines?: number;
}

export interface Ui {
  /** Whether this run renders the tasuku task list. */
  readonly rich: boolean;
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
  /**
   * Runs fn as a displayed step. In rich mode it becomes a tasuku task with
   * showTime and a streamPreview; in plain mode fn just runs (the timer owns
   * the surrounding log lines).
   */
  step<T>(
    title: string,
    fn: (ctx: StepContext) => T | Promise<T>,
    options?: StepOptions,
  ): Promise<T>;
}

export function createUi(options: { readonly prefix: string; readonly rich: boolean }): Ui {
  const { prefix, rich } = options;

  const plainContext: StepContext = {
    preview: null,
    setStatus: () => {},
    setTitle: () => {},
    setOutput: (output) => {
      logger.log(`[${prefix}]`, output);
    },
  };

  return {
    rich,
    log: (...args: unknown[]) => {
      if (rich) {
        // tasuku patches console.* while tasks are active, so this renders
        // above the task list instead of corrupting its cursor math.
        console.log(...args);
      } else {
        logger.log(...args);
      }
    },
    error: (...args: unknown[]) => {
      if (rich) {
        console.error(...args);
      } else {
        logger.error(...args);
      }
    },
    step: async <T>(
      title: string,
      fn: (ctx: StepContext) => T | Promise<T>,
      stepOptions?: StepOptions,
    ): Promise<T> => {
      if (!rich) {
        return fn(plainContext);
      }
      const api = await task<T>(
        title,
        async ({ streamPreview, setStatus, setTitle, setOutput }) =>
          fn({
            preview: streamPreview,
            setStatus,
            setTitle,
            setOutput: (output) => setOutput(output),
          }),
        { showTime: true, previewLines: stepOptions?.previewLines ?? 5 },
      );
      return api.result;
    },
  };
}
