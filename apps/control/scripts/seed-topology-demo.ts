/**
 * 访问拓扑演示数据：13 台主机 / 3 个业务系统 / 37 条逻辑建连边。
 *
 * 分两个阶段：
 *   1) 数据库阶段（幂等）：upsert app_systems、agents（status=online, last_seen=now()）、
 *      agent_inventory（port/process 行，聚合端从这里解析监听服务名）。
 *   2) 学习阶段（走真实管线）：登录 → 创建/复用固定时间窗学习会话 →
 *      调 POST /api/topologies/learn/:id/samples 注入 connectionWindows 边样本 →
 *      轮询会话到 ready → 校验 GET /api/topologies/latest 的拓扑结果。
 *
 * 用法（控制面已起来时）：
 *   pnpm --filter @opsagent/control seed:topology
 * 只灌主机、不跑学习（学习 API 未就绪时自测）：
 *   SEED_TOPO_SKIP_LEARNING=1 pnpm --filter @opsagent/control seed:topology
 *
 * 环境变量：
 *   DATABASE_URL                 默认 postgres://opsagent:opsagent@localhost:5432/opsagent
 *   OPSAGENT_CONTROL_URL         默认 http://127.0.0.1:8080
 *   LOCAL_ADMIN_USERNAME/PASSWORD 默认 tenant-admin / opsagent-dev
 *   SEED_TOPO_WINDOW_SECONDS     学习窗口，默认 120
 *   SEED_TOPO_SKIP_LEARNING      =1 时只跑数据库阶段
 *   SEED_TOPO_FORCE_NEW_SESSION  =1 时忽略进行中的会话，强制新建
 *   SEED_TOPO_EXPECT_FALLBACK    默认 true；模型 mock 联调时设 0
 */
import { Pool } from 'pg';

const databaseUrl =
  process.env.DATABASE_URL ?? 'postgres://opsagent:opsagent@localhost:5432/opsagent';
const controlUrl = (process.env.OPSAGENT_CONTROL_URL ?? 'http://127.0.0.1:8080').replace(/\/+$/, '');
const adminUsername = process.env.LOCAL_ADMIN_USERNAME ?? 'tenant-admin';
const adminPassword = process.env.LOCAL_ADMIN_PASSWORD ?? 'opsagent-dev';
const windowSeconds = Number.parseInt(process.env.SEED_TOPO_WINDOW_SECONDS ?? '120', 10);
const skipLearning = process.env.SEED_TOPO_SKIP_LEARNING === '1';
const forceNewSession = process.env.SEED_TOPO_FORCE_NEW_SESSION === '1';
// auto：按是否配置了 active 模型决定期望（无模型→启发式兜底 true；有模型→大模型路径 false）。
// 可选显式覆盖：SEED_TOPO_EXPECT_FALLBACK=1 强制要求兜底，=0 强制要求大模型路径。
const fallbackMode = (process.env.SEED_TOPO_EXPECT_FALLBACK ?? 'auto').trim().toLowerCase();
let expectFallback = fallbackMode === '1';

const tenant = '00000000-0000-4000-8000-000000000001';

const APP_SYSTEMS = [
  {
    id: 'f0000000-0000-4000-8000-000000000001',
    code: 'order-center',
    name: '订单中心',
    owner: '交易研发组',
    criticality: 'P1',
  },
  {
    id: 'f0000000-0000-4000-8000-000000000002',
    code: 'payment-gateway',
    name: '支付网关',
    owner: '支付研发组',
    criticality: 'P1',
  },
  {
    id: 'f0000000-0000-4000-8000-000000000003',
    code: 'platform-runtime',
    name: '基础运行平台',
    owner: '基础架构组',
    criticality: 'P2',
  },
] as const;

type AppSystemCode = (typeof APP_SYSTEMS)[number]['code'];

interface ListenerDef {
  readonly port: number;
  readonly process: string;
  readonly pid: number;
  readonly service: string;
}

interface ProcessDef {
  readonly name: string;
  readonly pid: number;
  readonly command: string;
  readonly user: string;
}

interface HostDef {
  readonly id: string;
  readonly name: string;
  readonly appSystem: AppSystemCode;
  readonly ip: string;
  readonly osName: string;
  readonly osVersion: string;
  readonly cpu: number;
  readonly mem: number;
  readonly diskTotal: number;
  readonly diskFree: number;
  readonly listeners: readonly ListenerDef[];
  readonly processes: readonly ProcessDef[];
  readonly role: string;
}

const HOSTS: readonly HostDef[] = [
  {
    id: 'b0000000-0000-4000-8000-000000000005',
    name: 'gateway-order-01',
    appSystem: 'order-center',
    ip: '10.20.8.11',
    osName: 'Rocky Linux',
    osVersion: '9.4',
    cpu: 4,
    mem: 8,
    diskTotal: 100,
    diskFree: 58,
    role: '接入网关',
    listeners: [
      { port: 80, process: 'nginx', pid: 1180, service: 'nginx' },
      { port: 443, process: 'nginx', pid: 1180, service: 'nginx' },
    ],
    processes: [
      { name: 'nginx', pid: 1180, command: '/usr/sbin/nginx -c /etc/nginx/nginx.conf', user: 'root' },
      { name: 'keepalived', pid: 1105, command: '/usr/sbin/keepalived -D', user: 'root' },
    ],
  },
  {
    id: 'b0000000-0000-4000-8000-000000000001',
    name: 'prod-web-01',
    appSystem: 'order-center',
    ip: '10.20.8.12',
    osName: 'Rocky Linux',
    osVersion: '9.4',
    cpu: 8,
    mem: 16,
    diskTotal: 200,
    diskFree: 128,
    role: '应用/接入',
    listeners: [
      { port: 80, process: 'nginx', pid: 1180, service: 'nginx' },
      { port: 443, process: 'nginx', pid: 1180, service: 'nginx' },
      { port: 8080, process: 'java', pid: 4123, service: 'order-service' },
    ],
    processes: [
      { name: 'nginx', pid: 1180, command: '/usr/sbin/nginx -c /etc/nginx/nginx.conf', user: 'root' },
      {
        name: 'java',
        pid: 4123,
        command:
          'java -Xms2g -Xmx4g -jar /opt/order/order-service.jar --spring.profiles.active=prod',
        user: 'order',
      },
    ],
  },
  {
    id: 'b0000000-0000-4000-8000-000000000002',
    name: 'prod-order-12',
    appSystem: 'order-center',
    ip: '10.20.8.34',
    osName: 'Ubuntu',
    osVersion: '22.04',
    cpu: 16,
    mem: 32,
    diskTotal: 500,
    diskFree: 310,
    role: '应用',
    listeners: [{ port: 8080, process: 'java', pid: 5140, service: 'order-service' }],
    processes: [
      {
        name: 'java',
        pid: 5140,
        command:
          'java -Xms4g -Xmx8g -jar /opt/order/order-service.jar --spring.profiles.active=prod',
        user: 'order',
      },
      {
        name: 'java',
        pid: 5301,
        command: 'java -Xms2g -Xmx4g -jar /opt/order/order-worker.jar',
        user: 'order',
      },
    ],
  },
  {
    id: 'b0000000-0000-4000-8000-000000000006',
    name: 'prod-order-13',
    appSystem: 'order-center',
    ip: '10.20.8.35',
    osName: 'Ubuntu',
    osVersion: '22.04',
    cpu: 16,
    mem: 32,
    diskTotal: 500,
    diskFree: 286,
    role: '应用',
    listeners: [{ port: 8080, process: 'java', pid: 6032, service: 'order-service' }],
    processes: [
      {
        name: 'java',
        pid: 6032,
        command:
          'java -Xms4g -Xmx8g -jar /opt/order/order-service.jar --spring.profiles.active=prod',
        user: 'order',
      },
      {
        name: 'java',
        pid: 6210,
        command: 'java -Xms2g -Xmx4g -jar /opt/order/order-worker.jar',
        user: 'order',
      },
    ],
  },
  {
    id: 'b0000000-0000-4000-8000-000000000007',
    name: 'prod-mysql-01',
    appSystem: 'order-center',
    ip: '10.20.8.61',
    osName: 'Rocky Linux',
    osVersion: '9.4',
    cpu: 16,
    mem: 64,
    diskTotal: 1000,
    diskFree: 540,
    role: '数据库',
    listeners: [
      { port: 3306, process: 'mysqld', pid: 2310, service: 'mysqld' },
      { port: 9100, process: 'node_exporter', pid: 2450, service: 'node_exporter' },
    ],
    processes: [
      { name: 'mysqld', pid: 2310, command: '/usr/sbin/mysqld --defaults-file=/etc/my.cnf', user: 'mysql' },
      {
        name: 'node_exporter',
        pid: 2450,
        command: '/usr/local/bin/node_exporter --collector.systemd',
        user: 'prometheus',
      },
    ],
  },
  {
    id: 'b0000000-0000-4000-8000-000000000008',
    name: 'gateway-pay-01',
    appSystem: 'payment-gateway',
    ip: '10.20.9.11',
    osName: 'Rocky Linux',
    osVersion: '9.4',
    cpu: 4,
    mem: 8,
    diskTotal: 100,
    diskFree: 70,
    role: '接入网关',
    listeners: [
      { port: 443, process: 'nginx', pid: 1210, service: 'nginx' },
      { port: 8443, process: 'nginx', pid: 1210, service: 'nginx' },
    ],
    processes: [
      { name: 'nginx', pid: 1210, command: '/usr/sbin/nginx -c /etc/nginx/nginx.conf', user: 'root' },
      { name: 'keepalived', pid: 1120, command: '/usr/sbin/keepalived -D', user: 'root' },
    ],
  },
  {
    id: 'b0000000-0000-4000-8000-000000000009',
    name: 'prod-pay-01',
    appSystem: 'payment-gateway',
    ip: '10.20.9.12',
    osName: 'Ubuntu',
    osVersion: '22.04',
    cpu: 8,
    mem: 16,
    diskTotal: 200,
    diskFree: 150,
    role: '应用',
    listeners: [{ port: 8080, process: 'java', pid: 7102, service: 'payment-service' }],
    processes: [
      {
        name: 'java',
        pid: 7102,
        command:
          'java -Xms2g -Xmx4g -jar /opt/pay/payment-service.jar --spring.profiles.active=prod',
        user: 'pay',
      },
      {
        name: 'java',
        pid: 7260,
        command: 'java -Xms1g -Xmx2g -jar /opt/pay/payment-worker.jar',
        user: 'pay',
      },
    ],
  },
  {
    id: 'b0000000-0000-4000-8000-00000000000a',
    name: 'prod-pay-02',
    appSystem: 'payment-gateway',
    ip: '10.20.9.13',
    osName: 'Ubuntu',
    osVersion: '22.04',
    cpu: 8,
    mem: 16,
    diskTotal: 200,
    diskFree: 140,
    role: '应用',
    listeners: [{ port: 8080, process: 'java', pid: 8102, service: 'payment-service' }],
    processes: [
      {
        name: 'java',
        pid: 8102,
        command:
          'java -Xms2g -Xmx4g -jar /opt/pay/payment-service.jar --spring.profiles.active=prod',
        user: 'pay',
      },
    ],
  },
  {
    id: 'b0000000-0000-4000-8000-00000000000b',
    name: 'prod-mysql-pay-01',
    appSystem: 'payment-gateway',
    ip: '10.20.9.61',
    osName: 'Rocky Linux',
    osVersion: '9.4',
    cpu: 16,
    mem: 64,
    diskTotal: 1000,
    diskFree: 610,
    role: '数据库',
    listeners: [
      { port: 3306, process: 'mysqld', pid: 2610, service: 'mysqld' },
      { port: 9100, process: 'node_exporter', pid: 2700, service: 'node_exporter' },
    ],
    processes: [
      { name: 'mysqld', pid: 2610, command: '/usr/sbin/mysqld --defaults-file=/etc/my.cnf', user: 'mysql' },
      {
        name: 'node_exporter',
        pid: 2700,
        command: '/usr/local/bin/node_exporter --collector.systemd',
        user: 'prometheus',
      },
    ],
  },
  {
    id: 'b0000000-0000-4000-8000-000000000004',
    name: 'prod-cache-01',
    appSystem: 'payment-gateway',
    ip: '10.20.9.45',
    osName: 'Debian',
    osVersion: '12',
    cpu: 4,
    mem: 8,
    diskTotal: 100,
    diskFree: 46,
    role: '缓存',
    listeners: [
      { port: 6379, process: 'redis-server', pid: 1910, service: 'redis' },
      { port: 10050, process: 'zabbix_agent2', pid: 2010, service: 'zabbix-agent2' },
    ],
    processes: [
      {
        name: 'redis-server',
        pid: 1910,
        command: '/usr/bin/redis-server 0.0.0.0:6379',
        user: 'redis',
      },
      { name: 'zabbix_agent2', pid: 2010, command: '/usr/sbin/zabbix_agent2 -c /etc/zabbix/zabbix_agent2.conf', user: 'zabbix' },
    ],
  },
  {
    id: 'b0000000-0000-4000-8000-00000000000c',
    name: 'prod-kafka-01',
    appSystem: 'payment-gateway',
    ip: '10.20.9.31',
    osName: 'Rocky Linux',
    osVersion: '9.4',
    cpu: 8,
    mem: 32,
    diskTotal: 500,
    diskFree: 220,
    role: '消息队列',
    listeners: [{ port: 9092, process: 'java', pid: 3102, service: 'kafka' }],
    processes: [
      {
        name: 'java',
        pid: 3102,
        command: 'java -Xms6g -Xmx6g -server -cp /opt/kafka/libs/* kafka.Kafka /opt/kafka/config/server.properties',
        user: 'kafka',
      },
    ],
  },
  {
    id: 'b0000000-0000-4000-8000-000000000003',
    name: 'prod-db-01',
    appSystem: 'platform-runtime',
    ip: '10.20.9.21',
    osName: 'Rocky Linux',
    osVersion: '9.4',
    cpu: 32,
    mem: 128,
    diskTotal: 2000,
    diskFree: 860,
    role: '数据库',
    listeners: [
      { port: 5432, process: 'postgres', pid: 2810, service: 'postgresql' },
      { port: 9100, process: 'node_exporter', pid: 2900, service: 'node_exporter' },
    ],
    processes: [
      { name: 'postgres', pid: 2810, command: '/usr/pgsql-16/bin/postgres -D /var/lib/pgsql/16/data', user: 'postgres' },
      {
        name: 'node_exporter',
        pid: 2900,
        command: '/usr/local/bin/node_exporter --collector.systemd',
        user: 'prometheus',
      },
    ],
  },
  {
    id: 'b0000000-0000-4000-8000-00000000000d',
    name: 'prod-scheduler-01',
    appSystem: 'platform-runtime',
    ip: '10.20.10.21',
    osName: 'Ubuntu',
    osVersion: '22.04',
    cpu: 8,
    mem: 16,
    diskTotal: 200,
    diskFree: 120,
    role: '调度/监控',
    listeners: [
      { port: 8090, process: 'java', pid: 9001, service: 'scheduler' },
      { port: 9090, process: 'prometheus', pid: 9010, service: 'prometheus' },
    ],
    processes: [
      {
        name: 'java',
        pid: 9001,
        command: 'java -Xms2g -Xmx4g -jar /opt/platform/scheduler.jar',
        user: 'platform',
      },
      {
        name: 'prometheus',
        pid: 9010,
        command: '/opt/prometheus/prometheus --config.file=/etc/prometheus/prometheus.yml',
        user: 'prometheus',
      },
    ],
  },
  {
    id: 'b0000000-0000-4000-8000-00000000000e',
    name: 'prod-monitor-01',
    appSystem: 'platform-runtime',
    ip: '10.20.10.31',
    osName: 'Ubuntu',
    osVersion: '22.04',
    cpu: 16,
    mem: 32,
    diskTotal: 500,
    diskFree: 300,
    role: '监控/可观测',
    listeners: [
      { port: 9090, process: 'prometheus', pid: 3001, service: 'prometheus' },
      { port: 3000, process: 'grafana', pid: 3010, service: 'grafana' },
      { port: 9100, process: 'node_exporter', pid: 3020, service: 'node_exporter' },
    ],
    processes: [
      {
        name: 'prometheus',
        pid: 3001,
        command: '/opt/prometheus/prometheus --config.file=/etc/prometheus/prometheus.yml',
        user: 'prometheus',
      },
      {
        name: 'grafana',
        pid: 3010,
        command: '/usr/share/grafana/bin/grafana server --config=/etc/grafana/grafana.ini',
        user: 'grafana',
      },
      {
        name: 'node_exporter',
        pid: 3020,
        command: '/usr/local/bin/node_exporter',
        user: 'prometheus',
      },
    ],
  },
];

/** 外部依赖（只出方向 out 的边，图中归入 external 层）。 */
const EXTERNAL_PEERS = {
  alipay: { ip: '110.75.32.18', label: '支付宝支付网关', note: '第三方支付渠道' },
  wechatPay: { ip: '121.51.130.5', label: '微信支付网关', note: '第三方支付渠道' },
  unionPay: { ip: '202.101.25.8', label: '银联支付网关', note: '第三方支付渠道' },
  sms: { ip: '47.96.133.21', label: '短信服务商', note: '第三方通知服务' },
  riskApi: { ip: '203.119.128.7', label: '风控 API', note: '外部风控服务' },
  oss: { ip: '47.98.203.9', label: '对象存储 CDN', note: '外部存储依赖' },
} as const;

type ExternalKey = keyof typeof EXTERNAL_PEERS;

/**
 * 37 条逻辑建连边（源进程 → 目标端口）。
 * opened/closed/failed/active 是整个学习窗口（默认 120s）的合计口径。
 */
interface EdgeSpec {
  readonly from: string;
  readonly process: string;
  readonly service: string;
  readonly pid: number;
  readonly to: string | ExternalKey;
  readonly port: number;
  readonly opened: number;
  readonly failed: number;
  readonly active: number;
  readonly protocol?: string;
}

const EDGES: readonly EdgeSpec[] = [
  // ── 接入层 → 应用 ───────────────────────────────────────────────
  { from: 'gateway-order-01', process: 'nginx', service: 'nginx', pid: 1180, to: 'prod-web-01', port: 443, opened: 5200, failed: 0, active: 120 },
  { from: 'gateway-order-01', process: 'nginx', service: 'nginx', pid: 1180, to: 'prod-web-01', port: 80, opened: 1800, failed: 0, active: 40 },
  { from: 'gateway-order-01', process: 'nginx', service: 'nginx', pid: 1180, to: 'prod-order-12', port: 8080, opened: 2600, failed: 0, active: 90 },
  { from: 'gateway-order-01', process: 'nginx', service: 'nginx', pid: 1180, to: 'prod-order-13', port: 8080, opened: 2450, failed: 0, active: 85 },
  { from: 'gateway-pay-01', process: 'nginx', service: 'nginx', pid: 1210, to: 'prod-pay-01', port: 8080, opened: 3100, failed: 0, active: 110 },
  { from: 'gateway-pay-01', process: 'nginx', service: 'nginx', pid: 1210, to: 'prod-pay-02', port: 8080, opened: 3050, failed: 0, active: 105 },

  // ── 应用 → 应用（跨业务系统） ────────────────────────────────────
  { from: 'prod-web-01', process: 'java', service: 'order-service', pid: 4123, to: 'prod-pay-01', port: 8080, opened: 900, failed: 0, active: 30 },
  { from: 'prod-order-12', process: 'java', service: 'order-service', pid: 5140, to: 'prod-pay-01', port: 8080, opened: 640, failed: 0, active: 24 },
  { from: 'prod-order-12', process: 'java', service: 'order-worker', pid: 5301, to: 'prod-pay-02', port: 8080, opened: 520, failed: 0, active: 18 },
  { from: 'prod-order-13', process: 'java', service: 'order-service', pid: 6032, to: 'prod-pay-02', port: 8080, opened: 580, failed: 0, active: 20 },
  { from: 'prod-pay-01', process: 'java', service: 'payment-service', pid: 7102, to: 'prod-order-12', port: 8080, opened: 310, failed: 0, active: 12 },
  { from: 'prod-scheduler-01', process: 'java', service: 'scheduler', pid: 9001, to: 'prod-order-13', port: 8080, opened: 120, failed: 0, active: 6 },
  { from: 'prod-scheduler-01', process: 'java', service: 'scheduler', pid: 9001, to: 'prod-pay-01', port: 8080, opened: 110, failed: 0, active: 6 },

  // ── 应用 → MySQL ────────────────────────────────────────────────
  { from: 'prod-web-01', process: 'java', service: 'order-service', pid: 4123, to: 'prod-mysql-01', port: 3306, opened: 180, failed: 2, active: 40 },
  { from: 'prod-order-12', process: 'java', service: 'order-service', pid: 5140, to: 'prod-mysql-01', port: 3306, opened: 220, failed: 0, active: 50 },
  { from: 'prod-order-12', process: 'java', service: 'order-worker', pid: 5301, to: 'prod-mysql-01', port: 3306, opened: 90, failed: 0, active: 16 },
  { from: 'prod-order-13', process: 'java', service: 'order-service', pid: 6032, to: 'prod-mysql-01', port: 3306, opened: 210, failed: 42, active: 35 },
  { from: 'prod-pay-01', process: 'java', service: 'payment-service', pid: 7102, to: 'prod-mysql-pay-01', port: 3306, opened: 160, failed: 0, active: 38 },
  { from: 'prod-pay-02', process: 'java', service: 'payment-service', pid: 8102, to: 'prod-mysql-pay-01', port: 3306, opened: 150, failed: 0, active: 36 },

  // ── 应用 → Redis ────────────────────────────────────────────────
  { from: 'prod-web-01', process: 'java', service: 'order-service', pid: 4123, to: 'prod-cache-01', port: 6379, opened: 780, failed: 0, active: 60 },
  { from: 'prod-order-12', process: 'java', service: 'order-worker', pid: 5301, to: 'prod-cache-01', port: 6379, opened: 610, failed: 0, active: 45 },
  { from: 'prod-pay-01', process: 'java', service: 'payment-service', pid: 7102, to: 'prod-cache-01', port: 6379, opened: 940, failed: 0, active: 72 },

  // ── 应用 → Kafka ────────────────────────────────────────────────
  { from: 'prod-pay-01', process: 'java', service: 'payment-service', pid: 7102, to: 'prod-kafka-01', port: 9092, opened: 260, failed: 0, active: 25 },
  { from: 'prod-order-12', process: 'java', service: 'order-worker', pid: 5301, to: 'prod-kafka-01', port: 9092, opened: 180, failed: 0, active: 18 },

  // ── 应用 → 平台 PostgreSQL ──────────────────────────────────────
  { from: 'prod-scheduler-01', process: 'java', service: 'scheduler', pid: 9001, to: 'prod-db-01', port: 5432, opened: 60, failed: 0, active: 10 },
  { from: 'prod-pay-02', process: 'java', service: 'payment-service', pid: 8102, to: 'prod-db-01', port: 5432, opened: 45, failed: 0, active: 8 },

  // ── 应用 → 外部第三方（异常链路：支付 → 支付宝 40% 失败） ─────────
  { from: 'prod-pay-01', process: 'java', service: 'payment-service', pid: 7102, to: 'alipay', port: 443, opened: 240, failed: 96, active: 3 },
  { from: 'prod-pay-02', process: 'java', service: 'payment-service', pid: 8102, to: 'wechatPay', port: 443, opened: 180, failed: 6, active: 2 },
  { from: 'prod-pay-01', process: 'java', service: 'payment-service', pid: 7102, to: 'unionPay', port: 443, opened: 65, failed: 1, active: 1 },
  { from: 'prod-web-01', process: 'java', service: 'order-service', pid: 4123, to: 'sms', port: 443, opened: 95, failed: 2, active: 1 },
  { from: 'prod-order-13', process: 'java', service: 'order-service', pid: 6032, to: 'riskApi', port: 443, opened: 140, failed: 4, active: 2 },
  { from: 'prod-order-12', process: 'java', service: 'order-service', pid: 5140, to: 'riskApi', port: 443, opened: 130, failed: 3, active: 2 },
  { from: 'prod-scheduler-01', process: 'java', service: 'scheduler', pid: 9001, to: 'oss', port: 443, opened: 20, failed: 0, active: 1 },

  // ── 监控 / upstream ────────────────────────────────────────────
  { from: 'prod-scheduler-01', process: 'prometheus', service: 'prometheus', pid: 9010, to: 'prod-mysql-01', port: 9100, opened: 60, failed: 0, active: 1 },
  { from: 'prod-scheduler-01', process: 'prometheus', service: 'prometheus', pid: 9010, to: 'prod-db-01', port: 9100, opened: 60, failed: 0, active: 1 },
  { from: 'prod-scheduler-01', process: 'prometheus', service: 'prometheus', pid: 9010, to: 'prod-mysql-pay-01', port: 9100, opened: 60, failed: 0, active: 1 },
  { from: 'prod-web-01', process: 'nginx', service: 'nginx', pid: 1180, to: 'prod-order-12', port: 8080, opened: 1200, failed: 0, active: 55 },
] as const;

const WINDOW_COUNT = Math.max(1, Math.ceil(windowSeconds / 10));

const systemById = new Map(APP_SYSTEMS.map((system) => [system.id, system]));
const systemByCode = new Map(APP_SYSTEMS.map((system) => [system.code, system]));
const hostByName = new Map(HOSTS.map((host) => [host.name, host]));
const hostById = new Map(HOSTS.map((host) => [host.id, host]));

function listenerOf(host: HostDef, port: number): ListenerDef | undefined {
  return host.listeners.find((listener) => listener.port === port);
}

function externalTarget(key: ExternalKey): { ip: string; label: string } {
  return EXTERNAL_PEERS[key];
}

/** 把窗口合计值按 10s 窗口均摊；余数从中间窗口开始各补 1，保证总和精确。 */
function distribute(total: number, windows: number, index: number, offset = 0): number {
  const base = Math.floor(total / windows);
  const remainder = total - base * windows;
  const start = Math.floor((windows - remainder) / 2) + offset;
  const position = (index - start + windows) % windows;
  return base + (position < remainder ? 1 : 0);
}

function buildWindows(startedAt: Date, edgesForHost: readonly {
  direction: 'out' | 'in';
  process: string;
  pid: number;
  service: string;
  command: string;
  localAddress: string;
  localPort: number;
  peerAddress: string;
  peerPort: number;
  protocol: string;
  opened: number;
  closed: number;
  failed: number;
  active: number;
}[]): Array<Record<string, unknown>> {
  const windows: Array<Record<string, unknown>> = [];
  for (let index = 0; index < WINDOW_COUNT; index += 1) {
    const start = new Date(startedAt.getTime() + index * 10_000);
    const end = new Date(start.getTime() + 10_000);
    const edges = edgesForHost.map((edge) => ({
      direction: edge.direction,
      process: edge.process,
      pid: edge.pid,
      service: edge.service,
      command: edge.command,
      localAddress: edge.localAddress,
      localPort: edge.localPort,
      peerAddress: edge.peerAddress,
      peerPort: edge.peerPort,
      protocol: edge.protocol,
      opened: distribute(edge.opened, WINDOW_COUNT, index),
      closed: distribute(edge.closed, WINDOW_COUNT, index),
      failed: distribute(edge.failed, WINDOW_COUNT, index),
      // active 是并发快照：只放在最后一个窗口，避免窗口求和放大。
      active: index === WINDOW_COUNT - 1 ? edge.active : 0,
      baseline: false,
      container: '',
      firstSeen: start.toISOString(),
      lastSeen: end.toISOString(),
    }));
    windows.push({
      start: start.toISOString(),
      end: end.toISOString(),
      source: 'procfs',
      edges,
      stats: { scans: 2, activeConnections: edges.reduce((sum, edge) => sum + edge.active, 0), dropped: 0 },
    });
  }
  return windows;
}

type AgentWindows = Map<string, Array<Record<string, unknown>>>;

function buildReports(startedAt: Date): AgentWindows {
  type EdgeRow = {
    direction: 'out' | 'in';
    process: string;
    pid: number;
    service: string;
    command: string;
    localAddress: string;
    localPort: number;
    peerAddress: string;
    peerPort: number;
    protocol: string;
    opened: number;
    closed: number;
    failed: number;
    active: number;
  };
  const byAgent = new Map<string, EdgeRow[]>();
  const push = (agentId: string, row: EdgeRow): void => {
    const list = byAgent.get(agentId) ?? [];
    list.push(row);
    byAgent.set(agentId, list);
  };
  EDGES.forEach((edge, index) => {
    const source = hostByName.get(edge.from);
    if (!source) throw new Error(`边 ${index} 的源主机不存在: ${edge.from}`);
    const targetIsManaged = !(edge.to in EXTERNAL_PEERS);
    const targetHost = targetIsManaged ? hostByName.get(edge.to) : undefined;
    const peerIp = targetIsManaged ? targetHost!.ip : externalTarget(edge.to as ExternalKey).ip;
    const peerPort = edge.port;
    const sourceProcess = source.processes.find((item) => item.pid === edge.pid);
    const command = sourceProcess?.command ?? edge.process;
    const closed = Math.max(0, edge.opened - edge.failed - edge.active);
    const localPort = 41_000 + index;
    push(source.id, {
      direction: 'out',
      process: edge.process,
      pid: edge.pid,
      service: edge.service,
      command,
      localAddress: source.ip,
      localPort,
      peerAddress: peerIp,
      peerPort,
      protocol: edge.protocol ?? 'tcp',
      opened: edge.opened,
      closed,
      failed: edge.failed,
      active: edge.active,
    });
    if (targetIsManaged && targetHost) {
      const listener = listenerOf(targetHost, peerPort);
      if (!listener) return;
      push(targetHost.id, {
        direction: 'in',
        process: listener.process,
        pid: listener.pid,
        service: listener.service,
        command:
          targetHost.processes.find((item) => item.pid === listener.pid)?.command ??
          listener.process,
        localAddress: targetHost.ip,
        localPort: peerPort,
        peerAddress: source.ip,
        peerPort: 40_000 + index,
        protocol: edge.protocol ?? 'tcp',
        opened: edge.opened,
        closed,
        failed: edge.failed,
        active: edge.active,
      });
    }
  });
  const reports: AgentWindows = new Map();
  for (const [agentId, edges] of byAgent) {
    reports.set(agentId, buildWindows(startedAt, edges));
  }
  return reports;
}

async function seedDatabase(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const system of APP_SYSTEMS) {
      await client.query(
        `INSERT INTO app_systems (id, tenant_id, code, name, owner, criticality)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO UPDATE SET
           code = EXCLUDED.code, name = EXCLUDED.name,
           owner = EXCLUDED.owner, criticality = EXCLUDED.criticality`,
        [system.id, tenant, system.code, system.name, system.owner, system.criticality],
      );
    }

    for (const host of HOSTS) {
      const system = systemByCode.get(host.appSystem)!;
      const listeningPorts = host.listeners.map((listener) => listener.port);
      const systemInfo = {
        hostname: host.name,
        ip: host.ip,
        ipAddresses: [host.ip],
        osName: host.osName,
        osVersion: host.osVersion,
        osPretty: `${host.osName} ${host.osVersion}`,
        kernel: '5.14.0-427.el9.x86_64',
        virtualization: 'kvm',
        cpuCores: host.cpu,
        memoryTotalGB: host.mem,
        diskTotalGB: host.diskTotal,
        diskFreeGB: host.diskFree,
        uptimeSec: 86_400 * 21,
        timezone: 'Asia/Shanghai',
        packageManager: host.osName === 'Ubuntu' || host.osName === 'Debian' ? 'apt-get' : 'dnf',
        listeningPorts,
      };
      const applications = host.listeners.map((listener) => ({
        name: listener.service,
        kind: 'systemd',
        status: 'running',
        deploy: 'systemd',
        ports: [listener.port],
        version: listener.service === 'nginx' ? '1.24.0' : '2.4.1',
      }));
      const agentInfo = {
        version: '0.2.0',
        installPath: '/opt/opsagent/bin/opsagent-agent',
        homePath: '/opt/opsagent',
        serviceName: 'opsagent-agent',
        serviceStatus: 'running',
        configPath: '/opt/opsagent/config/agent.env',
        logPath: '/opt/opsagent/logs/agent.log',
        snapshotPath: '/opt/opsagent/snapshots',
        toolsPath: '/opt/opsagent/tools',
        startedAt: new Date(Date.now() - 1000 * 60 * 90).toISOString(),
        capabilities: [
          'system.discover',
          'applications.discover',
          'metrics',
          'diagnostics',
          'self.patrol',
          'inspect',
          'snapshot',
        ],
      };
      const metrics = {
        cpuCores: host.cpu,
        heapMB: 24,
        goroutines: 12,
        uptimeSec: 86_400,
        memTotalGB: host.mem,
        memAvailableGB: Math.round(host.mem * 0.56),
        memLoadPct: 44,
        diskTotalGB: host.diskTotal,
        diskFreeGB: host.diskFree,
      };
      await client.query(
        `INSERT INTO agents
           (id, tenant_id, name, hostname, os, arch, version, status, capabilities, agent_key,
            last_seen, metrics, app_system_id, system_info, applications, agent_info, tags, discovery_at)
         VALUES ($1, $2, $3, $3, 'linux', 'amd64', '0.2.0', 'online',
                 $4::jsonb, $5, now(), $6::jsonb, $7,
                 $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb, now())
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name, hostname = EXCLUDED.hostname,
           status = 'online', last_seen = now(),
           capabilities = EXCLUDED.capabilities,
           metrics = EXCLUDED.metrics,
           app_system_id = EXCLUDED.app_system_id,
           system_info = EXCLUDED.system_info,
           applications = EXCLUDED.applications,
           agent_info = EXCLUDED.agent_info,
           discovery_at = now()`,
        [
          host.id,
          tenant,
          host.name,
          JSON.stringify(['cpu', 'memory', 'disk', 'network', 'system.discover', 'applications.discover']),
          `demo-agent-key-${host.id}`,
          JSON.stringify(metrics),
          system.id,
          JSON.stringify(systemInfo),
          JSON.stringify(applications),
          JSON.stringify(agentInfo),
          JSON.stringify(['prod', 'discovered', host.role]),
        ],
      );

      // 先清空该演示主机的 inventory，避免旧端口/进程残留造成图上的幽灵节点。
      await client.query(
        'DELETE FROM agent_inventory WHERE tenant_id = $1 AND agent_id = $2',
        [tenant, host.id],
      );
      for (const listener of host.listeners) {
        const processDef = host.processes.find((item) => item.pid === listener.pid);
        const detail = {
          address: '0.0.0.0',
          port: listener.port,
          process: listener.process,
          pid: listener.pid,
          service: listener.service,
          protocol: 'tcp',
          command: processDef?.command ?? '',
        };
        for (const name of [`0.0.0.0:${listener.port}`, `${host.ip}:${listener.port}`]) {
          await client.query(
            `INSERT INTO agent_inventory (tenant_id, agent_id, kind, name, detail, important, monitored, app_system_id)
             VALUES ($1, $2, 'port', $3, $4::jsonb, true, true, $5)
             ON CONFLICT (tenant_id, agent_id, kind, name)
             DO UPDATE SET detail = EXCLUDED.detail, app_system_id = EXCLUDED.app_system_id, updated_at = now()`,
            [tenant, host.id, name, JSON.stringify(detail), system.id],
          );
        }
      }
      for (const processDef of host.processes) {
        await client.query(
          `INSERT INTO agent_inventory (tenant_id, agent_id, kind, name, detail, important, monitored, app_system_id)
           VALUES ($1, $2, 'process', $3, $4::jsonb, true, true, $5)
           ON CONFLICT (tenant_id, agent_id, kind, name)
           DO UPDATE SET detail = EXCLUDED.detail, app_system_id = EXCLUDED.app_system_id, updated_at = now()`,
          [
            tenant,
            host.id,
            processDef.name,
            JSON.stringify({
              name: processDef.name,
              pid: processDef.pid,
              command: processDef.command,
              user: processDef.user,
            }),
            system.id,
          ],
        );
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// 学习阶段：走真实 HTTP 管线（登录 → 建会话 → 注入样本 → 等聚合 → 校验）
// ---------------------------------------------------------------------------

interface ApiResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly setCookie: string | null;
}

async function call(
  method: string,
  path: string,
  cookie: string | null,
  body?: unknown,
): Promise<ApiResult> {
  const response = await fetch(`${controlUrl}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(cookie ? { cookie } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  if (text) {
    try {
      const value = JSON.parse(text) as unknown;
      parsed = typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : { value };
    } catch {
      parsed = { raw: text.slice(0, 500) };
    }
  }
  const setCookie =
    typeof response.headers.getSetCookie === 'function'
      ? (response.headers.getSetCookie()[0] ?? null)
      : response.headers.get('set-cookie');
  return { status: response.status, body: parsed, setCookie };
}

function cookieHeader(setCookie: string | null): string {
  if (!setCookie) return '';
  return (setCookie.split(';')[0] ?? '').trim();
}

async function login(): Promise<string> {
  const result = await call('POST', '/api/auth/local-admin', null, {
    username: adminUsername,
    password: adminPassword,
    remember: true,
  });
  if (result.status !== 200) {
    throw new Error(`登录失败 status=${result.status} body=${JSON.stringify(result.body)}`);
  }
  const cookie = cookieHeader(result.setCookie);
  if (!cookie) throw new Error('登录成功但没有拿到 opsagent_session cookie');
  return cookie;
}

function unwrapSession(body: Record<string, unknown>): Record<string, unknown> | null {
  const candidate =
    (body.session as Record<string, unknown> | undefined) ??
    (body.value as Record<string, unknown> | undefined) ??
    body;
  if (typeof candidate?.id === 'string' || typeof candidate?.sessionId === 'string') {
    return candidate;
  }
  return null;
}

function sessionIdOf(session: Record<string, unknown>): string {
  return String(session.id ?? session.sessionId ?? '');
}

async function findActiveSession(cookie: string): Promise<Record<string, unknown> | null> {
  const result = await call('GET', '/api/topologies/learn/active', cookie);
  if (result.status === 204 || result.status === 404) return null;
  if (result.status !== 200) {
    throw new Error(`查询进行中会话失败 status=${result.status} body=${JSON.stringify(result.body)}`);
  }
  const session = unwrapSession(result.body);
  if (!session) return null;
  const status = String(session.status ?? '');
  if (!['collecting', 'aggregating', 'analyzing'].includes(status)) return null;
  // 剩余时间不足以再注入 12 个 10s 窗口时，新建会话，避免样本落在会话窗口之外。
  const endsAt = Date.parse(String(session.endsAt ?? session.ends_at ?? ''));
  if (!Number.isNaN(endsAt) && endsAt - Date.now() < 30_000) return null;
  return session;
}

async function createSession(cookie: string): Promise<Record<string, unknown>> {
  const result = await call('POST', '/api/topologies/learn', cookie, { windowSeconds });
  if (result.status !== 200 && result.status !== 201) {
    throw new Error(
      `创建学习会话失败 status=${result.status} body=${JSON.stringify(result.body)}` +
        (result.status === 404 ? '（T2 的 /api/topologies 路由尚未上线？）' : ''),
    );
  }
  const session = unwrapSession(result.body);
  if (!session) throw new Error(`创建学习会话响应无法解析: ${JSON.stringify(result.body)}`);
  return session;
}

async function injectSamples(
  cookie: string,
  session: Record<string, unknown>,
  reports: AgentWindows,
): Promise<number> {
  const sessionId = sessionIdOf(session);
  let injected = 0;
  for (const [agentId, windows] of reports) {
    const result = await call('POST', `/api/topologies/learn/${sessionId}/samples`, cookie, {
      agentId,
      windows,
    });
    if (result.status === 404) {
      throw new Error(
        `注入样本接口 404（POST /api/topologies/learn/${sessionId}/samples 尚未上线）：` +
          JSON.stringify(result.body),
      );
    }
    if (result.status < 200 || result.status >= 300) {
      throw new Error(
        `注入样本失败 agent=${agentId} status=${result.status} body=${JSON.stringify(result.body).slice(0, 500)}`,
      );
    }
    injected += windows.reduce(
      (sum, window) => sum + ((window.edges as unknown[] | undefined)?.length ?? 0),
      0,
    );
  }
  return injected;
}

async function waitForReady(
  cookie: string,
  session: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const sessionId = sessionIdOf(session);
  const deadline = Date.now() + (windowSeconds + 90) * 1000;
  let last: Record<string, unknown> = session;
  while (Date.now() < deadline) {
    const result = await call('GET', `/api/topologies/learn/${sessionId}`, cookie);
    if (result.status !== 200) {
      throw new Error(`查询学习会话失败 status=${result.status} body=${JSON.stringify(result.body)}`);
    }
    const current = unwrapSession(result.body);
    if (current) {
      last = current;
      const status = String(current.status ?? '');
      if (status === 'ready' || status === 'failed' || status === 'cancelled') return current;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`等待学习会话超时（${windowSeconds + 90}s）：${JSON.stringify(last).slice(0, 400)}`);
}

function unwrapGraph(body: Record<string, unknown>): Record<string, unknown> | null {
  const candidates = [
    body.graph,
    body.topology,
    body.value,
    Array.isArray(body.items) ? body.items[0] : undefined,
    Array.isArray(body.topologies) ? body.topologies[0] : undefined,
    Array.isArray(body.value) ? body.value[0] : undefined,
    body,
  ];
  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
      const record = candidate as Record<string, unknown>;
      if (Array.isArray(record.nodes) || Array.isArray(record.edges)) return record;
    }
  }
  return null;
}

async function fetchLatestGraph(cookie: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 30_000;
  let lastStatus = 0;
  while (Date.now() < deadline) {
    const result = await call('GET', '/api/topologies/latest', cookie);
    lastStatus = result.status;
    if (result.status === 200) {
      const graph = unwrapGraph(result.body);
      if (graph) return graph;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`GET /api/topologies/latest 没有返回拓扑图（最后 status=${lastStatus}）`);
}

interface GraphCheck {
  readonly ok: boolean;
  readonly summary: Record<string, unknown>;
  readonly failures: readonly string[];
}

function checkGraph(graph: Record<string, unknown>): GraphCheck {
  const nodes = Array.isArray(graph.nodes) ? (graph.nodes as Array<Record<string, unknown>>) : [];
  const edges = Array.isArray(graph.edges) ? (graph.edges as Array<Record<string, unknown>>) : [];
  const stats = (graph.stats as Record<string, unknown> | undefined) ?? {};
  const analysis = (graph.analysis as Record<string, unknown> | undefined) ?? {};
  const insights = Array.isArray(analysis.insights)
    ? (analysis.insights as Array<Record<string, unknown>>)
    : [];
  const risks = Array.isArray(analysis.risks) ? (analysis.risks as Array<Record<string, unknown>>) : [];
  const failedEdges = edges.filter((edge) => Number(edge.failed ?? 0) > 0);
  const nodeCount = Number(stats.nodeCount ?? nodes.length);
  const edgeCount = Number(stats.edgeCount ?? edges.length);
  const failures: string[] = [];
  if (nodeCount < 13) failures.push(`nodeCount=${nodeCount} < 13`);
  if (edgeCount < 30) failures.push(`edgeCount=${edgeCount} < 30`);
  if (failedEdges.length === 0) failures.push('没有 failed>0 的异常边');
  if (insights.length < 3) failures.push(`analysis.insights=${insights.length} < 3`);
  if (expectFallback && analysis.fallback !== true) {
    failures.push(`analysis.fallback=${String(analysis.fallback)}（期望 true：无模型配置时应走启发式兜底）`);
  }
  if (!expectFallback) {
    if (analysis.fallback === true) {
      failures.push(
        `analysis.fallback=true（有 active 模型时不应走兜底，warning=${String(analysis.warning ?? '')}）`,
      );
    }
    if (!String(analysis.model ?? '')) {
      failures.push('analysis.model 为空（大模型路径应有模型标识）');
    }
  }
  return {
    ok: failures.length === 0,
    failures,
    summary: {
      graphId: graph.id ?? null,
      sessionId: graph.sessionId ?? null,
      mode: graph.mode ?? null,
      version: graph.version ?? null,
      nodeCount,
      edgeCount,
      failedEdgeCount: failedEdges.length,
      failedConnections: edges.reduce((sum, edge) => sum + Number(edge.failed ?? 0), 0),
      insightCount: insights.length,
      riskCount: risks.length,
      fallback: analysis.fallback ?? null,
      model: analysis.model ?? null,
      confidence: analysis.confidence ?? null,
      summary: String(analysis.summary ?? '').slice(0, 300),
      topFailedEdges: failedEdges.slice(0, 5).map((edge) => ({
        source: edge.source,
        target: edge.target,
        port: edge.port,
        opened: edge.opened,
        failed: edge.failed,
      })),
    },
  };
}

async function hasActiveModelProvider(): Promise<boolean> {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const result = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM model_providers
       WHERE tenant_id = $1 AND status = 'active'`,
      [tenant],
    );
    return Number.parseInt(result.rows[0]?.count ?? '0', 10) > 0;
  } finally {
    await pool.end();
  }
}

async function runLearning(): Promise<void> {
  const cookie = await login();
  if (fallbackMode === 'auto') {
    const hasModel = await hasActiveModelProvider();
    expectFallback = !hasModel;
    console.log(
      `[learning] 模型配置检测：${hasModel
        ? '有 active 模型 → 校验大模型路径（fallback=false）'
        : '无模型 → 校验启发式兜底（fallback=true）'}`,
    );
  } else {
    console.log(`[learning] 期望 fallback=${String(expectFallback)}（SEED_TOPO_EXPECT_FALLBACK=${fallbackMode}）`);
  }

  console.log(`[learning] 登录成功：${controlUrl}（${adminUsername}）`);

  let session: Record<string, unknown> | null = forceNewSession ? null : await findActiveSession(cookie);
  if (session) {
    console.log(`[learning] 复用进行中的学习会话 id=${sessionIdOf(session)} status=${String(session.status)}`);
  } else {
    session = await createSession(cookie);
    console.log(
      `[learning] 已创建学习会话 id=${sessionIdOf(session)} windowSeconds=${windowSeconds} status=${String(session.status ?? '')}`,
    );
  }

  const startsAt = String(session.startedAt ?? session.started_at ?? '');
  const startedAt = Number.isNaN(Date.parse(startsAt)) ? new Date() : new Date(startsAt);
  const reports = buildReports(startedAt);
  console.log(
    `[learning] 生成 ${reports.size} 台主机的窗口样本：每台 ${WINDOW_COUNT} 个窗口，共 ${EDGES.length} 条逻辑边`,
  );

  const injected = await injectSamples(cookie, session, reports);
  console.log(`[learning] 样本注入完成：${injected} 行窗口边样本`);

  const finished = await waitForReady(cookie, session);
  console.log(`[learning] 会话结束 status=${String(finished.status)} model=${String(finished.model ?? '')} fallback=${String(finished.fallback ?? '')}`);
  if (String(finished.status) !== 'ready') {
    throw new Error(`学习会话未成功：status=${String(finished.status)} error=${String(finished.error ?? '')}`);
  }

  const graph = await fetchLatestGraph(cookie);
  const check = checkGraph(graph);
  console.log('\n=== 拓扑学习结果校验 ===');
  console.log(JSON.stringify(check.summary, null, 2));
  if (!check.ok) {
    console.error('\n❌ 校验失败：');
    for (const failure of check.failures) console.error(` - ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `\n✅ 校验通过：13+ 主机 / 30+ 边 / 失败边 / 3+ 洞察 / ${expectFallback ? '规则引擎兜底' : '大模型分析'} 标识均符合预期`,
  );
}

/** 学习阶段结束后刷新在线时间，避免演示主机因超过 90s 在线窗口而在页面上变离线。 */
async function refreshAgentLiveness(): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await pool.query(
      `UPDATE agents SET status = 'online', last_seen = now()
       WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
      [tenant, HOSTS.map((host) => host.id)],
    );
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await seedDatabase(pool);
    const counts = await pool.query<{
      agents: string;
      systems: string;
      inventory: string;
    }>(
      `SELECT
         (SELECT count(*) FROM agents WHERE tenant_id = $1 AND id = ANY($2::uuid[]))::text AS agents,
         (SELECT count(*) FROM app_systems WHERE tenant_id = $1 AND id = ANY($3::uuid[]))::text AS systems,
         (SELECT count(*) FROM agent_inventory WHERE tenant_id = $1 AND agent_id = ANY($2::uuid[]))::text AS inventory`,
      [tenant, HOSTS.map((host) => host.id), APP_SYSTEMS.map((system) => system.id)],
    );
    const row = counts.rows[0];
    console.log('=== 演示拓扑静态数据 ===');
    console.log(JSON.stringify({ agents: Number(row?.agents ?? 0), appSystems: Number(row?.systems ?? 0), inventory: Number(row?.inventory ?? 0) }, null, 2));
    console.log(`主机：${HOSTS.length} 台 / 逻辑边：${EDGES.length} 条 / 外部依赖：${Object.keys(EXTERNAL_PEERS).length} 个`);
  } finally {
    await pool.end();
  }

  if (skipLearning) {
    console.log('[learning] SEED_TOPO_SKIP_LEARNING=1，跳过学习会话阶段');
    return;
  }
  try {
    await runLearning();
  } finally {
    await refreshAgentLiveness().catch(() => undefined);
  }
}

await main().catch((error: unknown) => {
  console.error('\n❌ seed-topology-demo 失败：');
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
