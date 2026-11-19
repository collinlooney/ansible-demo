import { execOrThrow, type ExecResult, type ExecOptions } from './run.ts';
import { logger } from './logger.ts';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Shared Ansible invocation helpers: every ansible-playbook run in this repo
 * gets per-task/per-role timing from ansible.posix.profile_tasks /
 * ansible.posix.profile_roles (ships with the `ansible` package; a missing
 * callback only degrades to a warning, never a failure).
 */
export function ansibleProfileEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const enabled = base.ANSIBLE_CALLBACKS_ENABLED ?? '';
  const callbacks = new Set(
    ['ansible.posix.profile_tasks', 'ansible.posix.profile_roles', ...enabled.split(',')]
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
  );
  return {
    ...base,
    ANSIBLE_CALLBACKS_ENABLED: [...callbacks].join(','),
    // Default is 20 tasks; site.yml has more and the bench needs all of them.
    PROFILE_TASKS_TASK_OUTPUT_LIMIT: 'all',
  };
}

export interface AnsibleRunOptions extends ExecOptions {
  readonly inventoryPath: string;
  /** Defaults to playbooks/site.yml relative to cwd. */
  readonly playbookPath?: string;
  readonly extraVars?: string;
  /** Extra CLI args (e.g. --tags, --check). */
  readonly extraArgs?: readonly string[];
  /** Writes the full playbook output (stdout+stderr) for later inspection. */
  readonly logPath?: string;
}

export function runAnsiblePlaybook(options: AnsibleRunOptions): ExecResult {
  const playbookPath = options.playbookPath ?? path.join(process.cwd(), 'playbooks', 'site.yml');
  const args = ['-i', options.inventoryPath, playbookPath];
  if (options.extraVars != null) {
    args.push('--extra-vars', options.extraVars);
  }
  if (options.extraArgs != null) {
    args.push(...options.extraArgs);
  }
  const result = execOrThrow('ansible-playbook', args, {
    ...options,
    env: ansibleProfileEnv(options.env ?? process.env),
  });
  if (options.logPath != null) {
    fs.writeFileSync(options.logPath, `${result.stdout}\n${result.stderr}`);
  }
  return result;
}

/**
 * Prints the profile_tasks/profile_roles recap (everything from the
 * "TASKS RECAP" banner to the end of the playbook output). The rest of the
 * output — task results — stays out of the console unless the caller streams.
 */
export function printProfileRecap(output: string): void {
  const marker = output.indexOf('TASKS RECAP');
  if (marker === -1) {
    logger.log('[ansible] no profile recap found (ansible.posix callbacks unavailable?)');
    return;
  }
  logger.log('[ansible] per-task profile:');
  logger.log(output.slice(marker).trimEnd());
}

/**
 * Parses "Task name ------- 12.34s" lines out of a profile_tasks recap into
 * milliseconds. Only the TASKS RECAP section is read (ROLES RECAP repeats the
 * same time under role names). Keys are kept verbatim: tasks inside a role are
 * reported as "role : task name".
 */
export function parseTaskTimes(output: string): Map<string, number> {
  const times = new Map<string, number>();
  const start = output.indexOf('TASKS RECAP');
  if (start === -1) {
    return times;
  }
  const rolesBanner = output.indexOf('ROLES RECAP', start);
  const section = output.slice(start, rolesBanner === -1 ? undefined : rolesBanner);
  for (const line of section.split('\n')) {
    const match = /^(.+?)\s+-+\s+([\d.]+)s\s*$/.exec(line);
    if (match != null) {
      times.set(match[1].trim(), Number(match[2]) * 1000);
    }
  }
  return times;
}

/** Exact lookup first, then the "role : task name" form profile_tasks uses. */
export function getTaskTime(times: ReadonlyMap<string, number>, taskName: string): number | undefined {
  const exact = times.get(taskName);
  if (exact != null) {
    return exact;
  }
  for (const [key, ms] of times) {
    if (key.endsWith(` : ${taskName}`)) {
      return ms;
    }
  }
  return undefined;
}
