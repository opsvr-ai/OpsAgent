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
  scenarioCheck: '20000000-0000-4000-8000-000000000001',
  scenarioDb: '20000000-0000-4000-8000-000000000002',
  scenarioDisk: '20000000-0000-4000-8000-000000000003',
  incident5xx: '30000000-0000-4000-8000-000000000001',
  incidentDb: '30000000-0000-4000-8000-000000000002',
  incidentDisk: '30000000-0000-4000-8000-000000000003',
  knowledge1: '40000000-0000-4000-8000-000000000001',
  knowledge2: '40000000-0000-4000-8000-000000000002',
  knowledge3: '40000000-0000-4000-8000-000000000003',
  message1: '50000000-0000-4000-8000-000000000001',
  message2: '50000000-0000-4000-8000-000000000002',
  message3: '50000000-0000-4000-8000-000000000003',
  message4: '50000000-0000-4000-8000-000000000004',
  share1: '60000000-0000-4000-8000-000000000001',
  snapshot1: '70000000-0000-4000-8000-000000000001',
  snapshot2: '70000000-0000-4000-8000-000000000002',
  task1: '80000000-0000-4000-8000-000000000001',
  task2: '80000000-0000-4000-8000-000000000002',
  approvalSession1: '90000000-0000-4000-8000-000000000001',
  approvalSession2: '90000000-0000-4000-8000-000000000002',
  approval1: 'a0000000-0000-4000-8000-000000000001',
  approval2: 'a0000000-0000-4000-8000-000000000002',
  agentDemo: 'b0000000-0000-4000-8000-000000000001',
  studio1: 'c0000000-0000-4000-8000-000000000001',
  studio2: 'c0000000-0000-4000-8000-000000000002',
};

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
    ] as const;
    for (const [id, type, name, config, status] of connectors) {
      await client.query(
        `INSERT INTO connectors (id, tenant_id, connector_type, name, config, status)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)
         ON CONFLICT (id) DO NOTHING`,
        [id, tenant, type, name, JSON.stringify(config), status],
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
    }

    const knowledge = [
      [ids.knowledge1, 'MySQL 连接池排障手册', '检查 max_connections、wait_timeout、连接泄漏和慢查询。', 'published'],
      [ids.knowledge2, '订单服务 5xx 排查路径', '先看错误率与发布记录，再检查下游数据库连接池。', 'published'],
      [ids.knowledge3, '日志盘告警处置', '清理过期日志、检查 logrotate、评估保留期。', 'draft'],
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
       VALUES ($1, $2, $3, $4, 'tenant', 'pending', '跨租户共享排查流程')
       ON CONFLICT (id) DO NOTHING`,
      [ids.share1, tenant, ids.scenarioCheck, admin],
    );

    await client.query(
      `INSERT INTO data_snapshots (id, tenant_id, connector_id, tool, cache_key, payload, bytes)
       VALUES
         ($1, $2, $3, 'promql_query', 'demo-prom-1', '{"result":"up"}'::jsonb, 12),
         ($4, $2, $5, 'postgres_query', 'demo-pg-1', '{"rows":1}'::jsonb, 18)
       ON CONFLICT (id) DO NOTHING`,
      [ids.snapshot1, tenant, ids.prometheus, ids.snapshot2, ids.postgres],
    );

    await client.query(
      `INSERT INTO long_tasks (id, tenant_id, title, scenario_id, status, created_by)
       VALUES
         ($1, $2, '夜间订单服务巡检', $3, 'queued', $4),
         ($5, $2, '数据库连接池巡检', $6, 'success', $4)
       ON CONFLICT (id) DO NOTHING`,
      [ids.task1, tenant, ids.scenarioCheck, admin, ids.task2, ids.scenarioDb],
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
      `INSERT INTO approvals
         (id, tenant_id, session_id, runtime_approval_id, action, risk, status, details)
       VALUES
         ($1, $2, $3, 'demo-call-uptime', 'ssh.read uptime', 'R2', 'pending', '{"check":"uptime"}'::jsonb),
         ($4, $2, $5, 'demo-call-pg', 'postgres_query pg_stat_activity', 'R2', 'pending', '{"sql":"SELECT count(*) FROM pg_stat_activity"}'::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [ids.approval1, tenant, ids.approvalSession1, ids.approval2, ids.approvalSession2],
    );

    await client.query(
      `INSERT INTO agents
         (id, tenant_id, name, hostname, os, arch, version, status, capabilities, agent_key, last_seen, metrics)
       VALUES ($1, $2, 'prod-web-01', 'prod-web-01', 'linux', 'amd64', '0.1.0', 'online',
               '["cpu","memory","disk"]'::jsonb, 'demo-agent-key', now(),
               '{"cpuCores":8,"heapMB":24,"goroutines":12,"uptimeSec":86400,"memTotalGB":16,"memAvailableGB":9.2,"memLoadPct":42,"diskTotalGB":200,"diskFreeGB":128}'::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [ids.agentDemo, tenant],
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
