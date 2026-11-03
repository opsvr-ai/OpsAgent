export const PERMISSIONS = [
  'tenant.member.manage',
  'connector.configure',
  'connector.authorize',
  'scenario.publish',
  'scenario.run',
  'approval.decide',
  'knowledge.review',
  'knowledge.publish',
  'audit.read',
  'session.create',
  'session.read.self',
  'incident.manage',
  'agent.manage',
  'deployment.approve',
  'message.manage',
  'task.manage',
  'model.configure',
  'catalog.manage',
  'platform.admin',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value);
}
