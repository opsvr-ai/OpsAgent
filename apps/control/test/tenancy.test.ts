import { describe, expect, it } from 'vitest';
import {
  TenantAccessDeniedError,
  resolveTenantContext,
  type MembershipRepository,
} from '../src/tenancy/context.js';
import { ForbiddenError, requirePermission } from '../src/tenancy/guards.js';

const repo: MembershipRepository = {
  async findMembership(userId, tenantId) {
    if (userId === 'u-sre-dba' && tenantId === 't-1') {
      return { roles: ['sre_duty', 'dba'], isPlatformAdmin: false };
    }
    if (userId === 'u-admin' && tenantId === 't-1') {
      return { roles: ['tenant_admin'], isPlatformAdmin: false };
    }
    if (userId === 'u-platform' && tenantId === 't-1') {
      return { roles: [], isPlatformAdmin: true };
    }
    return null;
  },
};

describe('tenant context', () => {
  it('unions multi-role permissions', async () => {
    const ctx = await resolveTenantContext(
      { userId: 'u-sre-dba', tenantId: 't-1', roleView: 'sre_duty' },
      repo,
    );

    expect(ctx.roles).toEqual(['sre_duty', 'dba']);
    expect(ctx.permissions.has('session.create')).toBe(true);
    expect(ctx.permissions.has('scenario.run')).toBe(true);
  });

  it('does not let a role view reduce or expand the security context', async () => {
    const ctx = await resolveTenantContext(
      { userId: 'u-sre-dba', tenantId: 't-1', roleView: 'readonly_observer' },
      repo,
    );

    expect(ctx.permissions.has('session.create')).toBe(true);
    expect(ctx.roleView).toBe('readonly_observer');
  });

  it('rejects a non-member, including a platform admin without membership', async () => {
    await expect(
      resolveTenantContext({ userId: 'u-platform', tenantId: 't-1' }, repo),
    ).rejects.toBeInstanceOf(TenantAccessDeniedError);
  });

  it('requires a specific permission', async () => {
    const ctx = await resolveTenantContext(
      { userId: 'u-sre-dba', tenantId: 't-1' },
      repo,
    );
    expect(() => requirePermission(ctx, 'connector.configure')).toThrow(ForbiddenError);
    expect(() => requirePermission(ctx, 'session.create')).not.toThrow();
  });
});
