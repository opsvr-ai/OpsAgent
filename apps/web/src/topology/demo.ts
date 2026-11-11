/**
 * 访问拓扑 V2 演示数据（?demo=topology）。
 *
 * 3 个业务系统 / 13 台纳管主机 + 2 个外部 IP，覆盖：
 * Nginx、Spring Boot、MySQL、Redis、Kafka、Nacos、Prometheus、Zabbix、Filebeat，
 * 以及一台同时跑 Nginx 与业务进程的多角色主机。默认不含未归属主机。
 */
import type {
  TopologyEdge,
  TopologyGraph,
  TopologyGraphSummary,
  TopologyLearningPolicy,
  TopologyLearningSession,
  TopologyNode,
  TopologyNodeKind,
  TopologyNodeMetrics,
  TopologyNodeStatus,
  TopologyServicePort,
  TopologySystemGroup,
  TopologyTier,
} from '@opsagent/contracts';

const NOW = Date.now();
const iso = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString();

export interface DemoAppSystemOption {
  readonly id: string;
  readonly name: string;
}

export const DEMO_APP_SYSTEMS: readonly DemoAppSystemOption[] = [
  { id: 'sys-portal', name: '平台门户' },
  { id: 'sys-order', name: '订单中心' },
  { id: 'sys-pay', name: '支付中心' },
];

const APP_SYSTEM_NAME = new Map(DEMO_APP_SYSTEMS.map((item) => [item.id, item.name]));

interface NodeSpec {
  readonly id: string;
  readonly label: string;
  readonly kind: TopologyNodeKind;
  readonly tier: TopologyTier;
  readonly hostname: string;
  readonly ip: string;
  readonly appSystemId?: string;
  readonly status: TopologyNodeStatus;
  readonly product: string;
  readonly role: string;
  readonly systemService?: boolean;
  readonly services: readonly TopologyServicePort[];
  readonly anomalies?: readonly string[];
  readonly inferred?: boolean;
  readonly note?: string;
  readonly metrics?: Partial<TopologyNodeMetrics>;
}

const svc = (name: string, port: number, process?: string): TopologyServicePort =>
  process ? { name, port, process } : { name, port };

const NODE_SPECS: readonly NodeSpec[] = [
  // ---- 平台门户 --------------------------------------------------------
  {
    id: 'gw-edge-01',
    label: 'edge-gw-01',
    kind: 'gateway',
    tier: 'access',
    hostname: 'edge-gw-01',
    ip: '10.20.1.11',
    appSystemId: 'sys-portal',
    status: 'online',
    product: 'Nginx',
    role: '接入网关',
    services: [svc('nginx', 443, 'nginx'), svc('nginx', 80, 'nginx')],
    metrics: { inbound: 5240 },
  },
  {
    id: 'portal-web-01',
    label: 'portal-web-01',
    kind: 'service',
    tier: 'app',
    hostname: 'portal-web-01',
    ip: '10.30.0.21',
    appSystemId: 'sys-portal',
    status: 'online',
    product: 'Nginx',
    role: '门户前端',
    services: [svc('nginx', 443, 'nginx'), svc('portal-web', 8080, 'java')],
  },
  {
    id: 'monitor-01',
    label: 'monitor-01',
    kind: 'monitoring',
    tier: 'ops',
    hostname: 'monitor-01',
    ip: '10.60.0.11',
    appSystemId: 'sys-portal',
    status: 'online',
    product: 'Prometheus',
    role: '监控采集',
    systemService: true,
    services: [svc('prometheus', 9090, 'prometheus'), svc('node_exporter', 9100, 'node_exporter')],
  },
  {
    id: 'zabbix-01',
    label: 'zabbix-01',
    kind: 'monitoring',
    tier: 'ops',
    hostname: 'zabbix-01',
    ip: '10.60.0.12',
    appSystemId: 'sys-portal',
    status: 'online',
    product: 'Zabbix',
    role: '监控告警',
    systemService: true,
    services: [svc('zabbix-agent', 10050, 'zabbix_agentd'), svc('zabbix-server', 10051, 'zabbix_server')],
  },
  // ---- 订单中心 --------------------------------------------------------
  {
    id: 'order-api-01',
    label: 'order-api-01',
    kind: 'service',
    tier: 'app',
    hostname: 'order-api-01',
    ip: '10.30.1.21',
    appSystemId: 'sys-order',
    status: 'online',
    product: 'Spring Boot',
    role: '订单服务 API',
    services: [svc('order-api', 8080, 'java'), svc('metrics', 9100)],
  },
  {
    id: 'order-api-02',
    label: 'order-api-02',
    kind: 'service',
    tier: 'app',
    hostname: 'order-api-02',
    ip: '10.30.1.22',
    appSystemId: 'sys-order',
    status: 'online',
    product: 'Spring Boot',
    role: '订单服务 API',
    services: [svc('order-api', 8080, 'java'), svc('metrics', 9100)],
    anomalies: ['Redis 建连失败率 9.4%', 'CPU 使用率 88% 持续 5 分钟'],
  },
  {
    id: 'order-job-01',
    label: 'order-job-01',
    kind: 'service',
    tier: 'app',
    hostname: 'order-job-01',
    ip: '10.30.1.41',
    appSystemId: 'sys-order',
    status: 'online',
    product: 'XXL-Job',
    role: '对账作业',
    services: [svc('order-worker', 9090, 'java')],
  },
  {
    id: 'redis-order-01',
    label: 'redis-order-01',
    kind: 'cache',
    tier: 'middleware',
    hostname: 'redis-order-01',
    ip: '10.40.1.11',
    appSystemId: 'sys-order',
    status: 'online',
    product: 'Redis',
    role: '缓存集群',
    services: [svc('redis', 6379, 'redis-server'), svc('sentinel', 26379)],
    anomalies: ['连接数接近上限 92%'],
  },
  {
    id: 'kafka-order-01',
    label: 'kafka-order-01',
    kind: 'mq',
    tier: 'middleware',
    hostname: 'kafka-order-01',
    ip: '10.40.2.21',
    appSystemId: 'sys-order',
    status: 'online',
    product: 'Kafka',
    role: '消息队列',
    services: [svc('kafka', 9092, 'java'), svc('kafka-exporter', 9308)],
  },
  {
    id: 'mysql-order-01',
    label: 'mysql-order-01',
    kind: 'database',
    tier: 'data',
    hostname: 'mysql-order-01',
    ip: '10.50.1.11',
    appSystemId: 'sys-order',
    status: 'online',
    product: 'MySQL',
    role: '关系型数据库',
    services: [svc('mysql', 3306, 'mysqld')],
  },
  // ---- 支付中心 --------------------------------------------------------
  {
    id: 'pay-api-01',
    label: 'pay-api-01',
    kind: 'service',
    tier: 'app',
    hostname: 'pay-api-01',
    ip: '10.30.2.31',
    appSystemId: 'sys-pay',
    status: 'online',
    product: 'Spring Boot',
    role: '收单 API',
    services: [svc('pay-api', 8443, 'java'), svc('pay-admin', 8444)],
    anomalies: ['回调失败率 8.1%'],
  },
  {
    id: 'nacos-pay-01',
    label: 'nacos-pay-01',
    kind: 'registry',
    tier: 'middleware',
    hostname: 'nacos-pay-01',
    ip: '10.40.3.11',
    appSystemId: 'sys-pay',
    status: 'online',
    product: 'Nacos',
    role: '注册中心',
    services: [svc('nacos', 8848, 'java')],
  },
  {
    id: 'mysql-pay-01',
    label: 'mysql-pay-01',
    kind: 'database',
    tier: 'data',
    hostname: 'mysql-pay-01',
    ip: '10.50.2.11',
    appSystemId: 'sys-pay',
    status: 'online',
    product: 'MySQL',
    role: '关系型数据库',
    services: [svc('mysql', 3306, 'mysqld')],
    anomalies: ['主从延迟 1.8s 超出阈值'],
  },
  {
    id: 'log-pay-01',
    label: 'log-pay-01',
    kind: 'logging',
    tier: 'ops',
    hostname: 'log-pay-01',
    ip: '10.60.1.11',
    appSystemId: 'sys-pay',
    status: 'online',
    product: 'Filebeat',
    role: '日志采集',
    systemService: true,
    services: [svc('filebeat', 5066, 'filebeat'), svc('logstash', 5044, 'java')],
  },
  // ---- 外部依赖 --------------------------------------------------------
  {
    id: 'ext-alipay',
    label: '支付宝开放平台',
    kind: 'external',
    tier: 'external',
    hostname: 'openapi.alipay.com',
    ip: '203.0.113.24',
    status: 'unknown',
    product: 'Alipay OpenAPI',
    role: '支付渠道',
    services: [svc('https', 443)],
    inferred: true,
    note: '模型从外部出口 IP 与访问域名推断。',
  },
  {
    id: 'ext-sms',
    label: '短信服务商',
    kind: 'external',
    tier: 'external',
    hostname: 'sms-vendor.cn',
    ip: '203.0.113.36',
    status: 'unknown',
    product: 'SMS Gateway',
    role: '短信通道',
    services: [svc('https', 443), svc('http', 8080)],
    inferred: true,
    note: '模型从外部出口 IP 推断。',
  },
];

interface EdgeSpec {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly port: number;
  readonly protocol: string;
  readonly count: number;
  readonly opened?: number;
  readonly failed?: number;
  readonly processes?: readonly string[];
  readonly external?: boolean;
}

const EDGE_SPECS: readonly EdgeSpec[] = [
  // 接入 → 应用
  { id: 'e01', source: 'gw-edge-01', target: 'portal-web-01', port: 443, protocol: 'https', count: 2260, opened: 3120, processes: ['nginx'] },
  { id: 'e02', source: 'gw-edge-01', target: 'portal-web-01', port: 8080, protocol: 'http', count: 640, opened: 880, processes: ['nginx'] },
  { id: 'e03', source: 'gw-edge-01', target: 'order-api-01', port: 8080, protocol: 'http', count: 1420, opened: 1980, processes: ['nginx'] },
  { id: 'e04', source: 'gw-edge-01', target: 'order-api-02', port: 8080, protocol: 'http', count: 1180, opened: 1640, processes: ['nginx'] },
  { id: 'e05', source: 'gw-edge-01', target: 'order-api-01', port: 8080, protocol: 'http', count: 860, opened: 1210, processes: ['nginx'] },
  { id: 'e06', source: 'gw-edge-01', target: 'pay-api-01', port: 8443, protocol: 'https', count: 520, opened: 760, processes: ['nginx'] },
  // 门户 → 应用 / 中间件
  { id: 'e07', source: 'portal-web-01', target: 'order-api-01', port: 8080, protocol: 'http', count: 720, opened: 980, processes: ['portal-web'] },
  { id: 'e08', source: 'portal-web-01', target: 'order-api-02', port: 8080, protocol: 'http', count: 610, opened: 860, processes: ['portal-web'] },
  { id: 'e09', source: 'portal-web-01', target: 'pay-api-01', port: 8443, protocol: 'https', count: 380, opened: 520, processes: ['portal-web'] },
  { id: 'e10', source: 'portal-web-01', target: 'redis-order-01', port: 6379, protocol: 'tcp', count: 880, opened: 1120, failed: 12, processes: ['portal-web'] },
  // 订单 → 中间件 / 数据
  { id: 'e11', source: 'order-api-01', target: 'redis-order-01', port: 6379, protocol: 'tcp', count: 2140, opened: 2860, failed: 9, processes: ['order-api'] },
  { id: 'e12', source: 'order-api-01', target: 'redis-order-01', port: 26379, protocol: 'tcp', count: 120, opened: 160, processes: ['order-api'] },
  { id: 'e13', source: 'order-api-02', target: 'redis-order-01', port: 6379, protocol: 'tcp', count: 1980, opened: 2640, failed: 186, processes: ['order-api'] },
  { id: 'e14', source: 'order-api-01', target: 'mysql-order-01', port: 3306, protocol: 'mysql', count: 1640, opened: 2210, failed: 4, processes: ['order-api'] },
  { id: 'e15', source: 'order-api-02', target: 'mysql-order-01', port: 3306, protocol: 'mysql', count: 1520, opened: 2050, failed: 34, processes: ['order-api'] },
  { id: 'e16', source: 'order-api-01', target: 'kafka-order-01', port: 9092, protocol: 'kafka', count: 540, opened: 720, processes: ['order-api'] },
  { id: 'e17', source: 'order-api-02', target: 'kafka-order-01', port: 9092, protocol: 'kafka', count: 480, opened: 640, processes: ['order-api'] },
  { id: 'e18', source: 'order-job-01', target: 'mysql-order-01', port: 3306, protocol: 'mysql', count: 420, opened: 560, processes: ['order-worker'] },
  { id: 'e19', source: 'order-job-01', target: 'redis-order-01', port: 6379, protocol: 'tcp', count: 610, opened: 820, failed: 8, processes: ['order-worker'] },
  { id: 'e20', source: 'order-job-01', target: 'kafka-order-01', port: 9092, protocol: 'kafka', count: 380, opened: 510, processes: ['order-worker'] },
  // 订单 → 支付（跨系统）
  { id: 'e21', source: 'order-api-01', target: 'pay-api-01', port: 8443, protocol: 'https', count: 940, opened: 1260, failed: 18, processes: ['order-api'] },
  { id: 'e22', source: 'order-api-02', target: 'pay-api-01', port: 8443, protocol: 'https', count: 820, opened: 1120, failed: 42, processes: ['order-api'] },
  { id: 'e23', source: 'order-job-01', target: 'pay-api-01', port: 8443, protocol: 'https', count: 160, opened: 220, failed: 6, processes: ['order-worker'] },
  // 支付 → 中间件 / 数据 / 外部
  { id: 'e24', source: 'pay-api-01', target: 'mysql-pay-01', port: 3306, protocol: 'mysql', count: 1320, opened: 1780, failed: 7, processes: ['pay-api'] },
  { id: 'e25', source: 'pay-api-01', target: 'nacos-pay-01', port: 8848, protocol: 'http', count: 760, opened: 1010, processes: ['pay-api'] },
  { id: 'e26', source: 'pay-api-01', target: 'kafka-order-01', port: 9092, protocol: 'kafka', count: 240, opened: 320, failed: 11, processes: ['pay-api'] },
  { id: 'e27', source: 'pay-api-01', target: 'ext-alipay', port: 443, protocol: 'https', count: 460, opened: 610, failed: 14, processes: ['pay-api'], external: true },
  { id: 'e28', source: 'pay-api-01', target: 'ext-alipay', port: 8443, protocol: 'https', count: 90, opened: 120, failed: 6, processes: ['pay-api'], external: true },
  { id: 'e29', source: 'log-pay-01', target: 'kafka-order-01', port: 9092, protocol: 'kafka', count: 520, opened: 690, processes: ['filebeat'] },
  { id: 'e30', source: 'portal-web-01', target: 'ext-sms', port: 443, protocol: 'https', count: 180, opened: 240, failed: 2, processes: ['portal-web'], external: true },
  // 支付回调（反向跨系统）
  { id: 'e31', source: 'pay-api-01', target: 'order-api-01', port: 8080, protocol: 'http', count: 310, opened: 430, failed: 26, processes: ['pay-api'] },
  { id: 'e32', source: 'pay-api-01', target: 'order-api-02', port: 8080, protocol: 'http', count: 190, opened: 270, failed: 22, processes: ['pay-api'] },
  // 运维观测采集
  { id: 'e33', source: 'monitor-01', target: 'gw-edge-01', port: 9100, protocol: 'http', count: 610, opened: 620, processes: ['node_exporter'] },
  { id: 'e34', source: 'monitor-01', target: 'order-api-01', port: 9100, protocol: 'http', count: 580, opened: 590, processes: ['node_exporter'] },
  { id: 'e35', source: 'monitor-01', target: 'pay-api-01', port: 9100, protocol: 'http', count: 540, opened: 550, processes: ['node_exporter'] },
  { id: 'e36', source: 'monitor-01', target: 'mysql-order-01', port: 9100, protocol: 'http', count: 320, opened: 330, processes: ['node_exporter'] },
  { id: 'e37', source: 'zabbix-01', target: 'order-job-01', port: 10050, protocol: 'tcp', count: 120, opened: 130, processes: ['zabbix_agentd'] },
  { id: 'e38', source: 'zabbix-01', target: 'redis-order-01', port: 10050, protocol: 'tcp', count: 110, opened: 120, processes: ['zabbix_agentd'] },
  { id: 'e39', source: 'zabbix-01', target: 'log-pay-01', port: 10050, protocol: 'tcp', count: 90, opened: 100, processes: ['zabbix_agentd'] },
  // 应用 → 运维观测 / 注册中心
  { id: 'e40', source: 'order-api-01', target: 'nacos-pay-01', port: 8848, protocol: 'http', count: 260, opened: 340, processes: ['order-api'] },
  { id: 'e41', source: 'order-api-02', target: 'nacos-pay-01', port: 8848, protocol: 'http', count: 240, opened: 320, failed: 9, processes: ['order-api'] },
  { id: 'e42', source: 'gw-edge-01', target: 'zabbix-01', port: 10051, protocol: 'tcp', count: 60, opened: 70, processes: ['nginx'] },
];

interface GraphVersionConfig {
  readonly version: number;
  readonly ageMinutes: number;
  readonly factor: number;
  readonly summary: string;
}

const BASE_SUMMARY =
  '大模型基于 Agent 采集的端口、进程与建连证据识别出 14 台纳管主机、3 个业务系统（平台门户 / 订单中心 / 支付中心）与 2 个外部依赖。' +
  '分层结果为 1 台接入网关、5 个应用服务、4 个中间件/注册中心、3 个数据库、4 个运维观测服务；' +
  '订单中心 → 支付中心跨系统调用 1,760 次，支付回调失败率 8.1%，订单服务访问 Redis 失败 186 次，是当前最明确的风险信号。';

const INSIGHTS = (factor: number) => [
  {
    id: 'ins-1',
    title: '支付回调链路失败率 8.1%',
    detail: 'pay-api-01 → order-api-01/02 的回调请求在一个窗口内失败 48 次，集中在 14:02–14:11，疑似订单侧连接池打满。',
    severity: 'critical' as const,
    nodeIds: ['pay-api-01', 'order-api-01', 'order-api-02'],
    edgeIds: ['e31', 'e32'],
  },
  {
    id: 'ins-2',
    title: '订单服务访问 Redis 有 186 次失败',
    detail: 'order-api-02 → redis-order-01:6379 失败率 9.4%，同时 Redis 连接数已达上限的 92%，建议核查连接池与超时配置。',
    severity: 'warning' as const,
    nodeIds: ['order-api-02', 'redis-order-01'],
    edgeIds: ['e13'],
  },
  {
    id: 'ins-3',
    title: '跨系统同步调用缺少熔断',
    detail: '订单中心 → 支付中心在窗口内发起 2,230 次同步调用，未观测到重试退避；任一侧抖动都会直接放大到用户端。',
    severity: 'warning' as const,
    nodeIds: ['order-api-01', 'order-api-02', 'pay-api-01'],
    edgeIds: ['e21', 'e22'],
  },
  {
    id: 'ins-4',
    title: `接入层流量 ${Math.round(62 * factor)}% 落在 edge-gw-01`,
    detail: 'Nginx 接入网关承担 6,840 并发连接，订单与门户入口共用同一实例，建议拆分入口或做多活。',
    severity: 'info' as const,
    nodeIds: ['gw-edge-01'],
    edgeIds: ['e01', 'e03', 'e04'],
  },
  {
    id: 'ins-5',
    title: '外部依赖收敛为两个出口 IP',
    detail: '支付中心访问支付宝 550 次、门户访问短信服务商 180 次，均通过单一出口 IP，外部依赖故障会影响全部支付与通知。',
    severity: 'info' as const,
    nodeIds: ['ext-alipay', 'ext-sms'],
    edgeIds: ['e27', 'e28', 'e30'],
  },
];

const RISKS = [
  {
    id: 'risk-1',
    title: '同步跨系统调用无熔断 / 退避',
    detail: '订单 → 支付双向链路失败会直接回传给用户请求，建议补上超时、重试预算与熔断阈值。',
    severity: 'critical' as const,
    nodeIds: ['order-api-01', 'order-api-02', 'pay-api-01'],
    edgeIds: ['e21', 'e22', 'e31', 'e32'],
  },
  {
    id: 'risk-2',
    title: '共享 Redis 出现跨系统读写',
    detail: '支付中心与平台门户直接读写订单 Redis 集群，故障域与权限边界不清晰。',
    severity: 'warning' as const,
    nodeIds: ['redis-order-01', 'pay-api-01', 'portal-web-01'],
    edgeIds: ['e10', 'e26'],
  },
  {
    id: 'risk-3',
    title: '外部依赖单点出口',
    detail: '支付宝与短信服务商均只有 1 个可见出口 IP，缺少备用通道与降级开关。',
    severity: 'warning' as const,
    nodeIds: ['ext-alipay', 'ext-sms'],
    edgeIds: ['e27', 'e30'],
  },
];

const HOT_PATHS = (factor: number) => [
  {
    label: '下单主链路：网关 → 订单服务 → MySQL',
    nodeIds: ['gw-edge-01', 'order-api-01', 'mysql-order-01'],
    edgeIds: ['e03', 'e14'],
    connections: Math.round(5200 * factor),
  },
  {
    label: '支付收单链路：网关 → 支付服务 → 支付宝',
    nodeIds: ['gw-edge-01', 'pay-api-01', 'ext-alipay'],
    edgeIds: ['e06', 'e27'],
    connections: Math.round(2300 * factor),
  },
  {
    label: '门户首页：网关 → 门户服务 → Redis',
    nodeIds: ['gw-edge-01', 'portal-web-01', 'redis-order-01'],
    edgeIds: ['e01', 'e10'],
    connections: Math.round(2680 * factor),
  },
];

function computeMetrics(nodeId: string, edges: readonly TopologyEdge[]): TopologyNodeMetrics {
  let inbound = 0;
  let outbound = 0;
  let opened = 0;
  let failed = 0;
  let count = 0;
  for (const edge of edges) {
    if (edge.source === nodeId) {
      outbound += edge.count;
      opened += edge.opened;
      failed += edge.failed;
      count += edge.count;
    }
    if (edge.target === nodeId) {
      inbound += edge.count;
      opened += edge.opened;
      failed += edge.failed;
      count += edge.count;
    }
  }
  const active = Math.max(1, Math.round(count * 0.18));
  return { active, opened: Math.max(opened, active), closed: Math.max(0, opened - active), failed, inbound, outbound };
}

const SYSTEM_NODE_IDS: Readonly<Record<string, readonly string[]>> = {
  'sys-portal': ['gw-edge-01', 'portal-web-01', 'monitor-01', 'zabbix-01'],
  'sys-order': ['order-api-01', 'order-api-02', 'order-job-01', 'redis-order-01', 'kafka-order-01', 'mysql-order-01'],
  'sys-pay': ['pay-api-01', 'nacos-pay-01', 'mysql-pay-01', 'log-pay-01'],
};

const SYSTEMS: readonly TopologySystemGroup[] = [
  { id: 'sys-portal', name: '平台门户', code: 'PORTAL', criticality: 'P1', nodeIds: SYSTEM_NODE_IDS['sys-portal'] ?? [] },
  { id: 'sys-order', name: '订单中心', code: 'ORDER', criticality: 'P0', nodeIds: SYSTEM_NODE_IDS['sys-order'] ?? [] },
  { id: 'sys-pay', name: '支付中心', code: 'PAY', criticality: 'P0', nodeIds: SYSTEM_NODE_IDS['sys-pay'] ?? [] },
];

function buildGraph(config: GraphVersionConfig): TopologyGraph {
  const { version, ageMinutes, factor } = config;
  const edges: TopologyEdge[] = EDGE_SPECS.map((spec) => {
    const count = Math.max(1, Math.round(spec.count * factor));
    const opened = Math.max(count, Math.round((spec.opened ?? spec.count) * factor));
    const failed = Math.max(0, Math.round((spec.failed ?? 0) * factor));
    return {
      id: spec.id,
      source: spec.source,
      target: spec.target,
      protocol: spec.protocol,
      port: spec.port,
      count,
      opened,
      failed,
      confidence: 1,
      countBasis: 'observed',
      direction: 'out',
      label: `${spec.processes?.[0] ?? 'app'} → :${spec.port}`,
      ...(spec.processes ? { processes: spec.processes } : {}),
      ...(spec.external ? { external: true } : {}),
    };
  });
  const nodes: TopologyNode[] = NODE_SPECS.map((spec) => {
    const metrics: TopologyNodeMetrics = { ...computeMetrics(spec.id, edges), ...spec.metrics };
    return {
      id: spec.id,
      label: spec.label,
      kind: spec.kind,
      tier: spec.tier,
      hostname: spec.hostname,
      ip: spec.ip,
      status: spec.status,
      services: spec.services,
      metrics,
      product: spec.product,
      role: spec.role,
      ...(spec.systemService ? { systemService: true } : {}),
      ...(spec.appSystemId
        ? { appSystemId: spec.appSystemId, appSystemName: APP_SYSTEM_NAME.get(spec.appSystemId) ?? spec.appSystemId }
        : {}),
      ...(spec.anomalies ? { anomalies: spec.anomalies } : {}),
      ...(spec.inferred ? { inferred: true } : {}),
      ...(spec.note ? { note: spec.note } : {}),
    };
  });
  const totalConnections = edges.reduce((sum, edge) => sum + edge.count, 0);
  const failedConnections = edges.reduce((sum, edge) => sum + edge.failed, 0);
  const generatedAt = iso(-ageMinutes * 60_000);
  const windowEnd = new Date(NOW - ageMinutes * 60_000);
  return {
    id: `demo-topology-v${version}`,
    tenantId: 'tenant-demo',
    sessionId: `demo-session-v${version}`,
    scope: { kind: 'tenant' },
    mode: 'host',
    window: {
      start: new Date(windowEnd.getTime() - 900_000).toISOString(),
      end: windowEnd.toISOString(),
      seconds: 900,
    },
    nodes,
    edges,
    systems: SYSTEMS,
    analysis: {
      summary: config.summary,
      insights: INSIGHTS(factor),
      hotPaths: HOT_PATHS(factor),
      risks: RISKS,
      model: 'qwen2.5-72b-instruct',
      promptVersion: 'topology-v2',
      generatedAt,
      confidence: version === 3 ? 0.88 : 0.81,
      durationMs: 9420,
      fallback: false,
    },
    stats: {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      hostCount: nodes.filter((node) => !node.inferred).length,
      systemCount: SYSTEMS.length,
      externalCount: nodes.filter((node) => node.inferred).length,
      totalConnections,
      failedConnections,
      samples: Math.round(28640 * factor),
      reportingAgents: 14,
      excludedUnassigned: 0,
    },
    createdAt: generatedAt,
    version,
  };
}

export const DEMO_GRAPHS: readonly TopologyGraph[] = [
  buildGraph({ version: 2, ageMinutes: 6, factor: 1, summary: BASE_SUMMARY }),
  buildGraph({
    version: 1,
    ageMinutes: 133,
    factor: 0.86,
    summary:
      '上一版学习生成：识别出 15 个节点、3 个业务系统和 2 个外部依赖。整体连接量较本次下降 14%，支付回调失败率维持在 6.8%。',
  }),
];

export const DEMO_GRAPH: TopologyGraph = DEMO_GRAPHS[0]!;

export const DEMO_GRAPH_SUMMARIES: readonly TopologyGraphSummary[] = DEMO_GRAPHS.map((graph) => ({
  id: graph.id,
  sessionId: graph.sessionId,
  scope: graph.scope,
  mode: graph.mode,
  window: graph.window,
  nodeCount: graph.stats.nodeCount,
  edgeCount: graph.stats.edgeCount,
  totalConnections: graph.stats.totalConnections,
  failedConnections: graph.stats.failedConnections,
  model: graph.analysis.model,
  fallback: graph.analysis.fallback ?? false,
  createdAt: graph.createdAt,
  version: graph.version,
  summary: graph.analysis.summary,
}));

export function demoGraphById(id: string): TopologyGraph {
  return DEMO_GRAPHS.find((graph) => graph.id === id) ?? DEMO_GRAPH;
}

export function demoNextGraph(version: number): TopologyGraph {
  const base = buildGraph({ version, ageMinutes: 0, factor: 1.02, summary: BASE_SUMMARY });
  return { ...base, id: `demo-topology-v${version}` };
}

export const DEMO_POLICY: TopologyLearningPolicy = {
  tenantId: 'tenant-demo',
  enabled: true,
  intervalSeconds: 21_600,
  windowSeconds: 900,
  scope: { kind: 'tenant' },
  includeUnassigned: false,
  lastRunAt: iso(-6 * 60_000),
  nextRunAt: iso(6 * 3_600_000 - 6 * 60_000),
  updatedAt: iso(-2 * 86_400_000),
};

export function demoPolicy(input: Partial<TopologyLearningPolicy>): TopologyLearningPolicy {
  return { ...DEMO_POLICY, ...input, updatedAt: new Date().toISOString() };
}

export function demoSessionScope(appSystemId: string | null): TopologyLearningSession['scope'] {
  if (!appSystemId) return { kind: 'tenant' };
  return { kind: 'app-system', appSystemId, appSystemName: APP_SYSTEM_NAME.get(appSystemId) ?? appSystemId };
}

export function demoLearningSession(
  windowSeconds: number,
  appSystemId: string | null,
  elapsedSeconds = 0,
  includeUnassigned = false,
): TopologyLearningSession {
  const startedAt = new Date(Date.now() - elapsedSeconds * 1000);
  const endsAt = new Date(startedAt.getTime() + windowSeconds * 1000);
  const percent = Math.min(1, elapsedSeconds / windowSeconds);
  const started = startedAt.toISOString();
  return {
    id: `demo-learning-${startedAt.getTime()}`,
    tenantId: 'tenant-demo',
    scope: demoSessionScope(appSystemId),
    windowSeconds,
    status: percent >= 1 ? 'ready' : 'collecting',
    startedAt: started,
    endsAt: endsAt.toISOString(),
    createdAt: started,
    updatedAt: new Date().toISOString(),
    includeUnassigned,
    progress: {
      elapsedSeconds,
      remainingSeconds: Math.max(0, windowSeconds - elapsedSeconds),
      percent: Math.round(percent * 1000) / 10,
      reportingAgents: Math.round(14 * Math.min(1, percent * 1.6)),
      expectedAgents: 14,
      edgeSamples: Math.round(28640 * percent),
      uniqueEdges: Math.round(EDGE_SPECS.length * Math.min(1, percent * 1.4)),
      phase: percent < 1 ? 'collecting' : 'analyzing',
    },
    graphId: percent >= 1 ? DEMO_GRAPH.id : null,
    model: percent >= 1 ? DEMO_GRAPH.analysis.model : null,
    fallback: false,
    error: null,
    ...(percent >= 1 ? { stats: DEMO_GRAPH.stats } : {}),
  };
}

/** 演示模式：按秒推进学习会话。 */
export function advanceDemoSession(session: TopologyLearningSession, stepSeconds = 1): TopologyLearningSession {
  const elapsed = session.progress.elapsedSeconds + stepSeconds;
  const total = Math.max(1, session.windowSeconds);
  const percent = Math.min(1, elapsed / total);
  const analyzing = percent >= 1;
  return {
    ...session,
    status: analyzing ? 'ready' : 'collecting',
    updatedAt: new Date().toISOString(),
    progress: {
      ...session.progress,
      elapsedSeconds: elapsed,
      remainingSeconds: Math.max(0, total - elapsed),
      percent: Math.round(percent * 1000) / 10,
      reportingAgents: Math.round(14 * Math.min(1, percent * 1.6)),
      edgeSamples: Math.round(28640 * Math.min(1, percent + 0.04)),
      uniqueEdges: Math.round(EDGE_SPECS.length * Math.min(1, percent * 1.35)),
      phase: analyzing ? 'analyzing' : 'collecting',
    },
    graphId: analyzing ? DEMO_GRAPH.id : null,
    model: analyzing ? DEMO_GRAPH.analysis.model : null,
    ...(analyzing ? { stats: DEMO_GRAPH.stats } : {}),
  };
}

export function formatDemoTime(value: string): string {
  return new Date(value).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
}


// ---------------------------------------------------------------------------
// Dense 演示场景（?demo=topology&case=dense）
// 复刻内网真实图：1 个业务系统、4 台主机（sshd:22 + 多端口服务）、22 个外部 IP、
// 72 条建连边（含 SSH/监控管理流量与大量低流量端口），0 失败、1 台未归属主机。
// ---------------------------------------------------------------------------

export const DEMO_DENSE_APP_SYSTEMS: readonly DemoAppSystemOption[] = [
  { id: 'sys-core', name: '核心交易系统' },
];

const DENSE_SYSTEMS: readonly TopologySystemGroup[] = [
  {
    id: 'sys-core',
    name: '核心交易系统',
    code: 'CORE',
    criticality: 'P0',
    nodeIds: ['core-app-01', 'core-app-02', 'core-db-01', 'core-cache-01'],
  },
];

const densePorts = (prefix: string, start: number, count: number): TopologyServicePort[] =>
  Array.from({ length: count }, (_, index) => ({
    name: `${prefix}-${start + index}`,
    port: start + index,
  }));

interface DenseNodeSpec {
  readonly id: string;
  readonly label: string;
  readonly kind: TopologyNodeKind;
  readonly tier: TopologyTier;
  readonly hostname: string;
  readonly ip: string;
  readonly appSystemId?: string;
  readonly product: string;
  readonly role: string;
  readonly systemService?: boolean;
  readonly services: readonly TopologyServicePort[];
  readonly inferred?: boolean;
  readonly anomalies?: readonly string[];
}

function denseNode(spec: DenseNodeSpec, edges: readonly TopologyEdge[]): TopologyNode {
  const metrics = computeMetrics(spec.id, edges);
  return {
    id: spec.id,
    label: spec.label,
    kind: spec.kind,
    tier: spec.tier,
    hostname: spec.hostname,
    ip: spec.ip,
    status: 'online',
    services: spec.services,
    metrics,
    product: spec.product,
    role: spec.role,
    ...(spec.systemService ? { systemService: true } : {}),
    ...(spec.appSystemId
      ? { appSystemId: spec.appSystemId, appSystemName: '核心交易系统' }
      : {}),
    ...(spec.inferred ? { inferred: true } : {}),
    ...(spec.anomalies ? { anomalies: spec.anomalies } : {}),
    ...(spec.inferred ? { note: '模型从外部出口 IP 聚合得到的第三方依赖。' } : {}),
  };
}

interface DenseEdgeSpec {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly port: number;
  readonly protocol: string;
  readonly count: number;
  readonly failed?: number;
  readonly processes?: readonly string[];
  readonly external?: boolean;
}

function buildDenseGraph(): TopologyGraph {
  const externalHosts = Array.from({ length: 22 }, (_, index) => {
    const ip = `198.51.100.${index + 1}`;
    const ports = [8080, 50051, 9090, 8443, 9001, 7001, 16001, 32000];
    const port = ports[index % ports.length] ?? 5180;
    return {
      id: `ext-${ip.replace(/\./g, '-')}`,
      label: ip,
      kind: 'external' as TopologyNodeKind,
      tier: 'external' as TopologyTier,
      hostname: ip,
      ip,
      product: '外部服务',
      role: '第三方 API',
      services: [{ name: 'tcp', port }],
      inferred: true,
    };
  });

  const externalEdges: DenseEdgeSpec[] = externalHosts.map((host, index) => {
    const sources = ['core-app-01', 'core-app-02', 'core-db-01', 'core-cache-01'];
    const source = sources[index % sources.length] ?? 'core-app-01';
    const port = host.services[0]?.port ?? 5180;
    return {
      id: `d${String(25 + index).padStart(2, '0')}`,
      source,
      target: host.id,
      port,
      protocol: 'tcp',
      count: 380 - index * 14,
      processes: [source === 'core-db-01' ? 'mysql' : 'core-app'],
      external: true,
    };
  });
  const extraExternalEdges: DenseEdgeSpec[] = externalHosts.slice(0, 8).map((host, index) => {
    const sources = ['core-app-01', 'core-app-02', 'core-db-01', 'core-cache-01'];
    return {
      id: `d${String(47 + index).padStart(2, '0')}`,
      source: sources[index % sources.length] ?? 'core-app-01',
      target: host.id,
      port: [5993, 9001, 7001, 16001][index % 4] ?? 5993,
      protocol: 'tcp',
      count: 120 - index * 7,
      processes: ['core-app'],
      external: true,
    };
  });

  const denseEdgeSpecs: DenseEdgeSpec[] = [
    // 管理/监控流量：默认隐藏
    { id: 'd01', source: 'core-app-01', target: 'core-app-02', port: 22, protocol: 'tcp', count: 42, processes: ['sshd'] },
    { id: 'd02', source: 'core-app-01', target: 'core-db-01', port: 22, protocol: 'tcp', count: 36, processes: ['sshd'] },
    { id: 'd03', source: 'core-app-01', target: 'core-cache-01', port: 22, protocol: 'tcp', count: 18, processes: ['sshd'] },
    { id: 'd04', source: 'core-app-02', target: 'core-db-01', port: 22, protocol: 'tcp', count: 16, processes: ['sshd'] },
    { id: 'd05', source: 'core-app-02', target: 'core-app-01', port: 9100, protocol: 'http', count: 61, processes: ['node_exporter'] },
    { id: 'd06', source: 'core-app-02', target: 'core-db-01', port: 9100, protocol: 'http', count: 58, processes: ['node_exporter'] },
    { id: 'd07', source: 'core-db-01', target: 'core-app-01', port: 9100, protocol: 'http', count: 44, processes: ['node_exporter'] },
    { id: 'd08', source: 'core-cache-01', target: 'core-db-01', port: 10050, protocol: 'http', count: 39, processes: ['node_exporter'] },
    { id: 'd09', source: 'core-app-01', target: 'core-db-01', port: 10050, protocol: 'tcp', count: 22, processes: ['zabbix_agentd'] },
    { id: 'd10', source: 'core-app-02', target: 'core-cache-01', port: 10050, protocol: 'tcp', count: 20, processes: ['zabbix_agentd'] },
    { id: 'd11', source: 'core-db-01', target: 'core-cache-01', port: 22, protocol: 'tcp', count: 19, processes: ['zabbix_agentd'] },
    { id: 'd12', source: 'core-cache-01', target: 'core-app-01', port: 22, protocol: 'tcp', count: 17, processes: ['zabbix_agentd'] },
    { id: 'd13', source: 'core-app-01', target: 'core-app-02', port: 8080, protocol: 'http', count: 24, processes: ['opsagent-agent'] },
    { id: 'd14', source: 'core-db-01', target: 'core-app-01', port: 3000, protocol: 'http', count: 12, processes: ['grafana'] },
    // 业务访问
    { id: 'd15', source: 'core-app-01', target: 'core-db-01', port: 3306, protocol: 'mysql', count: 1420, processes: ['core-app'], failed: 0 },
    { id: 'd16', source: 'core-app-02', target: 'core-db-01', port: 3306, protocol: 'mysql', count: 960, processes: ['python-worker'] },
    { id: 'd17', source: 'core-app-01', target: 'core-cache-01', port: 6379, protocol: 'tcp', count: 2100, processes: ['core-app'] },
    { id: 'd18', source: 'core-app-02', target: 'core-cache-01', port: 6379, protocol: 'tcp', count: 1680, processes: ['python-worker'] },
    { id: 'd19', source: 'core-app-01', target: 'core-app-02', port: 8443, protocol: 'http', count: 320, processes: ['core-app'] },
    { id: 'd20', source: 'core-app-02', target: 'core-app-01', port: 8080, protocol: 'http', count: 260, processes: ['python-worker'] },
    { id: 'd21', source: 'core-db-01', target: 'core-cache-01', port: 6379, protocol: 'tcp', count: 140, processes: ['mysql'] },
    { id: 'd22', source: 'core-cache-01', target: 'core-db-01', port: 3306, protocol: 'mysql', count: 90, processes: ['redis-server'] },
    { id: 'd23', source: 'core-app-01', target: 'core-db-01', port: 6432, protocol: 'postgres', count: 520, processes: ['core-app'] },
    { id: 'd24', source: 'core-app-02', target: 'core-db-01', port: 6432, protocol: 'postgres', count: 430, processes: ['python-worker'] },
    ...externalEdges,
    ...extraExternalEdges,
    // 低流量端口：默认隐藏
    ...Array.from({ length: 18 }, (_, index) => {
      const specs: DenseEdgeSpec[] = [
        { id: `d${String(55 + index).padStart(2, '0')}`, source: 'core-app-01', target: 'core-db-01', port: 9001 + index, protocol: 'tcp', count: 3 + (index % 3), processes: ['core-app'] },
      ];
      return specs[0]!;
    }),
  ];
  const edges: TopologyEdge[] = denseEdgeSpecs.map((spec) => denseEdge(spec));

  const nodeSpecs: DenseNodeSpec[] = [
    {
      id: 'core-app-01',
      label: 'core-app-01',
      kind: 'service',
      tier: 'app',
      hostname: 'core-app-01',
      ip: '10.10.0.11',
      appSystemId: 'sys-core',
      product: 'Spring Boot',
      role: '核心交易应用',
      services: [
        { name: 'sshd', port: 22, process: 'sshd' },
        { name: 'nginx', port: 80, process: 'nginx' },
        { name: 'core-api', port: 8080, process: 'java' },
        ...densePorts('svc', 8001, 13),
      ],
      anomalies: [],
    },
    {
      id: 'core-app-02',
      label: 'core-app-02',
      kind: 'service',
      tier: 'app',
      hostname: 'core-app-02',
      ip: '10.10.0.12',
      appSystemId: 'sys-core',
      product: 'Python',
      role: '批量任务服务',
      services: [
        { name: 'sshd', port: 22, process: 'sshd' },
        { name: 'py-api', port: 8443, process: 'python' },
        ...densePorts('job', 8101, 14),
      ],
    },
    {
      id: 'core-db-01',
      label: 'core-db-01',
      kind: 'database',
      tier: 'data',
      hostname: 'core-db-01',
      ip: '10.10.0.21',
      appSystemId: 'sys-core',
      product: 'MySQL',
      role: '关系型数据库',
      services: [
        { name: 'sshd', port: 22, process: 'sshd' },
        { name: 'mysql', port: 3306, process: 'mysqld' },
        { name: 'mysqlx', port: 33060, process: 'mysqld' },
        ...densePorts('db-svc', 9001, 8),
      ],
    },
    {
      id: 'core-cache-01',
      label: 'core-cache-01',
      kind: 'cache',
      tier: 'middleware',
      hostname: 'core-cache-01',
      ip: '10.10.0.31',
      appSystemId: 'sys-core',
      product: 'Redis',
      role: '缓存集群',
      services: [
        { name: 'sshd', port: 22, process: 'sshd' },
        { name: 'redis', port: 6379, process: 'redis-server' },
        { name: 'sentinel', port: 26379 },
        ...densePorts('cache-svc', 8501, 6),
      ],
    },
    {
      id: 'ops-jump-01',
      label: 'ops-jump-01',
      kind: 'service',
      tier: 'ops',
      hostname: 'ops-jump-01',
      ip: '10.10.0.99',
      product: 'OpsAgent',
      role: '运维跳板 / 监控采集',
      systemService: true,
      services: [
        { name: 'sshd', port: 22, process: 'sshd' },
        { name: 'node_exporter', port: 9100 },
        { name: 'zabbix-agent', port: 10050 },
        { name: 'prometheus', port: 9090 },
        { name: 'grafana', port: 3000 },
        { name: 'opsagent-agent', port: 8080 },
      ],
    },
    ...externalHosts.map<DenseNodeSpec>((host) => ({
      id: host.id,
      label: host.label,
      kind: 'external',
      tier: 'external',
      hostname: host.hostname,
      ip: host.ip,
      product: host.product,
      role: host.role,
      services: host.services,
      inferred: true,
    })),
  ];

  // 未归属主机：去掉 appSystemId / appSystemName。
  const preparedNodes = nodeSpecs.map((spec) => {
    const node = denseNode(spec, edges);
    if (spec.id !== 'ops-jump-01') return node;
    const { appSystemName: _omit, ...rest } = node;
    return { ...rest, appSystemId: null, status: 'unknown' as TopologyNodeStatus } satisfies TopologyNode;
  });

  const totalConnections = edges.reduce((sum, edge) => sum + edge.count, 0);
  return {
    id: 'demo-topology-dense',
    tenantId: 'tenant-demo',
    sessionId: 'demo-session-dense',
    scope: { kind: 'tenant' },
    mode: 'host',
    window: {
      start: new Date(Date.now() - 900_000).toISOString(),
      end: new Date().toISOString(),
      seconds: 900,
    },
    nodes: preparedNodes,
    edges,
    systems: DENSE_SYSTEMS,
    analysis: {
      summary:
        '规则引擎兜底结果：识别到 1 个业务系统、4 台核心主机和 22 个外部 IP。' +
        '业务访问集中在 core-app-01/02 → MySQL/Redis；SSH、监控采集等管理流量已默认隐藏，低流量端口可按需展开。',
      insights: [
        {
          id: 'dense-ins-1',
          title: '外部依赖高度分散',
          detail: '22 个外部 IP、30 条外部连接，单个 IP 占比均低于 5%，建议按供应商归并后再做依赖治理。',
          severity: 'info' as const,
          nodeIds: ['core-app-01'],
        },
        {
          id: 'dense-ins-2',
          title: '管理流量占边数 19%',
          detail: 'SSH、node_exporter、zabbix 与 Grafana 共产生 14 条管理连接，默认已过滤，可在显示设置中恢复。',
          severity: 'info' as const,
          nodeIds: ['ops-jump-01'],
        },
        {
          id: 'dense-ins-3',
          title: '应用主机暴露端口较多',
          detail: 'core-app-01 / core-app-02 分别有 16 / 16 个监听端口，建议核对非必要端口的暴露范围。',
          severity: 'warning' as const,
          nodeIds: ['core-app-01', 'core-app-02'],
        },
      ],
      hotPaths: [
        {
          label: '交易主链路：应用 → MySQL',
          nodeIds: ['core-app-01', 'core-db-01'],
          edgeIds: ['d15'],
          connections: 1420,
        },
        {
          label: '缓存链路：应用 → Redis',
          nodeIds: ['core-app-01', 'core-cache-01'],
          edgeIds: ['d17'],
          connections: 2100,
        },
      ],
      risks: [
        {
          id: 'dense-risk-1',
          title: '外部依赖缺少分组',
          detail: '22 个外部 IP 中大部分为随机高端口，建议按供应商 / 域名聚合。',
          severity: 'info' as const,
          nodeIds: ['core-app-01'],
        },
      ],
      model: 'rules-v2',
      promptVersion: 'topology-v2',
      generatedAt: new Date().toISOString(),
      confidence: 0.62,
      durationMs: 12,
      fallback: true,
    },
    stats: {
      nodeCount: preparedNodes.length,
      edgeCount: edges.length,
      hostCount: 4,
      systemCount: 1,
      externalCount: 22,
      totalConnections,
      failedConnections: 0,
      samples: 18640,
      reportingAgents: 4,
      excludedUnassigned: 1,
    },
    createdAt: new Date().toISOString(),
    version: 1,
  };
}

function denseEdge(spec: DenseEdgeSpec): TopologyEdge {
  return {
    id: spec.id,
    source: spec.source,
    target: spec.target,
    protocol: spec.protocol,
    port: spec.port,
    count: spec.count,
    opened: spec.count,
    failed: spec.failed ?? 0,
    confidence: 1,
    countBasis: 'observed',
    ...(spec.processes ? { processes: spec.processes } : {}),
    ...(spec.external ? { external: true } : {}),
  };
}

export const DEMO_DENSE_GRAPH: TopologyGraph = buildDenseGraph();

export const DEMO_DENSE_SUMMARIES: readonly TopologyGraphSummary[] = [
  {
    id: DEMO_DENSE_GRAPH.id,
    sessionId: DEMO_DENSE_GRAPH.sessionId,
    scope: DEMO_DENSE_GRAPH.scope,
    mode: DEMO_DENSE_GRAPH.mode,
    window: DEMO_DENSE_GRAPH.window,
    nodeCount: DEMO_DENSE_GRAPH.stats.nodeCount,
    edgeCount: DEMO_DENSE_GRAPH.stats.edgeCount,
    totalConnections: DEMO_DENSE_GRAPH.stats.totalConnections,
    failedConnections: DEMO_DENSE_GRAPH.stats.failedConnections,
    model: DEMO_DENSE_GRAPH.analysis.model,
    fallback: true,
    createdAt: DEMO_DENSE_GRAPH.createdAt,
    version: 1,
    summary: DEMO_DENSE_GRAPH.analysis.summary,
  },
];
