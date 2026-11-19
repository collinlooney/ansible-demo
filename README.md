# ansible-demo

Ansible deploys a minimal Node + Express app to a bare-metal Ubuntu 26.04 target. Integration tests run against a throwaway LXC container that provides a clean Ubuntu 26.04 instance.

## Requirements

- Ubuntu 26.04 (or WSL2 running Ubuntu 26.04). macOS and native Windows are not supported for integration tests.
- LXD initialized: `sudo lxd init --minimal` (usually once).
- Node.js and npm (installed via actions/setup-node in CI); Ansible (installed via Ubuntu packages in CI).
- Ansible is the control node, so it must run on Linux/WSL2 even on Windows.

## Install

```bash
sudo apt-get update
sudo apt-get install -y ansible ansible-lint yamllint
npm ci
npm run ensure:lxd
npm run ensure:apt-cache   # optional: local apt cache for fast, deterministic runs
```

`npm run ensure:lxd` initializes/checks LXD. CI runs `lxd init --minimal` itself.

`npm run ensure:apt-cache` installs and configures **apt-cacher-ng** on the
workstation (bound to the LXD bridge only). It is optional: `inttest` and
`bench:apt` probe for it and use it automatically when present, falling back
to direct mirror fetches when absent (so CI is unchanged). The first run
fills the cache; runs after that serve debs from local disk and survive
flaky/dead Ubuntu mirrors (apt-cacher-ng fails over down your mirror list).

**Configure your nearest mirror** (mirror choice is location-dependent, so
it is local config, never committed): create `.apt-cache-mirrors` in the
repo root — one `host/path` entry per line, order = preference — or set
`APT_CACHE_MIRRORS="host/path ..."` (takes precedence; empty disables). The
proxy then fetches each file exactly once from the first healthy entry and
serves every later run from disk: one polite upstream relationship instead
of repeated direct fetches, and the cache is never flushed on purpose.

## Run

```bash
npm run check:ts
npm run inttest
npm run inttest:self         # deploy on the current host (Linux only)
```

## Running the CI workflow locally with act

`.actrc` maps `ubuntu-latest` to act's `-self-hosted` platform: the workflow
provisions LXD, which needs systemd, so job steps must run directly on the host
instead of act's default Docker containers.

```bash
act --trust-project-actrc -W .github/workflows/integration.yml -j lint
act --trust-project-actrc -W .github/workflows/integration.yml -j integration
```

`--trust-project-actrc` is required: act only loads "safe" flags from a
project-level `.actrc` by default, and `-self-hosted` reaches host resources.
Without act, `npm run inttest` runs the same steps the integration job runs.

## What the test does

1. Launch an Ubuntu 26.04 LXC container.
2. Wait for cloud-init, inject an ephemeral SSH key.
3. Provision via Ansible.
4. Run HTTP assertions against `GET /fib?n=10` (expects 55) and invalid input (expects 400).
5. Destroy the container and clean artifacts. On failure, diagnostics are retained in `.run/`.

## Config knobs

`roles/node_express_app/templates/app.env.j2` renders `PORT`, `APP_NAME`, `LOG_LEVEL`, and `NODE_ENV`.

## Performance instrumentation

- Every `inttest`/`inttest:self` run times each phase and prints a slowest-first breakdown (pass or fail) as its final output.
- Every `ansible-playbook` invocation enables `ansible.posix.profile_tasks` + `ansible.posix.profile_roles`, so runs end with a per-task/per-role timing table. On failure the full playbook output is retained at `.run/<id>/ansible.log`.
- `INTTEST_ANSIBLE_LIVE=1 npm run inttest` streams Ansible output as it runs (demo mode) instead of capturing it.
- `npm run bench:apt` benchmarks the roles' `apt`-tagged tasks against the equivalent raw `apt-get` commands on a second, identical fresh container and prints a side-by-side comparison.
- `inttest` and `bench:apt` take throwaway-target speed flags (see `--help`):
  - `--unsafe-io` / `--no-unsafe-io` — pass dpkg `--force-unsafe-io` during apt installs. **Default on for these scripts only**; the roles' `apt_dpkg_options` default stays stock, so `inttest:self` and production deploys always get fsync-safe installs.
  - `--tmpfs` / `--no-tmpfs` — back the container's whole rootfs with a host-mounted tmpfs (dpkg/Liquibase/MySQL fsyncs become memory operations). Default off; needs RAM headroom (default cap = half of RAM, override with `LXC_TMPFS_SIZE=4G`).
  - `--apt-cache` / `--no-apt-cache` — use the local apt cache from `npm run ensure:apt-cache` when one answers (default on; auto-fallback to direct mirror fetches when absent). Use `--no-apt-cache` to measure raw mirror behavior.
- Measured end to end: baseline **11m34s** → default flags (`--unsafe-io`) **6m55s** → `npm run inttest -- --tmpfs` **1m20s** (see [`docs/perf.md`](docs/perf.md)).

Measured findings and how to reproduce them: [`docs/perf.md`](docs/perf.md).

## Notes

- `scripts/*.ts` use Node's native TypeScript support. No bundle/build step.
- LXC is **never** used in deployment roles; changing `app_backend` is the intended future pivot.
