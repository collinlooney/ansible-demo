# seed-test-db and import-users — programmatic API + CLI

Both scripts have been rewritten to separate **library code** (in `scripts/lib/`)
from **CLI entry points** (in `scripts/`). They can be invoked either
programmatically from Node.js (as `inttest.ts` now does) or from the command
line. No subprocess invocation is used between them — they are plain Node.js
functions called directly.

## Architecture

| File | Role |
|------|------|
| `scripts/lib/seed-test-db.ts` | Library: `seedTestDb(config, options)` — seeds a MySQL DB |
| `scripts/seed-test-db.ts` | CLI: parses args, calls `seedTestDb` |
| `scripts/lib/import-users.ts` | Library: `importUsers(mysqlConfig, keycloakConfig, options)` — imports users to Keycloak |
| `scripts/import-users.ts` | CLI: parses args, calls `importUsers` |
| `scripts/lib/mysql-config.ts` | Config: `readMysqlConfig()` (env) + `makeMysqlConfig(obj)` (programmatic) |
| `scripts/lib/keycloak-admin.ts` | Keycloak Admin API client (unchanged) |

## seed-test-db

Seeds a MySQL database with the production-shaped schema
(`AdminRoles`, `Admins`, `admins` legacy, `users`) from
`~/backups/mysql-all-20261027-121001.sql.gz`, then populates it with test
users. Drops and recreates the four tables on each run.

### Programmatic API

```typescript
import { seedTestDb, type SeedTestDbOptions } from './scripts/lib/seed-test-db';
import { makeMysqlConfig } from './scripts/lib/mysql-config';

const config = makeMysqlConfig({ password: 'rootpass', database: 'dc' });
const result = await seedTestDb(config, {
  count: 20,                                    // generated users
  extraUsers: [                                 // specific users
    {
      email: 'nnescio@example.com',
      firstName: 'nnescio',
      lastName: 'user',
      password: 'pass',
      adminRole: 2,                             // Super Administrator
    },
  ],
  passwords: { 'nnescio@example.com': 'pass' },
});

console.log(result);
// { adminRoles: 5, usersCreated: 21, bcryptHashed: 21 }
```

**`SeedTestDbOptions`:**
| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `count` | `number` | `10` | Number of generated regular users |
| `extraUsers` | `ExtraUserSpec[]` | `[]` | Additional specific users |
| `passwords` | `Record<string, string>` | `{}` | Plaintext passwords keyed by email |

**`ExtraUserSpec`:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `email` | `string` | yes | User email |
| `firstName` | `string` | yes | First name |
| `lastName` | `string` | yes | Last name |
| `password` | `string` | yes | Plaintext password (bcrypt-hashed) |
| `adminRole` | `number` | no | FK to `AdminRoles.id` (e.g. 2 = Super Administrator) |
| `legacyRole` | `'SuperAdmin' \| 'Admin'` | no | Legacy dc.admins string role |
| `customer` | `boolean` | no | Write a dc.users (customer) row |
| `alsoCustomer` | `boolean` | no | Write dc.users row in addition to dc.Admins |
| `inactive` | `boolean` | no | dc.Admins.status = 'inactive' |
| `blocked` | `boolean` | no | dc.users.blocked = 1 |
| `unverified` | `boolean` | no | dc.users.isVerified = 0 |
| `mustChange` | `boolean` | no | mustChangePassword = 1 |

### CLI

```
node scripts/seed-test-db.ts [--count N] [--extra-users PATH] [--help]
```

Example — create `nnescio` with password `pass` and Super Administrator privilege:

```json
// extra-users.json
[
  { "email": "nnescio@example.com", "firstName": "nnescio", "lastName": "user", "password": "pass", "adminRole": 2 }
]
```

```bash
MYSQL_PASSWORD=rootpass node scripts/seed-test-db.ts --count 5 --extra-users extra-users.json
```

**Env:** `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`, `MYSQL_PASSWORD` (required), `MYSQL_DATABASE`

## import-users

Reads `AdminRoles`, `Admins`, `admins` (legacy), and `users` from a MySQL
database, classifies accounts, and creates/updates them in Keycloak via the
Admin API. bcrypt hashes are copied verbatim through the bcrypt SPI.

### Programmatic API

```typescript
import { importUsers, type ImportUsersOptions } from './scripts/lib/import-users';
import { makeMysqlConfig } from './scripts/lib/mysql-config';
import { readKeycloakAdminConfig } from './scripts/lib/keycloak-admin';

const mysqlConfig = makeMysqlConfig({ password: 'rootpass', database: 'dc' });
const keycloakConfig = readKeycloakAdminConfig(); // reads from env

const result = await importUsers(mysqlConfig, keycloakConfig, { dryRun: false });
// { classified: 123, withCredentials: 45, disabled: 10, created: 100, updated: 23 }
```

**`ImportUsersOptions`:**
| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `dryRun` | `boolean` | `false` | Print plan without writing to Keycloak |

### CLI

```
node scripts/import-users.ts [--dry-run] [--help]
```

**Env:** `MYSQL_HOST/PORT/USER/PASSWORD/DATABASE`, `KC_URL`, `KC_REALM`, `KC_ADMIN_USERNAME`, `KC_ADMIN_PASSWORD`

## Usage from inttest

`scripts/inttest.ts` now calls both functions directly (in Node-land), passing
the MySQL tunnel config and Keycloak admin config as objects — no subprocess
spawning, no CLI argument encoding.

## Dependencies

Added `zod` for runtime validation of CLI options and extra-users JSON files.
