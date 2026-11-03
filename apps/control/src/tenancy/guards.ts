import type { Permission } from '@opsagent/contracts';
import type { TenantContext } from './context.js';

export class ForbiddenError extends Error {
  readonly code = 'forbidden';

  constructor(readonly permission: Permission) {
    super(`missing permission: ${permission}`);
    this.name = 'ForbiddenError';
  }
}

export function requirePermission(ctx: TenantContext, permission: Permission): void {
  if (!ctx.permissions.has(permission)) {
    throw new ForbiddenError(permission);
  }
}

export function requireTenantAdmin(ctx: TenantContext): void {
  if (!ctx.roles.includes('tenant_admin')) {
    throw new ForbiddenError('tenant.member.manage');
  }
}

export function requirePlatformAdmin(ctx: TenantContext): void {
  if (!ctx.isPlatformAdmin) {
    throw new ForbiddenError('platform.admin');
  }
}
