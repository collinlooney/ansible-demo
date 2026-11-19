// Seeds the integration-test MySQL schema with rows shaped like the production
// dump (same tables/columns) so import-users.ts exercises the real import path.
//
// Env: MYSQL_HOST/PORT/USER/PASSWORD/DATABASE, IMPORT_TEST_PASSWORDS (JSON
// email -> plaintext password; only for fixtures that need one).
import mysql from 'mysql2/promise';
import bcrypt from 'bcryptjs';
import { logger } from './logger.ts';
import { readMysqlConfig } from './mysql-config.ts';
import { TEST_ADMIN_ROLES, TEST_USERS } from './test-users.ts';

// Verbatim CREATE TABLE statements from the authorized production dump
// (~/backups/mysql-all-20261027-121001.sql.gz), so the importer runs against
// the real schema, not a paraphrase.
const DDL_ADMIN_ROLES = `CREATE TABLE \`AdminRoles\` (
  \`id\` int NOT NULL AUTO_INCREMENT,
  \`name\` varchar(255) NOT NULL,
  \`permissions\` varchar(255) NOT NULL,
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB AUTO_INCREMENT=59 DEFAULT CHARSET=utf8mb3`;

const DDL_ADMINS = `CREATE TABLE \`Admins\` (
  \`email\` varchar(255) NOT NULL,
  \`password\` varchar(255) NOT NULL,
  \`firstName\` varchar(255) NOT NULL,
  \`lastName\` varchar(255) NOT NULL,
  \`role\` int DEFAULT NULL,
  \`last_login\` datetime DEFAULT NULL,
  \`status\` enum('active','inactive') NOT NULL DEFAULT 'active',
  \`mustChangePassword\` tinyint(1) NOT NULL DEFAULT '0',
  PRIMARY KEY (\`email\`),
  KEY \`role_idx\` (\`role\`),
  KEY \`idx_admins_last_login_status\` (\`last_login\`,\`status\`),
  CONSTRAINT \`RoleID\` FOREIGN KEY (\`role\`) REFERENCES \`AdminRoles\` (\`id\`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb3`;

const DDL_LEGACY_ADMINS = `CREATE TABLE \`admins\` (
  \`email\` varchar(100) NOT NULL,
  \`firstName\` varchar(50) NOT NULL,
  \`lastName\` varchar(50) NOT NULL,
  \`password\` varchar(128) NOT NULL,
  \`salt\` varchar(64) NOT NULL,
  \`roles\` varchar(1024) DEFAULT NULL,
  \`role\` varchar(32) NOT NULL DEFAULT 'Admin',
  \`status\` enum('active','inactive') NOT NULL DEFAULT 'active',
  \`last_login\` datetime DEFAULT NULL,
  PRIMARY KEY (\`email\`),
  UNIQUE KEY \`email_UNIQUE\` (\`email\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb3`;

const DDL_USERS = `CREATE TABLE \`users\` (
  \`email\` varchar(100) NOT NULL,
  \`firstName\` varchar(50) NOT NULL,
  \`lastName\` varchar(50) NOT NULL,
  \`password\` varchar(128) NOT NULL,
  \`salt\` varchar(60) DEFAULT NULL,
  \`isVerified\` tinyint NOT NULL DEFAULT '1' COMMENT '0 for not verified, 1 for verified',
  \`previouslyVerified\` tinyint NOT NULL DEFAULT '1' COMMENT '0 for was not previously verified, 1 for previously verified',
  \`expirationDate\` datetime DEFAULT NULL,
  \`blocked\` tinyint NOT NULL DEFAULT '0' COMMENT '0 for not blocked, 1 for blocked',
  \`previouslyBlocked\` tinyint NOT NULL DEFAULT '0' COMMENT '0 for not previously blocked, 1 for previously blocked',
  \`companyName\` varchar(100) DEFAULT NULL,
  \`phoneNumber\` varchar(20) DEFAULT NULL,
  \`role\` varchar(50) DEFAULT 'General Public',
  \`subscriber_approved\` datetime DEFAULT NULL,
  \`last_login\` datetime DEFAULT NULL COMMENT 'Timestamp of last successful login -- updated on every login',
  \`verified\` tinyint(1) NOT NULL DEFAULT '0',
  \`verification_token\` varchar(64) DEFAULT NULL,
  \`verification_sent_at\` datetime DEFAULT NULL,
  \`verified_at\` datetime DEFAULT NULL,
  \`mustChangePassword\` tinyint(1) NOT NULL DEFAULT '0',
  \`isTestAccount\` tinyint(1) NOT NULL DEFAULT '0',
  \`lastLoginAt\` datetime DEFAULT NULL,
  \`created_at\` datetime DEFAULT NULL,
  PRIMARY KEY (\`email\`),
  UNIQUE KEY \`email_UNIQUE\` (\`email\`),
  KEY \`idx_users_expiration\` (\`expirationDate\`),
  KEY \`idx_users_last_login\` (\`last_login\`)
) ENGINE=InnoDB DEFAULT CHARSET=latin1`;

// Pre-bcrypt dead credential format: 64-byte hex digest + separate salt.
const DEAD_HASH = '0'.repeat(64);
const DEAD_SALT = '0'.repeat(16);

async function main(): Promise<void> {
  const config = readMysqlConfig();
  const passwords = JSON.parse(
    process.env.IMPORT_TEST_PASSWORDS ?? '{}',
  ) as Record<string, string>;

  const connection = await mysql.createConnection({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
  });

  try {
    // Admins has an FK to AdminRoles: drop children first.
    await connection.query('DROP TABLE IF EXISTS `Admins`');
    await connection.query('DROP TABLE IF EXISTS `admins`');
    await connection.query('DROP TABLE IF EXISTS `users`');
    await connection.query('DROP TABLE IF EXISTS `AdminRoles`');
    await connection.query(DDL_ADMIN_ROLES);
    await connection.query(DDL_ADMINS);
    await connection.query(DDL_LEGACY_ADMINS);
    await connection.query(DDL_USERS);

    for (const role of TEST_ADMIN_ROLES) {
      await connection.query('INSERT INTO `AdminRoles` (`id`, `name`, `permissions`) VALUES (?, ?, ?)', [
        role.id,
        role.name,
        role.permissions,
      ]);
    }

    let hashed = 0;
    for (const user of TEST_USERS) {
      let hash: string;
      if (user.password) {
        const plaintext = passwords[user.email];
        if (plaintext == null || plaintext === '') {
          throw new Error(`IMPORT_TEST_PASSWORDS is missing a password for ${user.email}`);
        }
        hash = await bcrypt.hash(plaintext, 10);
        hashed += 1;
      } else {
        hash = DEAD_HASH;
      }

      if (user.adminRole != null) {
        await connection.query(
          'INSERT INTO `Admins` (`email`, `password`, `firstName`, `lastName`, `role`, `status`, `mustChangePassword`) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [
            user.email,
            hash,
            user.firstName,
            user.lastName,
            user.adminRole,
            user.inactive === true ? 'inactive' : 'active',
            user.mustChange === true ? 1 : 0,
          ],
        );
      }

      if (user.legacyRole != null) {
        await connection.query(
          'INSERT INTO `admins` (`email`, `firstName`, `lastName`, `password`, `salt`, `role`, `status`) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [user.email, user.firstName, user.lastName, hash, DEAD_SALT, user.legacyRole, 'active'],
        );
      }

      if (user.customer === true || user.alsoCustomer === true) {
        await connection.query(
          'INSERT INTO `users` (`email`, `firstName`, `lastName`, `password`, `salt`, `isVerified`, `blocked`, `mustChangePassword`) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [
            user.email,
            user.firstName,
            user.lastName,
            hash,
            user.password ? null : DEAD_SALT,
            user.unverified === true ? 0 : 1,
            user.blocked === true ? 1 : 0,
            user.mustChange === true ? 1 : 0,
          ],
        );
      }
    }

    logger.log(`[seed] schema created; ${TEST_USERS.length} users, ${hashed} bcrypt-hashed`);
  } finally {
    await connection.end();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  logger.error(`[seed] FAILED: ${message}`);
  process.exit(1);
});
