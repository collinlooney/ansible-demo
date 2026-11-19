// Imports existing logins from the production-shaped MySQL schema into
// Keycloak. bcrypt hashes ($2a/$2b/$2y, 60-char) are copied verbatim through
// the bcrypt SPI credential format — no preimage is ever computed. Legacy
// hex+salt rows are imported disabled with no credential; recovery is
// Keycloak's own password reset email.
//
// Env: KC_URL, KC_REALM, KC_ADMIN_USERNAME/PASSWORD (see keycloak-admin.ts),
// MYSQL_* (see mysql-config.ts). --dry-run prints the plan without importing.
import mysql from 'mysql2/promise';
import type { RowDataPacket } from 'mysql2/promise';
import { logger } from './logger.ts';
import { readMysqlConfig } from './mysql-config.ts';
import { KeycloakAdmin, readKeycloakAdminConfig } from './keycloak-admin.ts';

// Importable iff the hash is a complete, standard bcrypt string. Anything else
// (legacy 64-byte hex digest + separate salt, plaintext) is dead weight: we
// cannot verify it, so we import the account disabled without a credential.
const BCRYPT_HASH = /^\$2[aby]\$(\d{2})\$[./A-Za-z0-9]{53}$/;

// The legacy tables contain username-only rows (e.g. `admin`) that are not
// valid email addresses; Keycloak accepts them as username-only users.
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const GROUP_SUPER_ADMINS = 'super-admins';
const GROUP_ADMINS = 'admins';
const GROUP_CUSTOMERS = 'customers';
const ACTION_UPDATE_PASSWORD = 'UPDATE_PASSWORD';

interface AdminRolesRow extends RowDataPacket {
  readonly id: number;
  readonly name: string;
}

interface AdminsRow extends RowDataPacket {
  readonly email: string;
  readonly password: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly role: number | null;
  readonly status: 'active' | 'inactive';
  readonly mustChangePassword: number;
}

interface LegacyAdminsRow extends RowDataPacket {
  readonly email: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly password: string;
  readonly role: string;
  readonly status: 'active' | 'inactive';
}

interface UsersRow extends RowDataPacket {
  readonly email: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly password: string;
  readonly isVerified: number;
  readonly blocked: number;
  readonly mustChangePassword: number;
}

interface ImportCredential {
  readonly hash: string;
  readonly cost: number;
}

interface ImportUser {
  email: string;
  firstName: string;
  lastName: string;
  enabled: boolean;
  emailVerified: boolean;
  groups: Set<string>;
  credential: ImportCredential | null;
  requiredActions: Set<string>;
}

function parseBcrypt(hash: string): ImportCredential | null {
  const match = BCRYPT_HASH.exec(hash);
  if (match == null) {
    return null;
  }
  return { hash, cost: Number(match[1]) };
}

function adminRoleGroup(roleName: string | undefined): string {
  return roleName === 'Super Administrator' ? GROUP_SUPER_ADMINS : GROUP_ADMINS;
}

function legacyRoleGroup(role: string): string {
  return role === 'SuperAdmin' ? GROUP_SUPER_ADMINS : GROUP_ADMINS;
}

function ensureUser(map: Map<string, ImportUser>, email: string): ImportUser {
  const key = email.toLowerCase();
  const existing = map.get(key);
  if (existing != null) {
    return existing;
  }
  const created: ImportUser = {
    email: key,
    firstName: '',
    lastName: '',
    enabled: false,
    emailVerified: false,
    groups: new Set<string>(),
    credential: null,
    requiredActions: new Set<string>(),
  };
  map.set(key, created);
  return created;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const mysqlConfig = readMysqlConfig();

  const connection = await mysql.createConnection({
    host: mysqlConfig.host,
    port: mysqlConfig.port,
    user: mysqlConfig.user,
    password: mysqlConfig.password,
    database: mysqlConfig.database,
  });

  try {
    const [roleRows] = await connection.query<AdminRolesRow[]>(
      'SELECT `id`, `name` FROM `AdminRoles`',
    );
    const roleNames = new Map<number, string>(roleRows.map((row) => [row.id, row.name]));

    const usersByEmail = new Map<string, ImportUser>();

    // dc.Admins — current admin table, role id -> AdminRoles.
    const [admins] = await connection.query<AdminsRow[]>(
      'SELECT `email`, `password`, `firstName`, `lastName`, `role`, `status`, `mustChangePassword` FROM `Admins`',
    );
    for (const row of admins) {
      const user = ensureUser(usersByEmail, row.email);
      user.firstName = row.firstName;
      user.lastName = row.lastName;
      user.enabled = user.enabled || row.status === 'active';
      user.emailVerified = true;
      user.groups.add(adminRoleGroup(row.role == null ? undefined : roleNames.get(row.role)));
      user.credential ??= parseBcrypt(row.password);
      if (row.mustChangePassword === 1) {
        user.requiredActions.add(ACTION_UPDATE_PASSWORD);
      }
    }

    // dc.admins — legacy admin table, string roles, dead credential format.
    const [legacyAdmins] = await connection.query<LegacyAdminsRow[]>(
      'SELECT `email`, `firstName`, `lastName`, `password`, `role`, `status` FROM `admins`',
    );
    for (const row of legacyAdmins) {
      const user = ensureUser(usersByEmail, row.email);
      if (user.firstName === '' && user.lastName === '') {
        user.firstName = row.firstName;
        user.lastName = row.lastName;
      }
      user.enabled = user.enabled || row.status === 'active';
      user.emailVerified = true;
      user.groups.add(legacyRoleGroup(row.role));
      user.credential ??= parseBcrypt(row.password);
    }

    // dc.users — customers. Blocked or unverified accounts stay disabled.
    const [customerRows] = await connection.query<UsersRow[]>(
      'SELECT `email`, `firstName`, `lastName`, `password`, `isVerified`, `blocked`, `mustChangePassword` FROM `users`',
    );
    for (const row of customerRows) {
      const user = ensureUser(usersByEmail, row.email);
      if (user.firstName === '' && user.lastName === '') {
        user.firstName = row.firstName;
        user.lastName = row.lastName;
      }
      const active = row.blocked !== 1 && row.isVerified === 1;
      user.enabled = user.enabled || active;
      user.emailVerified = user.emailVerified || row.isVerified === 1;
      user.groups.add(GROUP_CUSTOMERS);
      user.credential ??= parseBcrypt(row.password);
      if (row.mustChangePassword === 1) {
        user.requiredActions.add(ACTION_UPDATE_PASSWORD);
      }
    }

    logger.log(
      `[import] classified ${usersByEmail.size} accounts: ` +
        `${[...usersByEmail.values()].filter((user) => user.credential != null).length} with bcrypt credentials, ` +
        `${[...usersByEmail.values()].filter((user) => !user.enabled).length} disabled`,
    );

    if (dryRun) {
      for (const user of usersByEmail.values()) {
        logger.log(
          `[import:dry-run] ${user.email} enabled=${user.enabled} groups=[${[...user.groups].join(',')}] ` +
            `credential=${user.credential == null ? 'none' : `bcrypt:${user.credential.cost}`} ` +
            `actions=[${[...user.requiredActions].join(',')}]`,
        );
      }
      return;
    }

    const keycloakConfig = readKeycloakAdminConfig();
    const admin = new KeycloakAdmin(keycloakConfig);
    let created = 0;
    let updated = 0;
    for (const user of usersByEmail.values()) {
      const credential = user.credential;
      const hasEmail = EMAIL_PATTERN.test(user.email);
      // A username-only account with no importable credential has no login and
      // no recovery path (reset email needs an address) — import it disabled.
      const enabled = user.enabled && (hasEmail || credential != null);
      const outcome = await admin.ensureUser(
        {
          username: user.email,
          email: hasEmail ? user.email : '',
          firstName: user.firstName,
          lastName: user.lastName,
          enabled,
          emailVerified: hasEmail && user.emailVerified,
          requiredActions: [...user.requiredActions],
          ...(credential == null
            ? {}
            : {
                credentials: [
                  {
                    type: 'password' as const,
                    // Salt is empty on purpose: the bcrypt hash string embeds its
                    // own salt, and the SPI stores the full hash as the secret.
                    secretData: JSON.stringify({ value: credential.hash, salt: '' }),
                    credentialData: JSON.stringify({
                      algorithm: 'bcrypt',
                      hashIterations: credential.cost,
                    }),
                  },
                ],
              }),
        },
        [...user.groups],
      );
      if (outcome === 'created') {
        created += 1;
      } else {
        updated += 1;
      }
      logger.log(
        `[import] ${outcome} ${user.email} (groups=[${[...user.groups].join(',')}]` +
          `${credential == null ? ', no credential' : ', bcrypt credential'})`,
      );
    }
    logger.log(`[import] done: ${created} created, ${updated} updated`);
  } finally {
    await connection.end();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  logger.error(`[import] FAILED: ${message}`);
  process.exit(1);
});
