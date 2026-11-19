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
```

`npm run ensure:lxd` initializes/checks LXD. CI runs `lxd init --minimal` itself.

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

Measured findings and how to reproduce them: [`docs/perf.md`](docs/perf.md).

## Notes

- `scripts/*.ts` use Node's native TypeScript support. No bundle/build step.
- LXC is **never** used in deployment roles; changing `app_backend` is the intended future pivot.
