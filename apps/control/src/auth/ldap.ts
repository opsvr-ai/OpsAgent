import { Client } from 'ldapts';

export interface LdapUser {
  readonly username: string;
  readonly displayName: string;
  readonly email: string | null;
  readonly dn: string;
}

export interface LdapAuthenticator {
  authenticate(username: string, password: string): Promise<LdapUser | null>;
}

export interface LdapConfig {
  readonly url: string;
  readonly bindDn: string;
  readonly bindPassword: string;
  readonly baseDn: string;
  readonly userFilter?: string;
}

function escapeFilter(value: string): string {
  return value.replace(/[\\*()\0]/g, (character) => {
    const hex = character.charCodeAt(0).toString(16).padStart(2, '0');
    return `\\${hex}`;
  });
}

function firstString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return null;
}

export function createLdapAuthenticator(config: LdapConfig): LdapAuthenticator {
  return {
    async authenticate(username, password) {
      if (!username || !password) return null;

      const service = new Client({ url: config.url });
      let userDn: string;
      let entry: Record<string, unknown>;
      try {
        await service.bind(config.bindDn, config.bindPassword);
        const filter =
          config.userFilter ??
          `(|(uid=${escapeFilter(username)})(sAMAccountName=${escapeFilter(username)}))`;
        const result = await service.search(config.baseDn, {
          filter,
          scope: 'sub',
          attributes: ['dn', 'cn', 'displayName', 'mail', 'uid', 'sAMAccountName'],
          sizeLimit: 2,
        });
        const found = result.searchEntries[0];
        if (!found || typeof found.dn !== 'string') return null;
        userDn = found.dn;
        entry = found as Record<string, unknown>;
      } finally {
        await service.unbind().catch(() => undefined);
      }

      const userClient = new Client({ url: config.url });
      try {
        await userClient.bind(userDn, password);
      } catch {
        return null;
      } finally {
        await userClient.unbind().catch(() => undefined);
      }

      return {
        username,
        displayName:
          firstString(entry.displayName) ??
          firstString(entry.cn) ??
          username,
        email: firstString(entry.mail),
        dn: userDn,
      };
    },
  };
}
