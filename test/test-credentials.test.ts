// Login assertions for the bcrypt import path: seeded MySQL rows are imported
// into Keycloak by import-users.ts, then logged in via the direct access grant
// (password grant on the token endpoint — no form scripting).
//
// Env: KEYCLOAK_URL, KC_REALM, IMPORT_TEST_PASSWORDS, MYSQL_* (for the
// rehash-to-argon2 assertion against Keycloak's own credential store).
import { beforeAll, describe, expect, it } from 'vitest';
import mysql from 'mysql2/promise';
import type { RowDataPacket } from 'mysql2/promise';
import { readMysqlConfig } from '../scripts/lib/mysql-config.ts';
import { TEST_USERS } from '../scripts/lib/test-users.ts';

const baseUrl = (process.env.KEYCLOAK_URL ?? 'http://127.0.0.1:8080').replace(/\/$/, '');
const realm = process.env.KC_REALM ?? 'digiclips';
const readyTimeoutMs = Number(process.env.KEYCLOAK_READY_TIMEOUT_MS ?? '300000');
const pollMs = 2000;

const passwords = JSON.parse(
  process.env.IMPORT_TEST_PASSWORDS ?? '{}',
) as Record<string, string>;

function passwordFor(email: string): string {
  const value = passwords[email];
  if (value == null || value === '') {
    throw new Error(`IMPORT_TEST_PASSWORDS is missing a password for ${email}`);
  }
  return value;
}

interface TokenResponse {
  readonly access_token?: string;
  readonly error?: string;
  readonly error_description?: string;
}

interface TokenClaims {
  readonly groups?: readonly string[];
}

async function passwordGrant(username: string, password: string): Promise<TokenResponse> {
  const response = await fetch(`${baseUrl}/realms/${realm}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: 'web',
      username,
      password,
      scope: 'openid',
    }),
  });
  expect(response.status, `token endpoint returned ${response.status}`).toBe(200);
  return (await response.json()) as TokenResponse;
}

function decodeClaims(token: string): TokenClaims {
  const payload = token.split('.')[1];
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as TokenClaims;
}

async function waitForReady(): Promise<void> {
  const url = `${baseUrl}/realms/${realm}/.well-known/openid-configuration`;
  const deadline = Date.now() + readyTimeoutMs;
  let lastError = 'unknown';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
      lastError = `issuer metadata status ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    const delay = Math.min(pollMs, Math.max(0, deadline - Date.now()));
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  throw new Error(`Keycloak not ready within ${readyTimeoutMs}ms: ${lastError}`);
}

interface RehashRow extends RowDataPacket {
  readonly algorithm: string;
  readonly secret: string;
}

function specFor(email: string) {
  const spec = TEST_USERS.find((user) => user.email === email);
  if (spec == null) {
    throw new Error(`fixture missing for ${email}`);
  }
  return spec;
}

describe('imported credentials', () => {
  beforeAll(waitForReady, readyTimeoutMs + 5000);

  it('logs in the super admin with its imported bcrypt password', async () => {
    const spec = specFor('importer-admin@test.example');
    const grant = await passwordGrant(spec.email, passwordFor(spec.email));
    expect(grant.access_token).toBeTruthy();
    const claims = decodeClaims(grant.access_token as string);
    expect(claims.groups).toEqual(['super-admins']);
  });

  it('maps non-super admin roles onto the admins group', async () => {
    const spec = specFor('limited-admin@test.example');
    const grant = await passwordGrant(spec.email, passwordFor(spec.email));
    expect(decodeClaims(grant.access_token as string).groups).toEqual(['admins']);
  });

  it('maps verified customers onto the customers group', async () => {
    const spec = specFor('customer@test.example');
    const grant = await passwordGrant(spec.email, passwordFor(spec.email));
    expect(decodeClaims(grant.access_token as string).groups).toEqual(['customers']);
  });

  it('unions groups when an email exists in both admin and customer tables', async () => {
    const spec = specFor('overlap-admin@test.example');
    const grant = await passwordGrant(spec.email, passwordFor(spec.email));
    const groups = decodeClaims(grant.access_token as string).groups ?? [];
    expect(groups).toContain('super-admins');
    expect(groups).toContain('customers');
    expect(groups).toHaveLength(2);
  });

  it('rejects a wrong password', async () => {
    const spec = specFor('importer-admin@test.example');
    const response = await fetch(`${baseUrl}/realms/${realm}/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: 'web',
        username: spec.email,
        password: `${passwordFor(spec.email)}-wrong`,
        scope: 'openid',
      }),
    });
    expect(response.status).toBe(400);
    const grant = (await response.json()) as TokenResponse;
    expect(grant.error).toBe('invalid_grant');
  });

  it('rejects disabled accounts (inactive admin)', async () => {
    const spec = specFor('inactive-admin@test.example');
    const response = await fetch(`${baseUrl}/realms/${realm}/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: 'web',
        username: spec.email,
        password: passwordFor(spec.email),
        scope: 'openid',
      }),
    });
    expect(response.status).toBe(400);
    const grant = (await response.json()) as TokenResponse;
    expect(grant.error).toBe('invalid_grant');
  });

  it('rejects blocked customers even with the correct password', async () => {
    const spec = specFor('blocked-customer@test.example');
    const response = await fetch(`${baseUrl}/realms/${realm}/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: 'web',
        username: spec.email,
        password: passwordFor(spec.email),
        scope: 'openid',
      }),
    });
    expect(response.status).toBe(400);
    const grant = (await response.json()) as TokenResponse;
    expect(grant.error).toBe('invalid_grant');
  });

  it('rejects unverified customers', async () => {
    const spec = specFor('unverified-customer@test.example');
    const response = await fetch(`${baseUrl}/realms/${realm}/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: 'web',
        username: spec.email,
        password: passwordFor(spec.email),
        scope: 'openid',
      }),
    });
    expect(response.status).toBe(400);
    const grant = (await response.json()) as TokenResponse;
    expect(grant.error).toBe('invalid_grant');
  });

  it('flags must-change-password accounts as not fully set up', async () => {
    const spec = specFor('must-change-admin@test.example');
    const response = await fetch(`${baseUrl}/realms/${realm}/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: 'web',
        username: spec.email,
        password: passwordFor(spec.email),
        scope: 'openid',
      }),
    });
    expect(response.status).toBe(400);
    const grant = (await response.json()) as TokenResponse;
    expect(grant.error).toBe('invalid_grant');
    expect(grant.error_description).toContain('Account is not fully set up');
  });

  it('rejects accounts imported from the dead hex+salt format (admin)', async () => {
    const spec = specFor('dead-admin@test.example');
    const response = await fetch(`${baseUrl}/realms/${realm}/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: 'web',
        username: spec.email,
        password: 'any-password',
        scope: 'openid',
      }),
    });
    expect(response.status).toBe(400);
    const grant = (await response.json()) as TokenResponse;
    expect(grant.error).toBe('invalid_grant');
  });

  it('rejects accounts imported from the dead hex+salt format (customer)', async () => {
    const spec = specFor('dead-customer@test.example');
    const response = await fetch(`${baseUrl}/realms/${realm}/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: 'web',
        username: spec.email,
        password: 'any-password',
        scope: 'openid',
      }),
    });
    expect(response.status).toBe(400);
    const grant = (await response.json()) as TokenResponse;
    expect(grant.error).toBe('invalid_grant');
  });

  it('rehashed the bcrypt credential to argon2 on first login', async () => {
    const mysqlConfig = readMysqlConfig();
    const connection = await mysql.createConnection({
      host: mysqlConfig.host,
      port: mysqlConfig.port,
      user: mysqlConfig.user,
      password: mysqlConfig.password,
      database: 'keycloak',
    });
    try {
      // Keycloak's DDL creates UPPERCASE table names (CREDENTIAL, USER_ENTITY,
      // ...) and MySQL is case-sensitive on Linux (lower_case_table_names=0):
      // table references AND qualifiers must stay uppercase here.
      const [rows] = await connection.query<RehashRow[]>(
        `SELECT
           JSON_UNQUOTE(JSON_EXTRACT(CREDENTIAL.CREDENTIAL_DATA, '$.algorithm')) AS algorithm,
           CREDENTIAL.SECRET_DATA AS secret
         FROM CREDENTIAL
         JOIN USER_ENTITY ON USER_ENTITY.ID = CREDENTIAL.USER_ID
         WHERE USER_ENTITY.EMAIL = ?`,
        ['importer-admin@test.example'],
      );
      expect(rows).toHaveLength(1);
      // Keycloak's default algorithm is argon2; the bcrypt import was rehashed
      // during the successful login above.
      expect(rows[0].algorithm).toBe('argon2');
      expect(rows[0].secret.startsWith('$2')).toBe(false);
    } finally {
      await connection.end();
    }
  });
});
