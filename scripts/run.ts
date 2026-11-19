import { spawn, spawnSync } from 'node:child_process';
import type { Writable } from 'node:stream';

export interface ExecResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ExecOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly input?: string | Uint8Array;
  readonly timeout?: number;
  readonly cwd?: string;
  readonly shell?: boolean;
  /** Stream the child's stdio straight to this process instead of capturing it. */
  readonly stream?: boolean;
}

export interface AsyncExecOptions extends ExecOptions {
  /**
   * Rich-mode live preview: every stdout/stderr chunk is written here as it
   * arrives (and still captured into the result). Takes precedence over
   * `stream` — a step either previews into the task list or inherits the
   * terminal, never both.
   */
  readonly preview?: Writable | null;
}

export function execFileSync(
  cmd: string,
  args: readonly string[],
  options: ExecOptions = {}
): ExecResult {
  const res = spawnSync(cmd, args, {
    encoding: 'utf8',
    stdio: options.stream ? 'inherit' : ['pipe', 'pipe', 'pipe'],
    cwd: options.cwd,
    env: options.env ?? process.env,
    timeout: options.timeout,
    shell: options.shell ?? false,
    input: options.input,
  });
  const status = res.status == null ? 1 : res.status;
  let stderr = res.stderr == null ? '' : res.stderr;
  if (res.error) {
    stderr = `${stderr}\n${res.error.message}`.trim();
  }
  return {
    status,
    stdout: res.stdout == null ? '' : res.stdout,
    stderr,
  };
}

export function execOrThrow(
  cmd: string,
  args: readonly string[],
  options: ExecOptions = {}
): ExecResult {
  const res = execFileSync(cmd, args, options);
  if (res.status !== 0) {
    const output = [res.stdout, res.stderr].filter(Boolean).join('\n');
    throw new Error(
      `${cmd} ${args.join(' ')} exited with ${res.status}\n${output}`.trim()
    );
  }
  return res;
}

/**
 * Async counterpart of execFileSync, for anything that can outlive a frame:
 * spawnSync blocks the event loop, which would freeze tasuku's spinner and
 * its streamPreview (the whole point of rich mode). Output is captured into
 * the result exactly like the sync variant, and mirrored into `preview`
 * while the process runs.
 */
export async function execFile(
  cmd: string,
  args: readonly string[],
  options: AsyncExecOptions = {},
): Promise<ExecResult> {
  const preview = options.preview ?? null;
  const inherit = options.stream === true && preview == null;
  const child = spawn(cmd, [...args], {
    stdio: inherit ? ['ignore', 'inherit', 'inherit'] : ['pipe', 'pipe', 'pipe'],
    cwd: options.cwd,
    env: options.env ?? process.env,
    shell: options.shell ?? false,
  });

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  if (!inherit) {
    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk);
      preview?.write(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
      preview?.write(chunk);
    });
    // A child that exits without draining stdin surfaces EPIPE here; it has
    // already been reported through the exit status, don't crash the run.
    child.stdin?.on('error', () => {});
    if (options.input != null) {
      child.stdin?.end(options.input);
    } else {
      child.stdin?.end();
    }
  }

  let timedOut = false;
  const timer =
    options.timeout == null
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
        }, options.timeout);

  const { status, error } = await new Promise<{ status: number; error: Error | null }>(
    (resolve) => {
      let settled = false;
      const finish = (result: { status: number; error: Error | null }) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      // 'close' carries the exit code; 'error' covers spawn failures
      // (ENOENT etc.), where a 'close' may never arrive. Whichever comes
      // first wins and the other is ignored.
      child.once('close', (code, signal) => {
        finish({ status: code ?? (signal == null ? 0 : 1), error: null });
      });
      child.once('error', (spawnError) => {
        finish({ status: 1, error: spawnError });
      });
    },
  );
  if (timer !== undefined) {
    clearTimeout(timer);
  }

  let stderr = Buffer.concat(stderrChunks).toString('utf8');
  if (error != null) {
    stderr = `${stderr}\n${error.message}`.trim();
  } else if (timedOut) {
    stderr = `${stderr}\n${cmd} ${args.join(' ')} timed out after ${options.timeout}ms`.trim();
  }
  return {
    status,
    stdout: Buffer.concat(stdoutChunks).toString('utf8'),
    stderr,
  };
}

export async function execFileOrThrow(
  cmd: string,
  args: readonly string[],
  options: AsyncExecOptions = {},
): Promise<ExecResult> {
  const res = await execFile(cmd, args, options);
  if (res.status !== 0) {
    const output = [res.stdout, res.stderr].filter(Boolean).join('\n');
    throw new Error(
      `${cmd} ${args.join(' ')} exited with ${res.status}\n${output}`.trim()
    );
  }
  return res;
}
