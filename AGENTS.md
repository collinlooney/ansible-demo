# AGENTS.md

Agent-specific guidance. Human-facing docs in README.md and docs/.

## Mission

LXC is the test-target simulator only. Ansible is the primary IaC layer. Deployment roles MUST NOT reference LXC. Built-in watch: scripts live in `scripts/*.ts` and run directly with `node`.

## Invariants

- No POSIX shell scripts for orchestration/test flow. Use TypeScript executed by Node.
- No LXC usage outside `scripts/lxd.ts` and inventory generation. Never add container semantics to roles.
- Node app binds 0.0.0.0.
- Systemd unit uses `EnvironmentFile`.
- Keep `app_backend` conditional and backend file split.
- Preserve `.run/<id>` on failure for diagnostics; clean on success.
- Generated host entry point must use the discovered container IP, never hard-code IPs.
- Scripts must remain erasable TypeScript: no enums, no parameter properties, `import type` where appropriate, no emit.

## Repo map

- `app/` Express source.
- `playbooks/site.yml`.
- `roles/` (`mysql` + `keycloak` gated by `mysql_enabled`/`keycloak_enabled`).
- `scripts/run.ts` subprocess helper.
- `scripts/lxd.ts` container lifecycle.
- `scripts/inttest.ts` one-click flow.
- `scripts/target.ts` per-run state: `.run/<id>` dir, SSH key, inventory rendering.
- `scripts/timing.ts` step timer; long-running scripts print a slowest-first breakdown.
- `scripts/ansible.ts` profiled `ansible-playbook` invocation (profile_tasks/profile_roles) + recap parsing.
- `scripts/bench-apt.ts` apt benchmark: roles' `apt`-tagged tasks vs raw apt-get (`npm run bench:apt`).
- `scripts/test-http.ts` HTTP assertions using `APP_URL`.
- `scripts/test-credentials.ts` Keycloak login assertions (seed -> import -> login).
- `scripts/seed-test-db.ts` writes dump-shaped fixtures; `scripts/import-users.ts` imports them into Keycloak.
- `scripts/keycloak-admin.ts` minimal Admin API client; `scripts/mysql-config.ts` shared MySQL env config.
- `scripts/test-users.ts` shared user fixtures for the credential inttest.
- `scripts/self.ts` target-host deploy (Linux only).
- `.run/` generated per test and gitignored.
- `inventories/lxc/` base vars (hosts.ini generated per run).

## Known constraints

- LXC native Linux/WSL2 only. macOS and Windows native not supported.
- Ansible control node requires Linux/WSL2.
- GitHub CI uses LXD via `lxd init --minimal`, which needs snap (runners have snapd).
- The Node runtime role installs `nodejs` and `npm` from Ubuntu packages; systemd uses `/usr/bin/node`.
- The `mysql` role exists for inttests only (Keycloak's test datastore); production Keycloak reuses the existing shared MySQL. Deployment roles never reference LXC or Docker regardless.
- Imported passwords are bcrypt (`$2a/$2b/$2y`, 60-char) via `leroyguillaume/keycloak-bcrypt`; Keycloak's default algorithm stays Argon2 and rehashes imported credentials on first login. Legacy hex+salt rows import disabled with no credential.
- Busy-loop waits are used for simplicity in TypeScript; keep them short.
- LXD container image download can be the dominant cold-start cost.
- All Ansible runs are profiled via `ansible.posix.profile_tasks`/`profile_roles` (bundled with the `ansible` package installed in CI). The five apt tasks in the roles carry `tags: [apt]` so `scripts/bench-apt.ts` can benchmark exactly those task bodies — keep them tagged.
- `docs/perf.md` records measured timings; refresh it when deploy logic changes materially affect them.

## Typical agent workflows

- Change deploy logic, then run `npm run inttest` (real container).
- Change tests, then run against container; `APP_URL` could point at any host.
- Use `npm run check:ts` before a run.
