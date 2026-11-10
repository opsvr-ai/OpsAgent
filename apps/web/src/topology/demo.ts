/**
 * 访问拓扑演示数据（?demo=topology）。
 *
 * 这是给设计工作台核验用的高保真 fixture：3 个业务系统 / 14 台主机 /
 * 40+ 条建连关系，覆盖跨系统访问、失败率异常链路、外部 API 依赖、
 * 离线节点与 LLM 分析结论等所有视觉元素。
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
  { id: 'sys-order', name: '订单中心' },
  { id: 'sys-pay', name: '支付中心' },
  { id: 'sys-portal', name: '平台门户' },
];

const APP_SYSTEM_NAME = new Map(DEMO_APP_SYSTEMS.map((item) => [item.id, item.name]));

interface NodeSpec {
  readonly id: string;
  readonly label: string;
  readonly kind: TopologyNodeKind;
  readonly tier: TopologyTier;
  readonly hostname?: string;
  readonly ip?: string;
  readonly appSystemId?: string;
  readonly status: TopologyNodeStatus;
  readonly services: readonly TopologyServicePort[];
  readonly anomalies?: readonly string[];
  readonly inferred?: boolean;
  readonly note?: string;
  readonly metrics?: Partial<TopologyNodeMetrics>;
}

const svc = (name: string, port: number, process?: string): TopologyServicePort =>
  process ? { name, port, process } : { name, port };

const NODE_SPECS: readonly NodeSpec[] = [
  // ---- 接入层 ----------------------------------------------------------
  {
    id: 'gw-sh-01',
    label: '华东接入网关',
    kind: 'gateway',
    tier: 'ingress',
    hostname: 'edge-gw-sh-01',
    ip: '10.20.1.11',
    appSystemId: 'sys-portal',
    status: 'online',
    services: [svc('nginx', 443, 'nginx'), svc('nginx', 80, 'nginx')],
    metrics: { inbound: 6840 },
  },
  {
    id: 'gw-sz-01',
    label: '华南接入网关',
    kind: 'gateway',
    tier: 'ingress',
    hostname: 'edge-gw-sz-01',
    ip: '10.20.7.11',
    appSystemId: 'sys-portal',
    status: 'online',
    services: [svc('nginx', 443, 'nginx'), svc('nginx', 80, 'nginx')],
    metrics: { inbound: 4120 },
  },
  // ---- 应用层 ----------------------------------------------------------
  {
    id: 'order-api-01',
    label: '订单服务 API',
    kind: 'service',
    tier: 'app',
    hostname: 'order-api-01',
    ip: '10.30.1.21',
    appSystemId: 'sys-order',
    status: 'online',
    services: [svc('order-api', 8080, 'order-api'), svc('metrics', 9100)],
  },
  {
    id: 'order-api-02',
    label: '订单服务 API',
    kind: 'service',
    tier: 'app',
    hostname: 'order-api-02',
    ip: '10.30.1.22',
    appSystemId: 'sys-order',
    status: 'online',
    services: [svc('order-api', 8080, 'order-api'), svc('metrics', 9100)],
    anomalies: ['Redis 建连失败率 9.4%', 'CPU 使用率 88% 持续 5 分钟'],
  },
  {
    id: 'order-job-01',
    label: '订单对账作业',
    kind: 'service',
    tier: 'app',
    hostname: 'order-job-01',
    ip: '10.30.1.41',
    appSystemId: 'sys-order',
    status: 'offline',
    services: [svc('order-worker', 9090, 'order-worker')],
    anomalies: ['Agent 心跳中断 3 分钟'],
    note: '离线节点仍展示上一窗口观测到的建连关系。',
  },
  {
    id: 'pay-api-01',
    label: '支付收单 API',
    kind: 'service',
    tier: 'app',
    hostname: 'pay-api-01',
    ip: '10.30.2.31',
    appSystemId: 'sys-pay',
    status: 'online',
    services: [svc('pay-api', 8443, 'pay-api'), svc('pay-admin', 8444)],
    anomalies: ['回调失败率 8.1%'],
  },
  {
    id: 'portal-web-01',
    label: '门户前端',
    kind: 'service',
    tier: 'app',
    hostname: 'portal-web-01',
    ip: '10.30.0.21',
    appSystemId: 'sys-portal',
    status: 'online',
    services: [svc('nginx', 443, 'nginx'), svc('portal-web', 8080)],
  },
  {
    id: 'notify-01',
    label: '消息通知服务',
    kind: 'service',
    tier: 'app',
    hostname: 'notify-01',
    ip: '10.30.0.61',
    appSystemId: 'sys-portal',
    status: 'online',
    services: [svc('notify', 8081, 'notify')],
  },
  // ---- 中间件 ----------------------------------------------------------
  {
    id: 'redis-order-01',
    label: '订单 Redis 集群',
    kind: 'cache',
    tier: 'middleware',
    hostname: 'redis-order-01',
    ip: '10.40.1.11',
    appSystemId: 'sys-order',
    status: 'online',
    services: [svc('redis', 6379, 'redis-server'), svc('sentinel', 26379)],
    anomalies: ['连接数接近上限 92%'],
  },
  {
    id: 'kafka-pay-01',
    label: '支付 Kafka 集群',
    kind: 'mq',
    tier: 'middleware',
    hostname: 'kafka-pay-01',
    ip: '10.40.2.21',
    appSystemId: 'sys-pay',
    status: 'online',
    services: [svc('kafka', 9092, 'kafka'), svc('kafka-exporter', 9308)],
  },
  // ---- 数据层 ----------------------------------------------------------
  {
    id: 'pg-order-01',
    label: '订单主库',
    kind: 'database',
    tier: 'data',
    hostname: 'pg-order-01',
    ip: '10.50.1.11',
    appSystemId: 'sys-order',
    status: 'online',
    services: [svc('postgres', 5432, 'postgres'), svc('pgbouncer', 6432)],
  },
  {
    id: 'pg-pay-01',
    label: '支付主库',
    kind: 'database',
    tier: 'data',
    hostname: 'pg-pay-01',
    ip: '10.50.2.11',
    appSystemId: 'sys-pay',
    status: 'online',
    services: [svc('postgres', 5432, 'postgres'), svc('pgbouncer', 6432)],
    anomalies: ['主从延迟 1.8s 超出阈值'],
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
    services: [svc('https', 443)],
    inferred: true,
    note: '模型从外部出口 IP 推断的第三方支付渠道。',
  },
  {
    id: 'ext-sms',
    label: '短信服务商',
    kind: 'external',
    tier: 'external',
    hostname: 'sms-vendor.cn',
    ip: '203.0.113.36',
    status: 'unknown',
    services: [svc('https', 443), svc('http-alt', 8080)],
    inferred: true,
    note: '外部依赖，无 Agent 上报，按出口连接推断。',
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
  readonly label: string;
  readonly processes?: readonly string[];
  readonly external?: boolean;
}

const EDGE_SPECS: readonly EdgeSpec[] = [
  // 接入 → 应用
  { id: 'e01', source: 'gw-sh-01', target: 'order-api-01', port: 8080, protocol: 'http', count: 1420, opened: 1980, label: 'nginx → order-api:8080', processes: ['nginx'] },
  { id: 'e02', source: 'gw-sh-01', target: 'order-api-02', port: 8080, protocol: 'http', count: 1180, opened: 1640, label: 'nginx → order-api:8080', processes: ['nginx'] },
  { id: 'e03', source: 'gw-sz-01', target: 'order-api-01', port: 8080, protocol: 'http', count: 860, opened: 1210, label: 'nginx → order-api:8080', processes: ['nginx'] },
  { id: 'e04', source: 'gw-sz-01', target: 'order-api-02', port: 8080, protocol: 'http', count: 790, opened: 1080, label: 'nginx → order-api:8080', processes: ['nginx'] },
  { id: 'e05', source: 'gw-sh-01', target: 'portal-web-01', port: 443, protocol: 'https', count: 2260, opened: 3120, label: 'nginx → nginx:443', processes: ['nginx'] },
  { id: 'e06', source: 'gw-sz-01', target: 'portal-web-01', port: 443, protocol: 'https', count: 980, opened: 1420, label: 'nginx → nginx:443', processes: ['nginx'] },
  { id: 'e07', source: 'gw-sh-01', target: 'portal-web-01', port: 8080, protocol: 'http', count: 640, opened: 880, label: 'nginx → portal-web:8080', processes: ['nginx'] },
  { id: 'e08', source: 'gw-sh-01', target: 'pay-api-01', port: 8443, protocol: 'https', count: 520, opened: 760, label: 'nginx → pay-api:8443', processes: ['nginx'] },
  { id: 'e09', source: 'gw-sz-01', target: 'pay-api-01', port: 8443, protocol: 'https', count: 470, opened: 690, label: 'nginx → pay-api:8443', processes: ['nginx'] },
  { id: 'e10', source: 'gw-sh-01', target: 'order-api-01', port: 9100, protocol: 'http', count: 610, opened: 620, label: 'nginx → metrics:9100', processes: ['nginx'] },
  { id: 'e11', source: 'gw-sz-01', target: 'order-api-02', port: 9100, protocol: 'http', count: 580, opened: 590, label: 'nginx → metrics:9100', processes: ['nginx'] },
  { id: 'e12', source: 'gw-sh-01', target: 'notify-01', port: 8081, protocol: 'grpc', count: 120, opened: 180, label: 'nginx → notify:8081', processes: ['nginx'] },
  // 门户 → 应用
  { id: 'e13', source: 'portal-web-01', target: 'order-api-01', port: 8080, protocol: 'http', count: 720, opened: 980, label: 'portal-web → order-api:8080', processes: ['portal-web'] },
  { id: 'e14', source: 'portal-web-01', target: 'order-api-02', port: 8080, protocol: 'http', count: 610, opened: 860, label: 'portal-web → order-api:8080', processes: ['portal-web'] },
  { id: 'e15', source: 'portal-web-01', target: 'pay-api-01', port: 8443, protocol: 'https', count: 380, opened: 520, label: 'portal-web → pay-api:8443', processes: ['portal-web'] },
  { id: 'e16', source: 'portal-web-01', target: 'notify-01', port: 8081, protocol: 'grpc', count: 240, opened: 330, label: 'portal-web → notify:8081', processes: ['portal-web'] },
  { id: 'e17', source: 'portal-web-01', target: 'redis-order-01', port: 6379, protocol: 'tcp', count: 880, opened: 1120, failed: 12, label: 'portal-web → redis:6379', processes: ['portal-web'] },
  { id: 'e18', source: 'portal-web-01', target: 'order-job-01', port: 9090, protocol: 'http', count: 90, opened: 130, label: 'portal-web → order-worker:9090', processes: ['portal-web'] },
  // 订单 → 中间件 / 数据
  { id: 'e19', source: 'order-api-01', target: 'redis-order-01', port: 6379, protocol: 'tcp', count: 2140, opened: 2860, failed: 9, label: 'order-api → redis:6379', processes: ['order-api'] },
  { id: 'e20', source: 'order-api-01', target: 'redis-order-01', port: 26379, protocol: 'tcp', count: 120, opened: 160, label: 'order-api → sentinel:26379', processes: ['order-api'] },
  { id: 'e21', source: 'order-api-02', target: 'redis-order-01', port: 6379, protocol: 'tcp', count: 1980, opened: 2640, failed: 186, label: 'order-api → redis:6379', processes: ['order-api'] },
  { id: 'e22', source: 'order-api-01', target: 'pg-order-01', port: 5432, protocol: 'postgres', count: 1640, opened: 2210, failed: 4, label: 'order-api → postgres:5432', processes: ['order-api'] },
  { id: 'e23', source: 'order-api-02', target: 'pg-order-01', port: 5432, protocol: 'postgres', count: 1520, opened: 2050, failed: 34, label: 'order-api → postgres:5432', processes: ['order-api'] },
  { id: 'e24', source: 'order-api-01', target: 'pg-order-01', port: 6432, protocol: 'postgres', count: 880, opened: 1180, label: 'order-api → pgbouncer:6432', processes: ['order-api'] },
  { id: 'e25', source: 'order-api-02', target: 'pg-order-01', port: 6432, protocol: 'postgres', count: 760, opened: 1010, label: 'order-api → pgbouncer:6432', processes: ['order-api'] },
  { id: 'e26', source: 'order-job-01', target: 'pg-order-01', port: 5432, protocol: 'postgres', count: 420, opened: 560, label: 'order-worker → postgres:5432', processes: ['order-worker'] },
  { id: 'e27', source: 'order-job-01', target: 'redis-order-01', port: 6379, protocol: 'tcp', count: 610, opened: 820, failed: 8, label: 'order-worker → redis:6379', processes: ['order-worker'] },
  { id: 'e28', source: 'order-job-01', target: 'kafka-pay-01', port: 9092, protocol: 'kafka', count: 380, opened: 510, label: 'order-worker → kafka:9092', processes: ['order-worker'] },
  { id: 'e29', source: 'order-api-01', target: 'kafka-pay-01', port: 9092, protocol: 'kafka', count: 540, opened: 720, label: 'order-api → kafka:9092', processes: ['order-api'] },
  // 订单 → 支付（跨系统）
  { id: 'e30', source: 'order-api-01', target: 'pay-api-01', port: 8443, protocol: 'https', count: 940, opened: 1260, failed: 18, label: 'order-api → pay-api:8443', processes: ['order-api'] },
  { id: 'e31', source: 'order-api-02', target: 'pay-api-01', port: 8443, protocol: 'https', count: 820, opened: 1120, failed: 42, label: 'order-api → pay-api:8443', processes: ['order-api'] },
  { id: 'e32', source: 'order-job-01', target: 'pay-api-01', port: 8443, protocol: 'https', count: 160, opened: 220, failed: 6, label: 'order-worker → pay-api:8443', processes: ['order-worker'] },
  // 支付 → 中间件 / 数据 / 外部
  { id: 'e33', source: 'pay-api-01', target: 'pg-pay-01', port: 5432, protocol: 'postgres', count: 1320, opened: 1780, failed: 7, label: 'pay-api → postgres:5432', processes: ['pay-api'] },
  { id: 'e34', source: 'pay-api-01', target: 'pg-pay-01', port: 6432, protocol: 'postgres', count: 410, opened: 550, label: 'pay-api → pgbouncer:6432', processes: ['pay-api'] },
  { id: 'e35', source: 'pay-api-01', target: 'kafka-pay-01', port: 9092, protocol: 'kafka', count: 760, opened: 1010, label: 'pay-api → kafka:9092', processes: ['pay-api'] },
  { id: 'e36', source: 'pay-api-01', target: 'redis-order-01', port: 6379, protocol: 'tcp', count: 240, opened: 320, failed: 11, label: 'pay-api → redis:6379', processes: ['pay-api'] },
  { id: 'e37', source: 'pay-api-01', target: 'ext-alipay', port: 443, protocol: 'https', count: 460, opened: 610, failed: 14, label: 'pay-api → https:443', processes: ['pay-api'], external: true },
  { id: 'e38', source: 'pay-api-01', target: 'ext-alipay', port: 8443, protocol: 'https', count: 90, opened: 120, failed: 6, label: 'pay-api → https:8443', processes: ['pay-api'], external: true },
  { id: 'e39', source: 'notify-01', target: 'kafka-pay-01', port: 9092, protocol: 'kafka', count: 520, opened: 690, label: 'notify → kafka:9092', processes: ['notify'] },
  { id: 'e40', source: 'notify-01', target: 'ext-sms', port: 443, protocol: 'https', count: 180, opened: 240, failed: 2, label: 'notify → https:443', processes: ['notify'], external: true },
  { id: 'e41', source: 'notify-01', target: 'ext-sms', port: 8080, protocol: 'http', count: 40, opened: 60, label: 'notify → http-alt:8080', processes: ['notify'], external: true },
  { id: 'e42', source: 'notify-01', target: 'redis-order-01', port: 6379, protocol: 'tcp', count: 210, opened: 280, label: 'notify → redis:6379', processes: ['notify'] },
  // 支付回调（反向跨系统）
  { id: 'e43', source: 'pay-api-01', target: 'order-api-01', port: 8080, protocol: 'http', count: 310, opened: 430, failed: 26, label: 'pay-api → order-api:8080', processes: ['pay-api'] },
  { id: 'e44', source: 'pay-api-01', target: 'order-api-02', port: 8080, protocol: 'http', count: 190, opened: 270, failed: 22, label: 'pay-api → order-api:8080', processes: ['pay-api'] },
  // 中间件 → 数据（CDC / 归档）
  { id: 'e45', source: 'kafka-pay-01', target: 'pg-pay-01', port: 5432, protocol: 'postgres', count: 260, opened: 340, label: 'kafka → postgres:5432', processes: ['kafka'] },
  // 网关 → 支付 备用链路 & 观测
  { id: 'e46', source: 'gw-sh-01', target: 'pay-api-01', port: 8443, protocol: 'https', count: 330, opened: 460, failed: 9, label: 'nginx → pay-api:8443', processes: ['nginx'] },
  { id: 'e47', source: 'order-api-01', target: 'notify-01', port: 8081, protocol: 'grpc', count: 280, opened: 370, label: 'order-api → notify:8081', processes: ['order-api'] },
  { id: 'e48', source: 'order-api-02', target: 'notify-01', port: 8081, protocol: 'grpc', count: 190, opened: 260, label: 'order-api → notify:8081', processes: ['order-api'] },
];

interface GraphVersionConfig {
  readonly version: number;
  readonly ageMinutes: number;
  readonly factor: number;
  readonly summary: string;
}

const BASE_SUMMARY =
  '窗口内学习到 14 个节点、48 条建连关系。入口流量集中在华东网关（62%），订单中心与支付中心之间形成 5 条跨系统同步调用；' +
  '支付回调链路失败率 8.1%，订单服务访问 Redis 失败 186 次，是当前最明确的两个异常信号。';

const INSIGHTS = (factor: number) => [
  {
    id: 'ins-1',
    title: '支付回调链路失败率 8.1%',
    detail: 'pay-api-01 → order-api-01/02 的回调请求在一个窗口内失败 48 次，集中在 14:02–14:11，疑似订单侧连接池打满。',
    severity: 'critical' as const,
    nodeIds: ['pay-api-01', 'order-api-01', 'order-api-02'],
    edgeIds: ['e43', 'e44'],
  },
  {
    id: 'ins-2',
    title: '订单服务访问 Redis 有 186 次失败',
    detail: 'order-api-02 → redis-order-01:6379 失败率 9.4%，同时 Redis 连接数已达上限的 92%，建议核查连接池与超时配置。',
    severity: 'warning' as const,
    nodeIds: ['order-api-02', 'redis-order-01'],
    edgeIds: ['e21'],
  },
  {
    id: 'ins-3',
    title: '跨系统同步调用缺少熔断',
    detail: '订单中心 → 支付中心在窗口内发起 2,230 次同步调用，未观测到重试退避；任一侧抖动都会直接放大到下游客服端。',
    severity: 'warning' as const,
    nodeIds: ['order-api-01', 'order-api-02', 'pay-api-01'],
    edgeIds: ['e30', 'e31'],
  },
  {
    id: 'ins-4',
    title: `入口流量 ${Math.round(62 * factor)}% 落在华东网关`,
    detail: '华东网关承担 9,380 并发连接，华南网关为 5,430；两地入口未做权重均衡，华南储备容量充足。',
    severity: 'info' as const,
    nodeIds: ['gw-sh-01', 'gw-sz-01'],
    edgeIds: ['e01', 'e02', 'e05'],
  },
  {
    id: 'ins-5',
    title: '外部依赖收敛为两个出口',
    detail: '支付中心访问支付宝 550 次、门户访问短信服务商 220 次，均通过单一出口 IP，外部依赖故障会影响全部支付与通知。',
    severity: 'info' as const,
    nodeIds: ['ext-alipay', 'ext-sms'],
    edgeIds: ['e37', 'e38', 'e40'],
  },
];

const RISKS = [
  {
    id: 'risk-1',
    title: '同步跨系统调用无熔断 / 退避',
    detail: '订单 → 支付双向链路失败会直接回传给用户请求，建议补上超时、重试预算与熔断阈值。',
    severity: 'critical' as const,
    nodeIds: ['order-api-01', 'order-api-02', 'pay-api-01'],
    edgeIds: ['e30', 'e31', 'e43', 'e44'],
  },
  {
    id: 'risk-2',
    title: '共享 Redis 出现跨系统读写',
    detail: '支付中心与平台门户直接读写订单 Redis 集群，故障域与权限边界不清晰。',
    severity: 'warning' as const,
    nodeIds: ['redis-order-01', 'pay-api-01', 'portal-web-01'],
    edgeIds: ['e17', 'e36', 'e42'],
  },
  {
    id: 'risk-3',
    title: '外部依赖单点出口',
    detail: '支付宝与短信服务商均只有 1 个可见出口 IP，缺少备用通道与降级开关。',
    severity: 'warning' as const,
    nodeIds: ['ext-alipay', 'ext-sms'],
    edgeIds: ['e37', 'e40', 'e41'],
  },
];

const HOT_PATHS = (factor: number) => [
  {
    label: '下单主链路',
    nodeIds: ['gw-sh-01', 'order-api-01', 'redis-order-01', 'pg-order-01'],
    edgeIds: ['e01', 'e19', 'e22'],
    connections: Math.round(5200 * factor),
  },
  {
    label: '支付收单链路',
    nodeIds: ['gw-sh-01', 'pay-api-01', 'pg-pay-01', 'ext-alipay'],
    edgeIds: ['e08', 'e33', 'e37'],
    connections: Math.round(2300 * factor),
  },
  {
    label: '门户首页与通知',
    nodeIds: ['gw-sh-01', 'portal-web-01', 'notify-01', 'ext-sms'],
    edgeIds: ['e05', 'e16', 'e40'],
    connections: Math.round(2680 * factor),
  },
];

function computeMetrics(
  nodeId: string,
  edges: readonly TopologyEdge[],
): TopologyNodeMetrics {
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
  return {
    active,
    opened: Math.max(opened, active),
    closed: Math.max(0, opened - active),
    failed,
    inbound,
    outbound,
  };
}

const SYSTEM_NODE_IDS: Readonly<Record<string, readonly string[]>> = {
  'sys-order': ['order-api-01', 'order-api-02', 'order-job-01', 'redis-order-01', 'pg-order-01'],
  'sys-pay': ['pay-api-01', 'kafka-pay-01', 'pg-pay-01'],
  'sys-portal': ['gw-sh-01', 'gw-sz-01', 'portal-web-01', 'notify-01'],
};

const SYSTEMS: readonly TopologySystemGroup[] = [
  { id: 'sys-order', name: '订单中心', code: 'ORDER', criticality: 'P0', nodeIds: SYSTEM_NODE_IDS['sys-order'] ?? [] },
  { id: 'sys-pay', name: '支付中心', code: 'PAY', criticality: 'P0', nodeIds: SYSTEM_NODE_IDS['sys-pay'] ?? [] },
  { id: 'sys-portal', name: '平台门户', code: 'PORTAL', criticality: 'P1', nodeIds: SYSTEM_NODE_IDS['sys-portal'] ?? [] },
];

function buildGraph(config: GraphVersionConfig): TopologyGraph {
  const { version, ageMinutes, factor } = config;
  const edges = EDGE_SPECS.map((edge) => scaleEdge(edge, factor));
  const nodes: TopologyNode[] = NODE_SPECS.map((spec) => {
    const computed = computeMetrics(spec.id, edges);
    const metrics: TopologyNodeMetrics = { ...computed, ...spec.metrics };
    return {
      id: spec.id,
      label: spec.label,
      kind: spec.kind,
      tier: spec.tier,
      status: spec.status,
      services: spec.services,
      metrics,
      ...(spec.hostname ? { hostname: spec.hostname } : {}),
      ...(spec.ip ? { ip: spec.ip } : {}),
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
      model: 'opsagent-topology-analyzer',
      promptVersion: 'topology-v1',
      generatedAt,
      confidence: version === 3 ? 0.86 : 0.79,
      durationMs: 8420,
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
      reportingAgents: 12,
    },
    createdAt: generatedAt,
    version,
  };
}

function scaleEdge(edge: EdgeSpec, factor: number): TopologyEdge {
  const count = Math.max(1, Math.round(edge.count * factor));
  const opened = Math.max(count, Math.round((edge.opened ?? edge.count) * factor));
  const failed = Math.max(0, Math.round((edge.failed ?? 0) * factor));
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    protocol: edge.protocol,
    port: edge.port,
    count,
    opened,
    failed,
    confidence: 1,
    label: edge.label,
    countBasis: 'observed',
    direction: 'out',
    ...(edge.processes ? { processes: edge.processes } : {}),
    ...(edge.external ? { external: true } : {}),
  };
}

export const DEMO_GRAPHS: readonly TopologyGraph[] = [
  buildGraph({ version: 3, ageMinutes: 8, factor: 1, summary: BASE_SUMMARY }),
  buildGraph({
    version: 2,
    ageMinutes: 128,
    factor: 0.86,
    summary: '窗口内学习到 14 个节点、46 条建连关系。整体连接量较上一版下降 14%，支付回调失败率维持在 6.8%。',
  }),
  buildGraph({
    version: 1,
    ageMinutes: 1500,
    factor: 0.72,
    summary: '首次学习生成：识别出 3 个业务系统与 14 台主机，入口流量与外部依赖已收敛，跨系统链路仍待补充采集。',
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
  lastRunAt: iso(-8 * 60_000),
  nextRunAt: iso(6 * 3_600_000 - 8 * 60_000),
  updatedAt: iso(-2 * 86_400_000),
};

export function demoPolicy(input: Partial<TopologyLearningPolicy>): TopologyLearningPolicy {
  return { ...DEMO_POLICY, ...input, updatedAt: new Date().toISOString() };
}

export function demoSessionScope(appSystemId: string | null): TopologyLearningSession['scope'] {
  if (!appSystemId) return { kind: 'tenant' };
  return {
    kind: 'app-system',
    appSystemId,
    appSystemName: APP_SYSTEM_NAME.get(appSystemId) ?? appSystemId,
  };
}

export function demoLearningSession(
  windowSeconds: number,
  appSystemId: string | null,
  elapsedSeconds = 0,
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
    progress: {
      elapsedSeconds,
      remainingSeconds: Math.max(0, windowSeconds - elapsedSeconds),
      percent: Math.round(percent * 1000) / 1000,
      reportingAgents: Math.round(12 * Math.min(1, percent * 1.6)),
      expectedAgents: 12,
      edgeSamples: Math.round(28640 * percent),
      uniqueEdges: Math.round(48 * Math.min(1, percent * 1.4)),
      phase: percent < 1 ? 'collecting' : 'analyzing',
    },
    graphId: percent >= 1 ? DEMO_GRAPH.id : null,
    model: percent >= 1 ? DEMO_GRAPH.analysis.model : null,
    fallback: false,
    error: null,
    ...(percent >= 1 ? { stats: DEMO_GRAPH.stats } : {}),
  };
}

/** 演示模式用：按秒推进一个学习会话（不请求后端）。 */
export function advanceDemoSession(
  session: TopologyLearningSession,
  stepSeconds = 1,
): TopologyLearningSession {
  const elapsed = session.progress.elapsedSeconds + stepSeconds;
  const total = Math.max(1, session.windowSeconds);
  const percent = Math.min(1, elapsed / total);
  const analyzing = percent >= 1;
  const phase: TopologyLearningSession['status'] = analyzing ? 'ready' : 'collecting';
  return {
    ...session,
    status: phase,
    updatedAt: new Date().toISOString(),
    progress: {
      ...session.progress,
      elapsedSeconds: elapsed,
      remainingSeconds: Math.max(0, total - elapsed),
      percent: Math.round(percent * 1000) / 1000,
      reportingAgents: Math.round(12 * Math.min(1, percent * 1.6)),
      edgeSamples: Math.round(28640 * Math.min(1, percent + 0.04)),
      uniqueEdges: Math.round(48 * Math.min(1, percent * 1.35)),
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
