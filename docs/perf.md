# Performance notes

Measured 2026-11-19 on the demo workstation (i7-13700K VM, virtio disk,
**btrfs-on-LVM root**, symmetric gigabit, LXD `dir` storage pool, Ubuntu 26.04
host and `ubuntu:26.04` containers).

## TL;DR

- **`ansible.builtin.apt` is not slow.** Across all five apt tasks, Ansible's
  total overhead over raw `apt-get` on an identical fresh container was
  **0.345s** (SSH + module + python-apt, `pipelining = True`). The slow apt
  task is equally slow without Ansible.
- **The slow apt task is `nodejs npm`: ~6 minutes raw, ~6 minutes under
  Ansible.** It is *fsync-bound*: dpkg unpacks **360 packages / 26,704
  regular files**, the host filesystem is btrfs, and a measured
  create+write+fsync costs **17–30 ms/file**. 26,704 × ~13 ms ≈ the observed
  ~5.5-minute unpack. IO pressure (`/proc/pressure/io some avg10`)
  sustained >50% — peaking at ~74% — while dpkg used ~2% CPU. Downloads are
  not the problem (32.9 MB fetched in 11–19s).
- **A single knob proves the model**: the same install with
  `-o Dpkg::Options::=--force-unsafe-io` runs in **1m54s instead of ~6m10s**.
- The whole apt phase runs IO-saturated (mysql/openjdk windows show 60–86%
  `some avg10`); mysql ~37s and openjdk ~26s are the same story on a smaller
  scale plus configure/trigger work — "yeah, it's just like that".
- The same fsync pathology is already documented in-repo for Keycloak's
  first boot (Liquibase at ~1 DDL/s when fsync-bound, see
  `roles/mysql/defaults/main.yml`).

## How to reproduce

```bash
npm run inttest          # per-phase breakdown + per-task Ansible profile
npm run bench:apt        # Ansible vs raw apt-get, twin fresh containers
```

- Every phase of `inttest`/`inttest:self` is timed; a slowest-first table with
  percentages is printed at the end of a run, pass or fail.
- Every `ansible-playbook` run enables `ansible.posix.profile_tasks` +
  `ansible.posix.profile_roles`; the per-task/per-role recap is printed after
  the playbook finishes. On failure the full playbook output is retained at
  `.run/<id>/ansible.log`.
- `INTTEST_ANSIBLE_LIVE=1 npm run inttest` streams Ansible output live
  instead of capturing it (demo mode).

## Full inttest breakdown (2026-11-19, PASS, 11m34.4s total)

| phase                                        | time | share |
| -------------------------------------------- | ---: | ----: |
| `ansible-playbook site.yml`                  | 7m24.3s | 64% |
| `wait for Keycloak readiness` (cold boot)    | 3m52.3s | 33% |
| launch container                             | 5.9s | 1% |
| destroy container                            | 3.2s | 0% |
| wait for cloud-init                          | 2.8s | 0% |
| everything else (SSH, tunnel, seed, import, HTTP + credential assertions) | ~2.4s | 0% |

Inside the playbook (`profile_tasks`, wall 7m24.3s vs task sum 7m24.0s →
**0.3s of connection/module overhead**):

| task (role)                                             | time |
| ------------------------------------------------------- | ---: |
| `node_runtime : Install Node.js and npm from Ubuntu packages` | **346.4s** |
| `mysql : Install MySQL server and Python driver`        | 38.5s |
| `keycloak : Install OpenJDK 21 runtime`                 | 31.6s |
| `common : Update apt cache`                             | 5.6s |
| `keycloak : Build optimized server image`               | 4.0s |
| `mysql : Restart mysql` (handler)                       | 3.0s |
| `keycloak : Download Keycloak tarball` (~110 MB from GitHub) | 2.9s |
| every other task (≈35 tasks combined)                   | ≈14s |

Roles recap: `node_runtime` 347.0s, `keycloak` 43.6s, `mysql` 42.8s,
`common` 6.6s, `node_express_app` 3.1s.

Two blocks — the npm unpack and Keycloak's cold boot — are **97% of the
run**, and both are fsync-bound small-file workloads on this storage.

## Benchmark: `ansible.builtin.apt` vs raw apt-get

`npm run bench:apt` launches two identical fresh `ubuntu:26.04` containers,
runs the raw `apt-get` commands in one and the *real role tasks*
(`ansible-playbook --tags apt`) in the other, then prints the comparison.

| operation                                   | ansible |  manual |   delta |
| ------------------------------------------- | ------: | ------: | ------: |
| refresh apt cache                           |    6.9s |   34.1s |  -27.3s |
| install ca-certificates curl                |   400ms |   342ms |   +58ms |
| install nodejs npm (`--no-install-recommends`) | 5m47.5s | 6m9.7s |  -22.3s |
| install mysql-server python3-pymysql        |   37.1s |   37.2s |  -188ms |
| install openjdk-21-jre-headless             |   38.9s |   25.8s |  +13.1s |
| **task total**                              | **7m10.7s** | **7m47.3s** | |

- **Ansible wall 7m11.1s vs task sum 7m10.7s → connection/module overhead
  0.345s** for five tasks.
- Deltas in both directions are dominated by *mirror speed variance*, not by
  the runner: `apt-get update` fetched the same 32.7 MB at 8.5 MB/s in one
  run and 1.06 MB/s in another (7.1s vs 34.1s). openjdk's +13s is the same
  effect on its 50.5 MB download.

## Anatomy of the 6-minute `nodejs npm` install

Evidence, run 2026-11-19 (bench + targeted re-measurements):

- **Scale**: `apt-get --download-only` of the operation yields 360 .debs;
  `dpkg-deb -c` over them counts **33,269 entries: 26,704 regular files,
  6,065 directories** (202 MB installed).
- **fsync cost** (create+write+fsync of 4 KB files on the same btrfs as the
  container rootfs): **29.6 ms/file cold, 16.8 ms/file warm**; directory fsync
  14–26 ms.
  26,704 files × ~13 ms effective ≈ 347s ≈ the observed unpack.
- **Process sampling** (host-visible `ps` every 3s during the bench):

  - the `dpkg --unpack --recursive …` phase occupies essentially the whole
    operation; configure is ~30s;
  - dpkg runs at ~1.5–2.5% CPU the whole time;
  - `/proc/pressure/io some avg10` climbs from <1% to **74%** — at least one
    task blocked on IO for most of every 10s window; 236 of ~250 samples in
    the window exceed 50%;
  - the pressure continues into the mysql (peak 86%) and openjdk (peak 75%)
    installs — the whole apt phase is IO-saturated; those tasks have far
    less file churn (311 regular files across openjdk + mysql +
    python3-pymysql), so they finish in tens of seconds instead of minutes.

- **A/B proof**: identical install with `-o Dpkg::Options::=--force-unsafe-io`
  (dpkg skips its per-file fsync): **1m54s** vs **~6m10s** baseline.

Verdict: **not Ansible, not apt-the-tool, not the network — per-file fsync on
btrfs multiplied by 26,704 files.** Same root cause as Keycloak's documented
cold-boot Liquibase slowness.

## Live-demo recommendations

- Show `npm run inttest` with `INTTEST_ANSIBLE_LIVE=1`: Ansible's output
  streams as it runs, and the per-task profile recap lands at the end of the
  playbook — the "coffee timer" becomes a measured table.
- The run always ends with the slowest-first phase breakdown, so the demo
  closes on numbers even if something fails.
- For a shorter demo path, `INTTEST_IDP=0 npm run inttest` skips the
  Keycloak/MySQL stack (the other multi-minute block).
- `npm run bench:apt` answers "is Ansible the slow part?" with a table:
  no — 0.345s for five tasks.

## Candidate optimizations (not applied; pick deliberately)

1. **`--force-unsafe-io` for throwaway targets** (−4.3 min): dpkg skips
   per-file fsync — safe for containers/VM snapshots, but on bare metal a
   power loss mid-install can leave unpacked files unsynced. Proposal: an
   `apt_dpkg_options`-style variable, safe default, overridden by the
   inttest inventory only. Measured: npm op 6m10s → 1m54s.
2. **Keycloak cold boot (3m52s)**: already the subject of
   `mysql_test_throughput`; next lever would be separating mysql first-boot
   init from Keycloak Liquibase time (journal timestamps) before changing
   anything.
3. **No change to what gets installed**: package counts and
   `install_recommends` posture stay as-is unless the tech lead says
   otherwise.

## Running the workflow locally with act

`.actrc` maps `ubuntu-latest` to act's `-self-hosted` platform so job steps
run directly on the host: the workflow provisions LXD, which needs systemd
and therefore cannot run inside act's default Docker containers. act only
loads "safe" flags from a project-level `.actrc` unless you pass
`--trust-project-actrc`:

```bash
act --trust-project-actrc -W .github/workflows/integration.yml -j lint
act --trust-project-actrc -W .github/workflows/integration.yml -j integration
```

(`act -P <label>=-self-hosted` is act's documented no-container host mode —
see act's Runners docs; `canonical/setup-lxd` and `sudo lxd init --minimal`
are both safe to re-run on a host where LXD is already initialized — verified
by running `act -j integration` end-to-end on an initialized host: setup-lxd
skipped provisioning and the full instrumented inttest passed inside act in
11m54s.)
