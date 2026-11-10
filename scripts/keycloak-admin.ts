// Minimal Keycloak Admin REST API client — just enough to import users.
// Authenticates as the realm-independent bootstrap admin (master realm) with
// the admin-cli client's direct access grant.

export interface KeycloakAdminConfig {
  readonly baseUrl: string;
  readonly realm: string;
  readonly username: string;
  readonly password: string;
}

/** Import credential for the bcrypt SPI (JSON-encoded payloads, Keycloak format). */
export interface KeycloakCredential {
  readonly type: 'password';
  readonly secretData: string; // {"value":"<$2b$ hash>","salt":""}
  readonly credentialData: string; // {"algorithm":"bcrypt","hashIterations":<cost>}
}

export interface KeycloakUserDraft {
  readonly username: string;
  readonly email: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly enabled: boolean;
  readonly emailVerified: boolean;
  readonly requiredActions?: readonly string[];
  readonly credentials?: readonly KeycloakCredential[];
  readonly groups?: readonly string[];
}

export interface KeycloakUser {
  readonly id: string;
  readonly username: string;
  readonly email: string;
  readonly enabled: boolean;
}

interface TokenResponse {
  readonly access_token: string;
}

interface AdminResponse {
  readonly status: number;
  readonly body: unknown;
  readonly location: string | null;
}

export function readKeycloakAdminConfig(): KeycloakAdminConfig {
  const password = process.env.KC_ADMIN_PASSWORD;
  if (!password) {
    throw new Error('KC_ADMIN_PASSWORD is required');
  }
  const baseUrl = process.env.KC_URL ?? 'http://127.0.0.1:8080';
  return {
    baseUrl: baseUrl.replace(/\/$/, ''),
    realm: process.env.KC_REALM ?? 'digiclips',
    username: process.env.KC_ADMIN_USERNAME ?? 'kcadmin',
    password,
  };
}

export class KeycloakAdmin {
  private readonly config: KeycloakAdminConfig;
  private token: string | null = null;

  constructor(config: KeycloakAdminConfig) {
    this.config = config;
  }

  private async getToken(): Promise<string> {
    if (this.token != null) {
      return this.token;
    }
    const master = 'master';
    const response = await fetch(
      `${this.config.baseUrl}/realms/${master}/protocol/openid-connect/token`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'password',
          client_id: 'admin-cli',
          username: this.config.username,
          password: this.config.password,
        }),
      },
    );
    if (!response.ok) {
      throw new Error(`admin token request failed: ${response.status} ${await response.text()}`);
    }
    const parsed = (await response.json()) as TokenResponse;
    this.token = parsed.access_token;
    return this.token;
  }

  private async request(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body?: unknown,
  ): Promise<AdminResponse> {
    const send = async (token: string): Promise<Response> => {
      return fetch(`${this.config.baseUrl}/admin/realms/${this.config.realm}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    };
    let response = await send(await this.getToken());
    if (response.status === 401) {
      this.token = null;
      response = await send(await this.getToken());
    }
    const location = response.headers.get('location');
    const text = await response.text();
    let parsed: unknown = null;
    if (text !== '') {
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        parsed = text;
      }
    }
    return { status: response.status, body: parsed, location };
  }

  private assertOk(response: AdminResponse, action: string): void {
    if (response.status >= 400) {
      throw new Error(`Keycloak ${action} failed: ${response.status} ${JSON.stringify(response.body)}`);
    }
  }

  async findUserByEmail(email: string): Promise<KeycloakUser | null> {
    const response = await this.request(
      'GET',
      `/users?email=${encodeURIComponent(email)}&exact=true`,
    );
    this.assertOk(response, 'user lookup');
    const users = (response.body as KeycloakUser[] | null) ?? [];
    return users.find((user) => user.email.toLowerCase() === email.toLowerCase()) ?? null;
  }

  async findUserByUsername(username: string): Promise<KeycloakUser | null> {
    const response = await this.request(
      'GET',
      `/users?username=${encodeURIComponent(username)}&exact=true`,
    );
    this.assertOk(response, 'user lookup');
    const users = (response.body as KeycloakUser[] | null) ?? [];
    return users.find((user) => user.username.toLowerCase() === username.toLowerCase()) ?? null;
  }

  private async resolveGroupId(name: string): Promise<string> {
    const response = await this.request('GET', '/groups');
    this.assertOk(response, 'group lookup');
    const groups = (response.body as ReadonlyArray<{ id: string; name: string }> | null) ?? [];
    const group = groups.find((entry) => entry.name === name);
    if (group == null) {
      throw new Error(`Keycloak group "${name}" does not exist in realm ${this.config.realm}`);
    }
    return group.id;
  }

  async addUserToGroup(userId: string, groupName: string): Promise<void> {
    const groupId = await this.resolveGroupId(groupName);
    const response = await this.request('PUT', `/users/${userId}/groups/${groupId}`);
    this.assertOk(response, `group membership (${groupName})`);
  }

  async createUser(draft: KeycloakUserDraft, groups: readonly string[]): Promise<KeycloakUser> {
    const representation = {
      username: draft.username,
      email: draft.email,
      firstName: draft.firstName,
      lastName: draft.lastName,
      enabled: draft.enabled,
      emailVerified: draft.emailVerified,
      ...(draft.requiredActions === undefined ? {} : { requiredActions: [...draft.requiredActions] }),
      ...(draft.credentials === undefined ? {} : { credentials: [...draft.credentials] }),
      groups: [...groups],
    };
    const response = await this.request('POST', '/users', representation);
    this.assertOk(response, 'user creation');
    if (response.location == null) {
      throw new Error(`Keycloak user creation returned no Location header for ${draft.email}`);
    }
    const id = response.location.split('/').pop() ?? '';
    return { id, username: draft.username, email: draft.email, enabled: draft.enabled };
  }

  async updateUser(
    userId: string,
    patch: { readonly enabled: boolean; readonly requiredActions: readonly string[] },
  ): Promise<void> {
    const response = await this.request('PUT', `/users/${userId}`, {
      enabled: patch.enabled,
      requiredActions: [...patch.requiredActions],
    });
    this.assertOk(response, 'user update');
  }

  /**
   * Create the user, or align an existing one with the imported state.
   * Existing users never gain a hashed credential (the Admin API only accepts
   * verifiable credentials at creation); their recovery path is Keycloak's
   * own password reset.
   */
  async ensureUser(
    draft: KeycloakUserDraft,
    groups: readonly string[],
  ): Promise<'created' | 'updated'> {
    const existing = draft.email === ''
      ? await this.findUserByUsername(draft.username)
      : await this.findUserByEmail(draft.email);
    if (existing == null) {
      await this.createUser(draft, groups);
      return 'created';
    }
    await this.updateUser(existing.id, {
      enabled: draft.enabled,
      requiredActions: draft.requiredActions ?? [],
    });
    for (const group of groups) {
      await this.addUserToGroup(existing.id, group);
    }
    return 'updated';
  }
}
