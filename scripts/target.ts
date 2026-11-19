import { execOrThrow } from './run.ts';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Shared per-run plumbing for scripts that provision a throwaway target over
 * LXC: run identity/artifacts directory, SSH keypair, and the rendered
 * inventory Ansible connects through.
 */
export interface RunState {
  readonly id: string;
  readonly containerName: string;
  readonly runDir: string;
  readonly keyPath: string;
  readonly inventoryPath: string;
}

export function createRunState(containerPrefix: string): RunState {
  const id = `${Date.now().toString(36)}-${process.pid}`;
  const runDir = path.join(process.cwd(), '.run', id);
  const keyPath = path.join(runDir, 'id_ed25519');
  const containerName = `${containerPrefix}-${id.replace(/\./g, '-')}`.toLowerCase();
  return {
    id,
    containerName,
    runDir,
    keyPath,
    inventoryPath: path.join(runDir, 'hosts.ini'),
  };
}

export function renderInventory(ip: string, state: RunState): string {
  const commonArgs = '-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null';
  return `[lxc]
${ip} ansible_host=${ip} ansible_port=22 ansible_user=ubuntu ansible_ssh_private_key_file=${state.keyPath} ansible_ssh_common_args="${commonArgs}"
`;
}

/** Generates the run's ed25519 keypair and returns the public key. */
export function generateSshKey(state: RunState): string {
  execOrThrow('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', state.keyPath, '-q']);
  return fs.readFileSync(`${state.keyPath}.pub`, 'utf8').trim();
}
