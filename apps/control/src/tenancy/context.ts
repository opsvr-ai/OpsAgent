import {
  isRoleId,
  permissionsFor,
  type Permission,
  type RoleId,
} from '@opsagent/contracts';

export interface Membership {
  readonly roles: readonly RoleId[];
  readonly isPlatformAdmin: boolean;
}

export interface MembershipRepository {
  findMembership(userId: string, tenantId: string): Promise<Membership | null>;
}

export interface ResolveTenantInput {
  readonly userId: string;
  readonly tenantId: string;
  readonly roleView?: string;
}

export interface TenantContext {
  readonly userId: string;
  readonly tenantId: string;
  readonly roles: readonly RoleId[];
  readonly permissions: ReadonlySet<Permission>;
  readonly isPlatformAdmin: boolean;
  readonly roleView: string;
}

export class TenantAccessDeniedError extends Error {
  readonly code = 'tenant.access.denied';

  constructor() {
    super('tenant access denied');
    this.name = 'TenantAccessDeniedError';
  }
}

export async function resolveTenantContext(
  input: ResolveTenantInput,
  repo: MembershipRepository,
): Promise<TenantContext> {
  const membership = await repo.findMembership(input.userId, input.tenantId);
  if (!membership) throw new TenantAccessDeniedError();
  if (membership.isPlatformAdmin && membership.roles.length === 0) {
    throw new TenantAccessDeniedError();
  }

  const roles = [...membership.roles];
  if (!roles.every(isRoleId)) {
    throw new TenantAccessDeniedError();
  }

  const permissions = new Set(permissionsFor(roles));
  return {
    userId: input.userId,
    tenantId: input.tenantId,
    roles,
    permissions,
    isPlatformAdmin: membership.isPlatformAdmin,
    roleView: input.roleView ?? roles[0] ?? 'readonly_observer',
  };
}
