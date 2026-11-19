// User fixtures for the credential-import inttest. seed-test-db.ts writes them
// into a MySQL schema identical to the production dump, import-users.ts imports
// them into Keycloak, and test-credentials.ts asserts the login behavior.
//
// Passwords are generated per run and passed via IMPORT_TEST_PASSWORDS (JSON
// email -> password) so no credential is ever committed to the repo.

export interface TestAdminRole {
  readonly id: number;
  readonly name: string;
  readonly permissions: string;
}

/** Subset of the production `AdminRoles` table (verbatim rows). */
export const TEST_ADMIN_ROLES: readonly TestAdminRole[] = [
  { id: 2, name: 'Super Administrator', permissions: 'all' },
  { id: 4, name: 'Customer Support', permissions: 'customerSupport' },
  {
    id: 22,
    name: 'Student Administrator',
    permissions:
      'manageMediaSources,manageAutoDelete,manageApprovals,graphs,backendAnalyst,viewAuditLog,manageAdministrators,manageMediaTransfer,customerSupport',
  },
  { id: 23, name: 'IT Manager', permissions: 'backendAnalyst,graphs,customerSupport,viewAuditLog' },
];

export interface TestUserSpec {
  readonly email: string;
  readonly firstName: string;
  readonly lastName: string;
  /** Generate a password for this user (bcrypt-hashed at seed time). */
  readonly password: boolean;
  /** dc.Admins role id (FK to AdminRoles). */
  readonly adminRole?: number;
  /** Legacy dc.admins string role; seeded with the dead hex+salt format. */
  readonly legacyRole?: 'SuperAdmin' | 'Admin';
  /** Write a dc.users (customer) row. */
  readonly customer?: boolean;
  /** Write a dc.users row in addition to the dc.Admins row (email overlap). */
  readonly alsoCustomer?: boolean;
  /** dc.Admins.status = 'inactive' (imported disabled). */
  readonly inactive?: boolean;
  /** dc.users.blocked = 1 (imported disabled). */
  readonly blocked?: boolean;
  /** dc.users.isVerified = 0 (imported disabled). */
  readonly unverified?: boolean;
  /** mustChangePassword = 1 (imported with UPDATE_PASSWORD required action). */
  readonly mustChange?: boolean;
}

export const TEST_USERS: readonly TestUserSpec[] = [
  {
    email: 'importer-admin@test.example',
    firstName: 'Importer',
    lastName: 'Admin',
    password: true,
    adminRole: 2,
  },
  {
    email: 'limited-admin@test.example',
    firstName: 'Limited',
    lastName: 'Admin',
    password: true,
    adminRole: 22,
  },
  {
    email: 'inactive-admin@test.example',
    firstName: 'Inactive',
    lastName: 'Admin',
    password: true,
    adminRole: 2,
    inactive: true,
  },
  {
    email: 'must-change-admin@test.example',
    firstName: 'MustChange',
    lastName: 'Admin',
    password: true,
    adminRole: 23,
    mustChange: true,
  },
  {
    email: 'customer@test.example',
    firstName: 'Customer',
    lastName: 'User',
    password: true,
    customer: true,
  },
  {
    email: 'blocked-customer@test.example',
    firstName: 'Blocked',
    lastName: 'Customer',
    password: true,
    customer: true,
    blocked: true,
  },
  {
    email: 'unverified-customer@test.example',
    firstName: 'Unverified',
    lastName: 'Customer',
    password: true,
    customer: true,
    unverified: true,
  },
  {
    email: 'overlap-admin@test.example',
    firstName: 'Overlap',
    lastName: 'Admin',
    password: true,
    adminRole: 2,
    alsoCustomer: true,
  },
  {
    email: 'dead-admin@test.example',
    firstName: 'Dead',
    lastName: 'Admin',
    password: false,
    legacyRole: 'Admin',
  },
  {
    email: 'dead-customer@test.example',
    firstName: 'Dead',
    lastName: 'Customer',
    password: false,
    customer: true,
  },
];
