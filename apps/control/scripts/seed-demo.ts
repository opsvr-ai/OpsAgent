import { Pool } from 'pg';

const databaseUrl =
  process.env.DATABASE_URL ?? 'postgres://opsagent:opsagent@localhost:5432/opsagent';
const tenant = '00000000-0000-4000-8000-000000000001';
const admin = '00000000-0000-4000-8000-0000000000a2';

const ids = {
  prometheus: '10000000-0000-4000-8000-000000000001',
  postgres: '10000000-0000-4000-8000-000000000002',
  zabbix: '10000000-0000-4000-8000-000000000003',
  redis: '10000000-0000-4000-8000-000000000004',
  grafana: '10000000-0000-4000-8000-000000000005',
  alertmanager: '10000000-0000-4000-8000-000000000006',
  clickhouse: '10000000-0000-4000-8000-000000000007',
  ssh: '10000000-0000-4000-8000-000000000008',
  http: '10000000-0000-4000-8000-000000000009',
  scenarioCheck: '20000000-0000-4000-8000-000000000001',
  scenarioDb: '20000000-0000-4000-8000-000000000002',
  scenarioDisk: '20000000-0000-4000-8000-000000000003',
  scenarioCache: '20000000-0000-4000-8000-000000000004',
  scenarioK8s: '20000000-0000-4000-8000-000000000005',
  scenarioPay: '20000000-0000-4000-8000-000000000006',
  incident5xx: '30000000-0000-4000-8000-000000000001',
  incidentDb: '30000000-0000-4000-8000-000000000002',
  incidentDisk: '30000000-0000-4000-8000-000000000003',
  knowledge1: '40000000-0000-4000-8000-000000000001',
  knowledge2: '40000000-0000-4000-8000-000000000002',
  knowledge3: '40000000-0000-4000-8000-000000000003',
  knowledge4: '40000000-0000-4000-8000-000000000004',
  knowledge5: '40000000-0000-4000-8000-000000000005',
  message1: '50000000-0000-4000-8000-000000000001',
  message2: '50000000-0000-4000-8000-000000000002',
  message3: '50000000-0000-4000-8000-000000000003',
  message4: '50000000-0000-4000-8000-000000000004',
  message5: '50000000-0000-4000-8000-000000000005',
  share1: '60000000-0000-4000-8000-000000000001',
  share2: '60000000-0000-4000-8000-000000000002',
  share3: '60000000-0000-4000-8000-000000000003',
  share4: '60000000-0000-4000-8000-000000000004',
  snapshot1: '70000000-0000-4000-8000-000000000001',
  snapshot2: '70000000-0000-4000-8000-000000000002',
  snapshot3: '70000000-0000-4000-8000-000000000003',
  snapshot4: '70000000-0000-4000-8000-000000000004',
  snapshot5: '70000000-0000-4000-8000-000000000005',
  task1: '80000000-0000-4000-8000-000000000001',
  task2: '80000000-0000-4000-8000-000000000002',
  task3: '80000000-0000-4000-8000-000000000003',
  task4: '80000000-0000-4000-8000-000000000004',
  approvalSession1: '90000000-0000-4000-8000-000000000001',
  approvalSession2: '90000000-0000-4000-8000-000000000002',
  approval1: 'a0000000-0000-4000-8000-000000000001',
  approval2: 'a0000000-0000-4000-8000-000000000002',
  agentDemo: 'b0000000-0000-4000-8000-000000000001',
  agentOrder: 'b0000000-0000-4000-8000-000000000002',
  agentDb: 'b0000000-0000-4000-8000-000000000003',
  agentCache: 'b0000000-0000-4000-8000-000000000004',
  appOrder: 'f0000000-0000-4000-8000-000000000001',
  appPayment: 'f0000000-0000-4000-8000-000000000002',
  appPlatform: 'f0000000-0000-4000-8000-000000000003',
  studio1: 'c0000000-0000-4000-8000-000000000001',
  studio2: 'c0000000-0000-4000-8000-000000000002',
  command1: 'd0000000-0000-4000-8000-000000000001',
  command2: 'd0000000-0000-4000-8000-000000000002',
  member1: 'e0000000-0000-4000-8000-000000000001',
  member2: 'e0000000-0000-4000-8000-000000000002',
  member3: 'e0000000-0000-4000-8000-000000000003',
  member4: 'e0000000-0000-4000-8000-000000000004',
  member5: 'e0000000-0000-4000-8000-000000000005',
};

const demoMembers = [
  [ids.member1, 'lin.wan', '林晚', 'lin.wan@corp.example.com', ['sre_duty', 'knowledge_admin']],
  [ids.member2, 'zhou.mu', '周牧', 'zhou.mu@corp.example.com', ['dba', 'change_manager']],
  [ids.member3, 'zhao.yiming', '赵一鸣', 'zhao.yiming@corp.example.com', ['container_platform', 'sre_duty']],
  [ids.member4, 'xu.qing', '许清', 'xu.qing@corp.example.com', ['readonly_observer']],
  [ids.member5, 'wang.yan', '王砚', 'wang.yan@corp.example.com', ['auditor']],
] as const;

const pool = new Pool({ connectionString: databaseUrl });

async function main(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const connectors = [
      [ids.prometheus, 'prometheus', 'prom-prod', { baseUrl: 'http://prometheus.monitoring:9090' }, 'active'],
      [ids.postgres, 'postgres', 'pg-orders', { database: 'orders' }, 'active'],
      [ids.zabbix, 'zabbix', 'zabbix-prod', { baseUrl: 'http://zabbix.monitoring' }, 'active'],
      [ids.redis, 'redis', 'redis-cache', { host: 'redis', port: 6379 }, 'active'],
      [ids.grafana, 'grafana', 'grafana-main', { baseUrl: 'http://grafana.monitoring:3000' }, 'active'],
      [ids.alertmanager, 'alertmanager', 'alertmanager-prod', { baseUrl: 'http://alertmanager.monitoring:9093' }, 'active'],
      [ids.clickhouse, 'clickhouse', 'clickhouse-logs', { host: 'clickhouse', port: 8123 }, 'active'],
      [ids.ssh, 'ssh', 'prod-host-readonly', { host: 'db-01', port: 22 }, 'active'],
      [ids.http, 'http', 'gateway-health', { baseUrl: 'https://pay-gateway.internal/health' }, 'active'],
    ] as const;
    for (const [id, type, name, config, status] of connectors) {
      await client.query(
        `INSERT INTO connectors (id, tenant_id, connector_type, name, config, status)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)
         ON CONFLICT (id) DO NOTHING`,
        [id, tenant, type, name, JSON.stringify(config), status],
      );
    }

    const appSystems = [
      [ids.appOrder, 'order-center', '订单中心', '交易研发组', 'P1'],
      [ids.appPayment, 'payment-gateway', '支付网关', '支付研发组', 'P1'],
      [ids.appPlatform, 'platform-runtime', '基础运行平台', '基础架构组', 'P2'],
    ] as const;
    for (const [id, code, name, owner, criticality] of appSystems) {
      await client.query(
        `INSERT INTO app_systems (id, tenant_id, code, name, owner, criticality)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, owner = EXCLUDED.owner, criticality = EXCLUDED.criticality`,
        [id, tenant, code, name, owner, criticality],
      );
    }

    const scenarios = [
      [ids.scenarioCheck, '订单服务 5xx 快速检查', '检查错误率、连接池和最近发布', [
        { name: '错误率', tool: 'promql_query', input: { query: 'rate(http_requests_total{job="orders",code=~"5.."}[5m])' } },
      ]],
      [ids.scenarioDb, '数据库连接池排查', '检查连接数、慢查询和等待事件', [
        { name: '连接数', tool: 'postgres_query', input: { sql: 'SELECT count(*) FROM pg_stat_activity' } },
      ]],
      [ids.scenarioDisk, '主机磁盘巡检', '检查磁盘使用率并生成报告', [
        { name: '磁盘', tool: 'ssh_read', input: { check: 'disk' } },
      ]],
      [ids.scenarioCache, '缓存命中率下降排查', '检查 Redis 命中率、慢日志和键空间', [
        { name: '缓存', tool: 'redis_info', input: { section: 'stats' } },
      ]],
      [ids.scenarioK8s, 'K8s 节点磁盘压力', '检查节点磁盘压力与可回收镜像', [
        { name: '节点', tool: 'k8s_node_status', input: { condition: 'DiskPressure' } },
      ]],
      [ids.scenarioPay, '支付链路黄金指标', '检查支付网关错误率与延迟', [
        { name: '黄金指标', tool: 'promql_query', input: { query: 'rate(pay_gateway_errors_total[5m])' } },
      ]],
    ] as const;
    for (const [id, name, description, steps] of scenarios) {
      await client.query(
        `INSERT INTO scenarios (id, tenant_id, name, description, definition, status, version, schedule_interval_minutes)
         VALUES ($1, $2, $3, $4, $5::jsonb, 'published', 1, 60)
         ON CONFLICT (id) DO NOTHING`,
        [id, tenant, name, description, JSON.stringify({ steps })],
      );
    }

    const incidents = [
      [ids.incident5xx, '订单服务 5xx 突增', 'P1', 'investigating', '错误率从 0.2% 升到 4.8%，正在确认数据库连接池。'],
      [ids.incidentDb, '数据库连接池接近上限', 'P2', 'open', '连接数持续升高，等待事件增加。'],
      [ids.incidentDisk, '日志盘使用率 86%', 'P3', 'resolved', '已清理过期日志并调整轮转策略。'],
    ] as const;
    await client.query(
      `DELETE FROM incident_events WHERE tenant_id = $1 AND payload->>'source' = 'demo'`,
      [tenant],
    );
    for (const [id, title, severity, status] of incidents) {
      await client.query(
        `INSERT INTO incidents (id, tenant_id, title, severity, status, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO NOTHING`,
        [id, tenant, title, severity, status, admin],
      );
      await client.query(
        `INSERT INTO incident_events (id, tenant_id, incident_id, actor_id, type, payload)
         VALUES (gen_random_uuid(), $1, $2, $3, 'created', '{"source":"demo"}'::jsonb)
         ON CONFLICT DO NOTHING`,
        [tenant, id, admin],
      );
      await client.query(
        `INSERT INTO incident_events (id, tenant_id, incident_id, actor_id, type, payload)
         VALUES
           (gen_random_uuid(), $1, $2, $3, 'commander_assigned', '{"commander":"值班 SRE"}'::jsonb),
           (gen_random_uuid(), $1, $2, $3, 'note', '{"note":"已确认影响范围，继续观察错误率"}'::jsonb)`,
        [tenant, id, admin],
      );
    }

    const knowledge = [
      [ids.knowledge1, 'MySQL 连接池排障手册', '检查 max_connections、wait_timeout、连接泄漏和慢查询。', 'published'],
      [ids.knowledge2, '订单服务 5xx 排查路径', '先看错误率与发布记录，再检查下游数据库连接池。', 'published'],
      [ids.knowledge3, '日志盘告警处置', '清理过期日志、检查 logrotate、评估保留期。', 'draft'],
      [ids.knowledge4, '订单服务 5xx 根因复盘', '连接池耗尽导致 5xx；扩容连接池并增加等待队列告警。', 'published'],
      [ids.knowledge5, 'Zabbix 告警收敛手册', '按服务与主机维度聚合告警，抑制重复通知，保留根因事件。', 'published'],
    ] as const;
    for (const [id, title, body, status] of knowledge) {
      await client.query(
        `INSERT INTO knowledge_documents (id, tenant_id, title, body, status, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO NOTHING`,
        [id, tenant, title, body, status, admin],
      );
    }

    const messages = [
      [ids.message1, '订单服务 5xx 突增', '已创建 P1 事件，等待指挥。', 'warning'],
      [ids.message2, 'SSH 只读查询待确认', '场景步骤需要审批后执行。', 'warning'],
      [ids.message3, '日志盘使用率恢复', '磁盘使用率已回到 62%。', 'info'],
      [ids.message4, '场景发布成功', '订单服务 5xx 快速检查已发布。', 'info'],
      [ids.message5, '数据库连接池恢复正常', '连接数回落到 62%，等待事件消失。', 'info'],
    ] as const;
    for (const [id, title, body, severity] of messages) {
      await client.query(
        `INSERT INTO messages (id, tenant_id, title, body, severity)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO NOTHING`,
        [id, tenant, title, body, severity],
      );
    }

    await client.query(
      `INSERT INTO scenario_shares (id, tenant_id, scenario_id, requested_by, scope, status, reason)
       VALUES
         ($1, $2, $3, $4, 'tenant', 'pending', '跨租户共享排查流程'),
         ($5, $2, $6, $4, 'platform', 'pending', '共享给平台支撑团队'),
         ($7, $2, $8, $4, 'tenant', 'approved', '同产品线复用缓存排查流程'),
         ($9, $2, $10, $4, 'tenant', 'rejected', '支付链路暂不共享')
       ON CONFLICT (id) DO NOTHING`,
      [ids.share1, tenant, ids.scenarioCheck, admin, ids.share2, ids.scenarioCache, ids.share3, ids.scenarioK8s, ids.share4, ids.scenarioPay],
    );

    await client.query(
      `INSERT INTO data_snapshots (id, tenant_id, connector_id, tool, cache_key, payload, bytes)
       VALUES
         ($1, $2, $3, 'promql_query', 'demo-prom-1', '{"result":"up"}'::jsonb, 12),
         ($4, $2, $5, 'postgres_query', 'demo-pg-1', '{"rows":1}'::jsonb, 18),
         ($6, $2, $7, 'clickhouse_query', 'demo-ch-1', '{"rows":128}'::jsonb, 4096),
         ($8, $2, $9, 'grafana_dashboard', 'demo-gf-1', '{"dashboards":12}'::jsonb, 2048),
         ($10, $2, $11, 'zabbix_problem_get', 'demo-zb-1', '{"problems":2}'::jsonb, 512)
       ON CONFLICT (id) DO NOTHING`,
      [ids.snapshot1, tenant, ids.prometheus, ids.snapshot2, ids.postgres, ids.snapshot3, ids.clickhouse, ids.snapshot4, ids.grafana, ids.snapshot5, ids.zabbix],
    );

    await client.query(
      `INSERT INTO long_tasks (id, tenant_id, title, scenario_id, status, created_by)
       VALUES
         ($1, $2, '夜间订单服务巡检', $3, 'queued', $4),
         ($5, $2, '数据库连接池巡检', $6, 'success', $4),
         ($7, $2, '主机磁盘巡检', $8, 'success', $4),
         ($9, $2, '每日告警巡检', $10, 'success', $4)
       ON CONFLICT (id) DO NOTHING`,
      [ids.task1, tenant, ids.scenarioCheck, admin, ids.task2, ids.scenarioDb, ids.task3, ids.scenarioDisk, ids.task4, ids.scenarioCheck],
    );

    await client.query(
      `INSERT INTO runtime_sessions (id, tenant_id, user_id, status, runtime_session_id, role_view)
       VALUES
         ($1, $2, $3, 'active', 'demo-session-approval-1', 'tenant_admin'),
         ($4, $2, $3, 'active', 'demo-session-approval-2', 'tenant_admin')
       ON CONFLICT (id) DO NOTHING`,
      [ids.approvalSession1, tenant, admin, ids.approvalSession2],
    );
    await client.query(
      `DELETE FROM approvals
       WHERE tenant_id = $1 AND status = 'pending' AND id NOT IN ($2, $3)`,
      [tenant, ids.approval1, ids.approval2],
    );
    await client.query(
      `INSERT INTO approvals
         (id, tenant_id, session_id, runtime_approval_id, action, risk, status, details)
       VALUES
         ($1, $2, $3, 'demo-call-uptime', 'ssh.read uptime', 'R2', 'pending', '{"check":"uptime"}'::jsonb),
         ($4, $2, $5, 'demo-call-pg', 'postgres_query pg_stat_activity', 'R2', 'pending', '{"sql":"SELECT count(*) FROM pg_stat_activity"}'::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [ids.approval1, tenant, ids.approvalSession1, ids.approval2, ids.approvalSession2],
    );

    const demoAgents = [
      {
        id: ids.agentDemo,
        name: 'prod-web-01',
        appSystemId: ids.appOrder,
        minutesAgo: 12,
        ip: '10.20.8.12',
        osName: 'Rocky Linux',
        osVersion: '9.4',
        cpu: 8,
        mem: 16,
        diskTotal: 200,
        diskFree: 128,
        apps: [
          { name: 'order-service', kind: 'systemd', status: 'running', deploy: 'systemd', ports: [8080], version: '2.4.1', config: ['/opt/order/conf/application.yml'], logs: ['/var/log/order/service.log'] },
          { name: 'nginx', kind: 'systemd', status: 'running', deploy: 'systemd', ports: [80, 443], version: '1.24.0' },
        ],
      },
      {
        id: ids.agentOrder,
        name: 'prod-order-12',
        appSystemId: ids.appOrder,
        minutesAgo: 12,
        ip: '10.20.8.34',
        osName: 'Ubuntu',
        osVersion: '22.04',
        cpu: 16,
        mem: 32,
        diskTotal: 500,
        diskFree: 310,
        apps: [
          { name: 'order-worker', kind: 'systemd', status: 'running', deploy: 'systemd', ports: [], version: '2.4.1' },
          { name: 'order-service', kind: 'docker', status: 'Up 3 days', deploy: 'docker', ports: [8080], version: '2.4.1' },
        ],
      },
      {
        id: ids.agentDb,
        name: 'prod-db-01',
        appSystemId: ids.appPlatform,
        minutesAgo: 12,
        ip: '10.20.9.21',
        osName: 'Rocky Linux',
        osVersion: '9.4',
        cpu: 32,
        mem: 128,
        diskTotal: 2000,
        diskFree: 860,
        apps: [
          { name: 'postgresql', kind: 'systemd', status: 'running', deploy: 'systemd', ports: [5432], version: '16.4', config: ['/etc/postgresql/16/main/postgresql.conf'] },
        ],
      },
      {
        id: ids.agentCache,
        name: 'prod-cache-01',
        appSystemId: ids.appPayment,
        minutesAgo: 12,
        ip: '10.20.9.45',
        osName: 'Debian',
        osVersion: '12',
        cpu: 4,
        mem: 8,
        diskTotal: 100,
        diskFree: 46,
        apps: [
          { name: 'redis', kind: 'systemd', status: 'running', deploy: 'systemd', ports: [6379], version: '7.2.5' },
          { name: 'zabbix-agent2', kind: 'ops-client', status: 'running', deploy: 'systemd', ports: [10050], version: '6.4' },
        ],
      },
    ] as const;

    for (const agent of demoAgents) {
      const systemInfo = {
        hostname: agent.name,
        ip: agent.ip,
        ipAddresses: [agent.ip],
        osName: agent.osName,
        osVersion: agent.osVersion,
        osPretty: `${agent.osName} ${agent.osVersion}`,
        kernel: '5.14.0-427.el9.x86_64',
        virtualization: 'kvm',
        cpuCores: agent.cpu,
        memoryTotalGB: agent.mem,
        diskTotalGB: agent.diskTotal,
        diskFreeGB: agent.diskFree,
        uptimeSec: 86400 * 17,
        timezone: 'Asia/Shanghai',
        packageManager: agent.osName === 'Ubuntu' ? 'apt-get' : 'dnf',
        listeningPorts: agent.apps.flatMap((app) => app.ports),
      };
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
        capabilities: ['system.discover', 'applications.discover', 'metrics', 'diagnostics', 'self.patrol', 'inspect', 'snapshot'],
      };
      await client.query(
        `INSERT INTO agents
           (id, tenant_id, name, hostname, os, arch, version, status, capabilities, agent_key,
            last_seen, metrics, app_system_id, system_info, applications, agent_info, tags, discovery_at)
         VALUES ($1, $2, $3, $3, 'linux', 'amd64', '0.2.0', 'online',
                 $4::jsonb, $5, now() - ($6 * interval '1 minute'), $7::jsonb, $8,
                 $9::jsonb, $10::jsonb, $11::jsonb, '["prod","discovered"]'::jsonb, now())
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name, hostname = EXCLUDED.hostname,
           version = EXCLUDED.version, status = 'online', capabilities = EXCLUDED.capabilities,
           last_seen = EXCLUDED.last_seen, metrics = EXCLUDED.metrics,
           app_system_id = EXCLUDED.app_system_id, system_info = EXCLUDED.system_info,
           applications = EXCLUDED.applications, agent_info = EXCLUDED.agent_info,
           discovery_at = now()`,
        [
          agent.id,
          tenant,
          agent.name,
          JSON.stringify(['cpu', 'memory', 'disk', 'network', 'system.discover', 'applications.discover']),
          `demo-agent-key-${agent.id}`,
          agent.minutesAgo,
          JSON.stringify({ cpuCores: agent.cpu, heapMB: 24, goroutines: 12, uptimeSec: 86400, memTotalGB: agent.mem, memAvailableGB: Math.round(agent.mem * 0.56), memLoadPct: 44, diskTotalGB: agent.diskTotal, diskFreeGB: agent.diskFree }),
          agent.appSystemId,
          JSON.stringify(systemInfo),
          JSON.stringify(agent.apps),
          JSON.stringify(agentInfo),
        ],
      );
    }

    await client.query(
      `INSERT INTO agent_commands (id, tenant_id, agent_id, type, status, result, created_at, dispatched_at, completed_at)
       VALUES
         ($1, $2, $3, 'diagnostics', 'completed', '{"host":"prod-web-01","cpu":"ok","memory":"ok"}'::jsonb, now() - interval '18 minutes', now() - interval '18 minutes', now() - interval '17 minutes'),
         ($4, $2, $3, 'ai_diagnose', 'completed', '{"summary":"磁盘与内存健康，建议继续观察 5xx 错误率"}'::jsonb, now() - interval '9 minutes', now() - interval '9 minutes', now() - interval '8 minutes')
       ON CONFLICT (id) DO NOTHING`,
      [ids.command1, tenant, ids.agentDemo, ids.command2],
    );

    await client.query(
      `INSERT INTO studio_sessions (id, tenant_id, requested_by, goal, platform, status, bundle)
       VALUES
         ($1, $2, $3, '生成蓝鲸 CMDB 连接器', 'blueking', 'generated',
          '{"goal":"生成蓝鲸 CMDB 连接器","files":["cordis.patch.yml","connector.ts","manifest.json"],"manifest":{"id":"blueking-cmdb","risk":"R1"}}'::jsonb),
         ($4, $2, $3, '生成 Zabbix 告警同步连接器', 'zabbix', 'pending_review',
          '{"goal":"生成 Zabbix 告警同步连接器","files":["cordis.patch.yml","manifest.json"],"manifest":{"id":"zabbix-alert","risk":"R2"}}'::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [ids.studio1, tenant, admin, ids.studio2],
    );

    for (const [id, username, displayName, email, roles] of demoMembers) {
      await client.query(
        `INSERT INTO users (id, username, display_name, email, status)
         VALUES ($1, $2, $3, $4, 'active')
         ON CONFLICT (id) DO NOTHING`,
        [id, username, displayName, email],
      );
      await client.query(
        `INSERT INTO memberships (tenant_id, user_id, status)
         VALUES ($1, $2, 'active')
         ON CONFLICT DO NOTHING`,
        [tenant, id],
      );
      for (const role of roles) {
        await client.query(
          `INSERT INTO user_roles (tenant_id, user_id, role_id)
           VALUES ($1, $2, $3)
           ON CONFLICT DO NOTHING`,
          [tenant, id, role],
        );
      }
    }

    await client.query('COMMIT');
    console.log('demo data seeded');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

await main();
