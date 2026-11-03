import { PERMISSIONS, type Permission } from './permissions.js';

export const ROLE_IDS = [
  'tenant_admin',
  'sre_duty',
  'dba',
  'container_platform',
  'network',
  'change_manager',
  'knowledge_admin',
  'auditor',
  'readonly_observer',
] as const;

export type RoleId = (typeof ROLE_IDS)[number];

export interface RoleTemplate {
  readonly id: RoleId;
  readonly name: string;
  readonly permissions: readonly Permission[];
}

const tenantAdminPermissions = PERMISSIONS.filter(
  (permission) => permission !== 'platform.admin',
);

export const ROLE_TEMPLATES: Record<RoleId, RoleTemplate> = {
  tenant_admin: {
    id: 'tenant_admin',
    name: '租户管理员',
    permissions: tenantAdminPermissions,
  },
  sre_duty: {
    id: 'sre_duty',
    name: '值班 SRE',
    permissions: [
      'session.create',
      'session.read.self',
      'scenario.run',
      'approval.decide',
      'incident.manage',
      'agent.manage',
      'task.manage',
    ],
  },
  dba: {
    id: 'dba',
    name: 'DBA',
    permissions: [
      'session.create',
      'session.read.self',
      'scenario.run',
      'approval.decide',
      'incident.manage',
    ],
  },
  container_platform: {
    id: 'container_platform',
    name: '容器平台',
    permissions: [
      'session.create',
      'session.read.self',
      'scenario.run',
      'approval.decide',
      'incident.manage',
    ],
  },
  network: {
    id: 'network',
    name: '网络',
    permissions: [
      'session.create',
      'session.read.self',
      'scenario.run',
      'approval.decide',
      'incident.manage',
    ],
  },
  change_manager: {
    id: 'change_manager',
    name: '变更经理',
    permissions: [
      'session.create',
      'session.read.self',
      'scenario.run',
      'approval.decide',
      'deployment.approve',
      'audit.read',
    ],
  },
  knowledge_admin: {
    id: 'knowledge_admin',
    name: '知识管理员',
    permissions: [
      'session.create',
      'session.read.self',
      'knowledge.review',
      'knowledge.publish',
      'audit.read',
    ],
  },
  auditor: {
    id: 'auditor',
    name: '审计员',
    permissions: ['audit.read', 'session.read.self'],
  },
  readonly_observer: {
    id: 'readonly_observer',
    name: '只读观察者',
    permissions: ['session.read.self'],
  },
};

export function isRoleId(value: string): value is RoleId {
  return (ROLE_IDS as readonly string[]).includes(value);
}

export function permissionsFor(roles: readonly RoleId[]): Permission[] {
  const seen = new Set<Permission>();
  const result: Permission[] = [];
  for (const role of roles) {
    for (const permission of ROLE_TEMPLATES[role].permissions) {
      if (!seen.has(permission)) {
        seen.add(permission);
        result.push(permission);
      }
    }
  }
  return result;
}
