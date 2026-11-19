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
- Speed optimizations are inttest-only opt-ins: roles' `apt_dpkg_options` defaults to stock dpkg behavior (fsync-safe), and only `scripts/inttest.ts`/`scripts/bench-apt.ts` pass `--force-unsafe-io` (flag `--unsafe-io`, default on) or use tmpfs-backed targets (flag `--tmpfs`, default off). `inttest:self` and production deploys never take these flags (the parser rejects perf flags there). The local apt cache (apt-cacher-ng) is likewise scripts-only: it is probed and injected into targets by the scripts (`--apt-cache`, default on with silent fallback), never configured by roles. Mirror preferences are local configuration (`.apt-cache-mirrors` / `APT_CACHE_MIRRORS`, both gitignored-or-env): never hardcode a mirror hostname in the repo — the fastest mirror depends on where the machine lives.
- Plain output is the compatibility contract: piped/CI runs keep the old timestamped log byte for byte (gated reports on by default there), and rich tasuku rendering is opt-in/auto only for a real non-TTY-free terminal. Keep new log lines behind `ui.log`/`ui.error` so they respect the mode.

## Repo map

- `app/` Express source.
- `playbooks/site.yml`.
- `roles/` (`mysql` + `keycloak` gated by `mysql_enabled`/`keycloak_enabled`).
- `filter_plugins/` Jinja2 filters for template escaping (`systemd_env_escape`, `systemd_exec_escape`).
- `scripts/lib/` library modules (not directly invoked by users):
  - `run.ts` subprocess helper (sync `execFileSync` for quick queries; async `execFile`/`execFileOrThrow` with a `preview` sink for anything long-running — rich mode's spinner must not be blocked by spawnSync).
  - `ui.ts` presentation layer: rich mode = tasuku task list with `streamPreview` + per-step times; plain mode = the old timestamped logger (rich only when `stdout.isTTY && !CI` — cursor redraws are garbage in a pipe, so agents and CI always get plain output).
  - `flags.ts` shared CLI flags: perf flags (`--unsafe-io`/`--tmpfs`/`--apt-cache`, throwaway scripts only) and output flags (`--rich-output`/`--timing`/`--profile`/`--teardown-container=` + negations; auto-resolve: rich = TTY && !CI, timing/profile = on in plain, off in rich).
  - `lxd.ts` container lifecycle + target-side apt config (proxy/retries injection).
  - `apt-cache.ts` local apt-cacher-ng probe (auto-detect; absent = direct mirrors).
  - `ensure-apt-cache.ts` host-side cache setup (`npm run ensure:apt-cache`, optional; preferred mirrors from local `.apt-cache-mirrors`/`APT_CACHE_MIRRORS` — never hardcoded in the repo).
  - `target.ts` per-run state: `.run/<id>` dir, SSH key, inventory rendering.
  - `timing.ts` step timer; owns the plain-mode `> step` / `< step (dur)` lines and the gated slowest-first breakdown (`--timing`).
  - `ansible.ts` profiled `ansible-playbook` invocation (profile_tasks/profile_roles) + recap parsing.
  - `import-users.ts` imports seed fixtures into Keycloak.
  - `seed-test-db.ts` writes dump-shaped fixtures into MySQL.
  - `keycloak-admin.ts` minimal Admin API client; `mysql-config.ts` shared MySQL env config; `test-users.ts` shared user fixtures for the credential inttest; `logger.ts` timestamped logger.
- `scripts/inttest.ts` one-click flow (top-level, entry point).
- `scripts/bench-apt.ts` apt benchmark: roles' `apt`-tagged tasks vs raw apt-get (`npm run bench:apt`) (top-level, entry point).
- `scripts/self.ts` target-host deploy (Linux only) (top-level, entry point).
- `scripts/ensure-lxd.ts` LXD setup (`npm run ensure:lxd`) (top-level, entry point).
- `test/` Vitest suites (invoked via `npx vitest run`, not wrapper scripts):
  - `test-http.test.ts` HTTP assertions using `APP_URL`.
  - `test-credentials.test.ts` Keycloak login assertions (seed -> import -> login).
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
