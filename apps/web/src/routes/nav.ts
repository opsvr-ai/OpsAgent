export type DesignNav =
  | 'home'
  | 'chat'
  | 'faults'
  | 'topology'
  | 'incidents'
  | 'deployments'
  | 'scenarios'
  | 'approvals'
  | 'connectors'
  | 'knowledge'
  | 'messages'
  | 'agents'
  | 'skills'
  | 'tasks'
  | 'sessions'
  | 'members'
  | 'models'
  | 'data'
  | 'appearance'
  | 'shares'
  | 'studio'
  | 'audit'
  | 'help';

export const NAV: Array<{ id: DesignNav; label: string; icon: string }> = [
  { id: 'home', label: '工作台', icon: 'grid' },
  { id: 'chat', label: '智能体会话', icon: 'message' },
  { id: 'faults', label: '故障定界', icon: 'activity' },
  { id: 'topology', label: '访问拓扑', icon: 'activity' },
  { id: 'incidents', label: '事件指挥', icon: 'activity' },
  { id: 'deployments', label: '发布与部署', icon: 'bolt' },
  { id: 'approvals', label: '待审批', icon: 'check' },
  { id: 'connectors', label: '集成与连接器', icon: 'plug' },
  { id: 'knowledge', label: '知识中心', icon: 'book' },
  { id: 'messages', label: '消息中心', icon: 'bell' },
  { id: 'agents', label: '操作系统智能体', icon: 'server' },
  { id: 'skills', label: '运维技能', icon: 'book' },
  { id: 'tasks', label: '长任务', icon: 'clock' },
  { id: 'sessions', label: '会话历史', icon: 'message' },
  { id: 'members', label: '成员与角色', icon: 'users' },
  { id: 'models', label: '模型配置', icon: 'shield' },
  { id: 'data', label: '数据沉淀', icon: 'database' },
  { id: 'appearance', label: '外观与主题', icon: 'sun' },
  { id: 'scenarios', label: '场景中心', icon: 'bolt' },
  { id: 'shares', label: '共享审批', icon: 'share' },
  { id: 'studio', label: '创造模式', icon: 'wand' },
  { id: 'audit', label: '审计', icon: 'shield' },
  { id: 'help', label: '用户手册', icon: 'book' },
];
