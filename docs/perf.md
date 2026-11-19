# Performance notes

Measured 2026-11-19 on the demo workstation (i7-13700K VM, virtio disk,
**btrfs-on-LVM root**, symmetric gigabit, LXD `dir` storage pool, Ubuntu 26.04
host and `ubuntu:26.04` containers).

## TL;DR

- **Two throwaway-target knobs collapse the run** (inttest-only flags, see
  [Applied optimizations](#applied-optimizations)):

  | configuration                          | total | playbook | npm task | Keycloak boot |
  | -------------------------------------- | ----: | -------: | -------: | ------------: |
  | baseline (stock dpkg, disk rootfs)     | 11m34.4s | 7m24.3s | 346.4s | 3m52.3s |
  | `--unsafe-io` (inttest default)        | 6m55.4s | 2m56.6s | 100.8s | 3m44.3s |
  | `--unsafe-io --tmpfs`                  | **1m19.7s** | **55.2s** | **16.0s** | **12.1s** |

- **`ansible.builtin.apt` is not slow.** Across all five apt tasks, Ansible's
  total overhead over raw `apt-get` on an identical fresh container was
  **0.345s** (SSH + module + python-apt, `pipelining = True`), re-measured at
  **351ms** after the optimizations below. The slow apt task is equally slow
  without Ansible.
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
  `roles/mysql/defaults/main.yml`). With `--tmpfs` both blocks move to
  memory and drop by 6–30×.

## How to reproduce

```bash
npm run inttest                    # per-phase breakdown + per-task Ansible profile
npm run inttest -- --tmpfs         # fastest: tmpfs-backed container rootfs
npm run inttest -- --no-unsafe-io  # stock dpkg fsync (the baseline above)
npm run bench:apt                  # Ansible vs raw apt-get, twin fresh containers
```

- `inttest` and `bench:apt` take `--unsafe-io/--no-unsafe-io` (default **on**)
  and `--tmpfs/--no-tmpfs` (default **off**); `--help` prints usage. These
  flags exist only on the throwaway-target scripts — `inttest:self` and
  production deploys always use the roles' stock, fsync-safe default.
- Every phase of `inttest`/`inttest:self` is timed; a slowest-first table with
  percentages is printed at the end of a run, pass or fail.
- Every `ansible-playbook` run enables `ansible.posix.profile_tasks` +
  `ansible.posix.profile_roles`; the per-task/per-role recap is printed after
  the playbook finishes. On failure the full playbook output is retained at
  `.run/<id>/ansible.log`.
- `INTTEST_ANSIBLE_LIVE=1 npm run inttest` streams Ansible output live
  instead of capturing it (demo mode).

## Full inttest breakdown (2026-11-19 baseline: PASS, 11m34.4s total)

The pre-optimization baseline, kept as the reference point for the ladder in
the TL;DR (stock dpkg, disk-backed rootfs):

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

### With `--unsafe-io` (default): PASS, 6m55.4s

Same run with `apt_dpkg_options` overridden to include `force-unsafe-io`:

| phase | time | vs baseline |
| --- | ---: | ---: |
| `ansible-playbook site.yml` | 2m56.6s | 7m24.3s → |
| `wait for Keycloak readiness` (cold boot) | 3m44.3s | ≈ unchanged (Liquibase fsync is not dpkg) |
| everything else | ~15s | ≈ unchanged |

Top tasks: `nodejs npm` **100.8s** (was 346.4s), mysql 35.9s (was 38.5s),
openjdk 12.6s (was 31.6s). The npm task keeps ~100s because configure/trigger
scripts and remaining metadata work still touch disk; the 26k unpack fsyncs
are gone.

### With `--unsafe-io --tmpfs`: PASS, 1m19.7s

Container rootfs on a host-mounted tmpfs (LXD `dir` pool on
`/var/tmp/ansible-demo-tmpfs`), so *every* fsync in the container — dpkg,
Liquibase, MySQL — becomes a memory operation:

| phase | time | vs baseline |
| --- | ---: | ---: |
| `ansible-playbook site.yml` | 55.2s | 7m24.3s → |
| `wait for Keycloak readiness` (cold boot) | 12.1s | 3m52.3s → |
| everything else | ~12s | ≈ unchanged |

Top tasks: `nodejs npm` **16.0s**, mysql install 5.6s, openjdk 4.1s,
`kc.sh build` 7.0s. Peak tmpfs usage stayed within the default cap (half of
RAM); no ENOSPC/OOM on this 7.2 GB host (swap already fully occupied).

## Benchmark: `ansible.builtin.apt` vs raw apt-get

`npm run bench:apt` launches two identical fresh `ubuntu:26.04` containers,
runs the raw `apt-get` commands in one and the *real role tasks*
(`ansible-playbook --tags apt`) in the other, then prints the comparison.
Both sides always get identical dpkg options (the inttest default unless
given `--no-unsafe-io`), so the delta stays "what Ansible costs".

Run with default flags (`unsafe-io=on`, `tmpfs=off`), 2026-11-19:

| operation                                   | ansible |  manual |   delta |
| ------------------------------------------- | ------: | ------: | ------: |
| refresh apt cache                           |    6.4s |   30.0s |  -23.6s |
| install ca-certificates curl                |   380ms |   319ms |   +61ms |
| install nodejs npm (`--no-install-recommends`) | 1m35.8s | 1m47.2s |  -11.5s |
| install mysql-server python3-pymysql        |   31.0s |   27.9s |   +3.1s |
| install openjdk-21-jre-headless             |   14.7s |   41.8s |  -27.2s |
| **task total**                              | **2m28.2s** | **3m27.3s** | |

- **Ansible wall 2m28.5s vs task sum 2m28.2s → connection/module overhead
  351ms** for five tasks — unchanged from the pre-flag measurement (0.345s):
  the optimizations change the underlying work, never Ansible's cost.
- `nodejs npm` is ~1m40 on **both** sides with force-unsafe-io (was ~6m on
  both sides with stock dpkg — the fsync story above).
- Deltas in both directions are dominated by *mirror speed variance*, not by
  the runner: this run's manual side fetched the same 32.7 MB at 1.2 MB/s
  (30s `update`) while the ansible side's update took 6.4s; openjdk's manual
  download ran at 1.6 MB/s (31s) against a fast fetch on the ansible side
  (−27.2s). The earlier run saw the same file at 8.5 MB/s vs 1.06 MB/s.

### Pre-flag baseline (stock dpkg, 2026-11-19)

| operation                                   | ansible |  manual |   delta |
| ------------------------------------------- | ------: | ------: | ------: |
| refresh apt cache                           |    6.9s |   34.1s |  -27.3s |
| install ca-certificates curl                |   400ms |   342ms |   +58ms |
| install nodejs npm (`--no-install-recommends`) | 5m47.5s | 6m9.7s |  -22.3s |
| install mysql-server python3-pymysql        |   37.1s |   37.2s |  -188ms |
| install openjdk-21-jre-headless             |   38.9s |   25.8s |  +13.1s |
| **task total**                              | **7m10.7s** | **7m47.3s** | |

This run established the findings below: overhead 0.345s, npm ~6m on both
sides, and mirror variance (the same 32.7 MB at 8.5 MB/s vs 1.06 MB/s across
runs).

## Anatomy of the 6-minute `nodejs npm` install

Evidence from the pre-flag baseline (run 2026-11-19, bench + targeted
re-measurements; both applied knobs remove this cost — see above):

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

- **Fastest full demo: `npm run inttest -- --tmpfs`** — the whole suite
  (deploy + HTTP + Keycloak credential assertions) finishes in **~1m20s**
  and still ends with the phase breakdown and per-task profile.
- Show `npm run inttest` with `INTTEST_ANSIBLE_LIVE=1`: Ansible's output
  streams as it runs, and the per-task profile recap lands at the end of the
  playbook — the "coffee timer" becomes a measured table.
- The run always ends with the slowest-first phase breakdown, so the demo
  closes on numbers even if something fails.
- For a shorter demo path, `INTTEST_IDP=0 npm run inttest` skips the
  Keycloak/MySQL stack (the other multi-minute block).
- `npm run bench:apt` answers "is Ansible the slow part?" with a table:
  no — ~0.35s for five tasks.

## Applied optimizations

1. **`apt_dpkg_options` + `--unsafe-io` flag** (applied 2026-11-19): the four
   roles with apt tasks carry `apt_dpkg_options: 'force-confdef,force-confold'`
   (stock, fsync-safe — production never gets unsafe-io) and pass it to
   `ansible.builtin.apt`'s `dpkg_options`. `scripts/inttest.ts` and
   `scripts/bench-apt.ts` override it via `--extra-vars` unless given
   `--no-unsafe-io`. Measured: playbook 7m24s → 2m57s, npm task 346s → 101s.
   - Gotcha worth remembering: this ansible's `apt` module wants
     `dpkg_options` as a **comma-separated list without leading dashes**
     (`expand_dpkg_options` adds `--` itself); a semicolon/dash value reaches
     dpkg as one `----force-...` token and fails.
2. **`--tmpfs` flag** (applied 2026-11-19, default off): `scripts/lxd.ts`
   mounts a tmpfs at `/var/tmp/ansible-demo-tmpfs` (cap via `LXC_TMPFS_SIZE`,
   default = half of RAM), creates an LXD `dir` pool on it, and launches the
   target with `-s tmpfs`. Idempotent; mount and pool persist for reuse and
   cost no RAM while idle. Measured: full inttest 6m55s → **1m20s** on top of
   unsafe-io, Keycloak cold boot 3m44s → 12s. Needs RAM headroom — like the
   dpkg flag, it is throwaway-target-only (`inttest:self`/production never
   take it).

## Remaining candidates

1. **Keycloak cold boot on disk-backed targets (3m44s without `--tmpfs`)**:
   already the subject of `mysql_test_throughput`; next lever would be
   separating mysql first-boot init from Keycloak Liquibase time (journal
   timestamps) before changing anything. With `--tmpfs` this block is 12s,
   so the lever only matters for production first boots.
2. **No change to what gets installed**: package counts and
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
