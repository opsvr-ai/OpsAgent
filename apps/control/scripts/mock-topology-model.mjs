#!/usr/bin/env node
/**
 * 本地 OpenAI 兼容 mock 模型服务：用于在离线环境验证「服务端大模型分析拓扑」的真实链路。
 *
 * 用法：
 *   node scripts/mock-topology-model.mjs            # 默认 :9099
 *   PORT=9099 node scripts/mock-topology-model.mjs
 *
 * 它实现 POST /v1/chat/completions：从请求 prompt 里提取控制面嵌入的
 * TopologyLearningInput JSON（hosts/edges/externalPeers），回一个引用闭合、
 * 符合 TopologyDraft v2 schema 的 JSON（nodes/edges/insights/hotPaths/summary）。
 *
 * v2 分类与 server 端启发式同口径：access / app / middleware / data / ops / external；
 * 基于 hosts[].services + hosts[].processes（name/command/user）识别组件，
 * 输出 product / role / systemService；多角色主机以业务应用为准。
 *
 * 在平台里配置模型（设置 → 模型配置，或 POST /api/models）：
 *   provider: openai, baseUrl: http://host.docker.internal:9099/v1,
 *   model: topology-mock, apiKey: mock-key
 */

import { createServer } from 'node:http';

const PORT = Number.parseInt(process.env.PORT ?? '9099', 10);

// ---------------------------------------------------------------------------
// v2 IT 架构分类规则（与 topology_analyzer.ts 启发式保持同口径）
// ---------------------------------------------------------------------------

const ACCESS_RULES = [
  [/openresty/i, 'OpenResty', '接入网关/反向代理'],
  [/nginx/i, 'Nginx', '接入网关/反向代理'],
  [/haproxy/i, 'HAProxy', '负载均衡'],
  [/envoy/i, 'Envoy', '服务代理'],
  [/traefik/i, 'Traefik', '接入网关'],
  [/apisix/i, 'APISIX', 'API 网关'],
  [/\bkong\b/i, 'Kong', 'API 网关'],
  [/\bf5\b/i, 'F5', '负载均衡'],
  [/\blvs\b/i, 'LVS', '四层负载均衡'],
  [/keepalived/i, 'Keepalived', '高可用/负载均衡'],
  [/\bwaf\b/i, 'WAF', 'Web 应用防火墙'],
  [/\bcdn\b/i, 'CDN', '内容分发网络'],
  [/\b(?:slb|alb|nlb)\b/i, 'SLB/ALB', '负载均衡'],
].map(([pattern, product, role]) => ({ pattern, product, role, tier: 'access', kind: 'gateway', systemService: false }));

const DATA_RULES = [
  [/mariadb/i, 'MariaDB', '关系型数据库', 'database'],
  [/mysql|mysqld/i, 'MySQL', '关系型数据库', 'database'],
  [/postgres|postgresql|pgsql/i, 'PostgreSQL', '关系型数据库', 'database'],
  [/\boracle\b/i, 'Oracle', '关系型数据库', 'database'],
  [/\bmssql\b|sqlserver/i, 'SQL Server', '关系型数据库', 'database'],
  [/mongodb|\bmongo\b/i, 'MongoDB', '文档数据库', 'database'],
  [/clickhouse/i, 'ClickHouse', '列式分析数据库', 'database'],
  [/\btidb\b/i, 'TiDB', '分布式数据库', 'database'],
  [/oceanbase/i, 'OceanBase', '分布式数据库', 'database'],
  [/dameng|\bdm8\b|dmdb/i, '达梦', '关系型数据库', 'database'],
  [/elasticsearch/i, 'Elasticsearch', '搜索存储', 'storage'],
  [/opensearch/i, 'OpenSearch', '搜索存储', 'storage'],
  [/\bminio\b/i, 'MinIO', '对象存储', 'storage'],
  [/\bceph\b/i, 'Ceph', '分布式存储', 'storage'],
  [/\bhdfs\b/i, 'HDFS', '分布式文件存储', 'storage'],
].map(([pattern, product, role, kind]) => ({ pattern, product, role, tier: 'data', kind, systemService: false }));

const MIDDLEWARE_RULES = [
  [/redis/i, 'Redis', '缓存', 'cache'],
  [/memcached/i, 'Memcached', '分布式缓存', 'cache'],
  [/\bpika\b/i, 'Pika', '缓存', 'cache'],
  [/kafka/i, 'Kafka', '消息队列', 'mq'],
  [/rabbitmq|\brabbit\b/i, 'RabbitMQ', '消息队列', 'mq'],
  [/rocketmq/i, 'RocketMQ', '消息队列', 'mq'],
  [/activemq/i, 'ActiveMQ', '消息队列', 'mq'],
  [/\bpulsar\b/i, 'Pulsar', '消息队列', 'mq'],
  [/\bnacos\b/i, 'Nacos', '注册中心', 'registry'],
  [/zookeeper/i, 'ZooKeeper', '注册中心', 'registry'],
  [/\betcd\b/i, 'etcd', '注册中心', 'registry'],
  [/\bconsul\b/i, 'Consul', '注册中心', 'registry'],
  [/\beureka\b/i, 'Eureka', '注册中心', 'registry'],
].map(([pattern, product, role, kind]) => ({ pattern, product, role, tier: 'middleware', kind, systemService: false }));

const OPS_RULES = [
  [/\bprometheus\b/i, 'Prometheus', '监控', 'monitoring'],
  [/alertmanager/i, 'Alertmanager', '告警管理', 'monitoring'],
  [/\bgrafana\b/i, 'Grafana', '监控可视化', 'monitoring'],
  [/\bzabbix/i, 'Zabbix', '监控', 'monitoring'],
  [/node[_-]exporter/i, 'Node Exporter', '主机监控采集', 'monitoring'],
  [/\btelegraf\b/i, 'Telegraf', '指标采集', 'monitoring'],
  [/\bfilebeat\b/i, 'Filebeat', '日志采集', 'logging'],
  [/\blogstash\b/i, 'Logstash', '日志处理', 'logging'],
  [/fluentd|fluent-bit/i, 'Fluentd', '日志采集', 'logging'],
  [/\bkibana\b/i, 'Kibana', '日志可视化', 'logging'],
  [/\bjaeger\b/i, 'Jaeger', '链路追踪', 'monitoring'],
  [/skywalking/i, 'SkyWalking', '链路追踪', 'monitoring'],
  [/opsagent[-_]agent/i, 'OpsAgent Agent', '运维采集代理', 'monitoring'],
  [/chrony(?:d)?|\bntpd\b/i, 'Chrony/NTP', '时间同步', 'unknown'],
  [/\bsshd\b/i, 'OpenSSH', '系统服务（SSH）', 'unknown'],
  [/\brsyslogd?\b/i, 'Rsyslog', '系统日志', 'logging'],
  [/\bcron(?:d)?\b/i, 'Cron', '系统服务（定时任务）', 'unknown'],
  [/systemd-journald/i, 'systemd-journald', '系统日志', 'logging'],
  [/containerd|\bdocker\b/i, '容器运行时', '容器运行时', 'unknown'],
].map(([pattern, product, role, kind]) => ({ pattern, product, role, tier: 'ops', kind, systemService: true }));

const APP_RUNTIME_TOKENS = [
  'java', 'javaw', 'node', 'nodejs', 'python', 'python3', 'golang', 'go', 'dotnet',
  'php', 'php-fpm', 'tomcat', 'catalina', 'gunicorn', 'uvicorn', 'django', 'flask',
  'fastapi', 'spring-boot', 'springboot', 'jar',
];

const COMPONENT_RUNTIME_PATTERN =
  /(kafka|zookeeper|elasticsearch|opensearch|nacos|rocketmq|activemq|pulsar|hadoop|hbase|flink|spark|node[_-]exporter|prometheus|alertmanager|grafana|zabbix|telegraf|filebeat|logstash|fluentd|fluent-bit|kibana|jaeger|skywalking|opsagent|sshd|chrony|ntpd|systemd|containerd|docker)/i;

const GENERIC_SERVICE_NAME_PATTERN =
  /^(?:java|javaw|node|nodejs|python[0-9.]*|go|dotnet|php(?:-fpm)?|tomcat|catalina|service|app|application|server|unknown|tcp|udp|http|https|systemd|sshd|port\s*\d+)$/i;

const GENERIC_JAR_PATTERN = /^(?:spring-boot|bootstrap|launcher|application|app|main|server)$/i;

const ALL_COMPONENT_PATTERN = new RegExp(
  [...ACCESS_RULES, ...DATA_RULES, ...MIDDLEWARE_RULES, ...OPS_RULES]
    .map((item) => item.pattern.source)
    .join('|'),
  'i',
);

function cut(value, max) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  return trimmed.length > max ? `${trimmed.slice(0, Math.max(0, max - 1))}…` : trimmed;
}

function hostEvidence(host) {
  const parts = [];
  for (const service of host.services ?? []) {
    if (service.name) parts.push(service.name);
    if (service.process) parts.push(service.process);
  }
  for (const process of host.processes ?? []) {
    if (process.name) parts.push(process.name);
    if (process.command) parts.push(process.command);
    if (process.user) parts.push(process.user);
  }
  return parts.join(' ').toLowerCase();
}

function findRule(rules, evidence) {
  if (!evidence) return null;
  for (const item of rules) {
    if (item.pattern.test(evidence)) return item;
  }
  return null;
}

function hasToken(text, token) {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(text);
}

function isBusinessRuntimeText(text) {
  if (!text.trim()) return false;
  if (COMPONENT_RUNTIME_PATTERN.test(text)) return false;
  return APP_RUNTIME_TOKENS.some((token) => hasToken(text, token));
}

function hasBusinessProcess(host) {
  for (const process of host.processes ?? []) {
    if (isBusinessRuntimeText(`${process.name} ${process.command ?? ''}`)) return true;
  }
  for (const service of host.services ?? []) {
    if (isBusinessRuntimeText(`${service.process ?? ''} ${service.name}`)) return true;
  }
  return false;
}

function detectRuntimeLabel(host) {
  const text = hostEvidence(host);
  if (/spring[- ]?boot|springboot/i.test(text)) return 'Spring Boot';
  if (/tomcat|catalina/i.test(text)) return 'Tomcat';
  if (/\.jar\b/i.test(text) || hasToken(text, 'java')) return 'Java';
  if (hasToken(text, 'node') || hasToken(text, 'nodejs')) return 'Node.js';
  if (/django|flask|fastapi|gunicorn|uvicorn/i.test(text) || hasToken(text, 'python') || hasToken(text, 'python3')) {
    return 'Python';
  }
  if (/\.dll\b/i.test(text) || hasToken(text, 'dotnet')) return '.NET';
  if (hasToken(text, 'php') || hasToken(text, 'php-fpm')) return 'PHP';
  if (hasToken(text, 'go') || /go-build/i.test(text)) return 'Go';
  return '';
}

function extractJarProduct(host) {
  for (const process of host.processes ?? []) {
    const command = `${process.name} ${process.command ?? ''}`;
    const match = /([A-Za-z0-9][A-Za-z0-9_.-]*\.jar)\b/i.exec(command);
    if (!match?.[1]) continue;
    const base = match[1].replace(/\.jar$/i, '');
    if (base && !GENERIC_JAR_PATTERN.test(base)) return cut(base, 60);
  }
  return '';
}

function firstMeaningfulServiceName(host) {
  for (const service of host.services ?? []) {
    const name = (service.name ?? '').trim();
    if (name.length < 2 || name.length > 80) continue;
    if (GENERIC_SERVICE_NAME_PATTERN.test(name)) continue;
    if (ALL_COMPONENT_PATTERN.test(name)) continue;
    return cut(name, 60);
  }
  return '';
}

function detectAppProduct(host) {
  const jar = extractJarProduct(host);
  if (jar) return jar;
  const serviceName = firstMeaningfulServiceName(host);
  if (serviceName) return serviceName;
  return detectRuntimeLabel(host) || '未知应用';
}

function secondaryRoleLabel(tier) {
  if (tier === 'access') return '接入代理';
  if (tier === 'data') return '数据库';
  if (tier === 'middleware') return '中间件';
  return '组件';
}

function classify(host) {
  const evidence = hostEvidence(host);
  const accessRule = findRule(ACCESS_RULES, evidence);
  const dataRule = findRule(DATA_RULES, evidence);
  const middlewareRule = findRule(MIDDLEWARE_RULES, evidence);
  const opsRule = findRule(OPS_RULES, evidence);
  if (hasBusinessProcess(host)) {
    const appProduct = detectAppProduct(host);
    const secondaryTiers = [];
    const secondaryProducts = [];
    if (accessRule) {
      secondaryTiers.push('access');
      secondaryProducts.push(accessRule.product);
    }
    if (dataRule) {
      secondaryTiers.push('data');
      secondaryProducts.push(dataRule.product);
    }
    if (middlewareRule) {
      secondaryTiers.push('middleware');
      secondaryProducts.push(middlewareRule.product);
    }
    const noteLabels = secondaryTiers
      .filter((tier) => tier === 'data' || tier === 'middleware')
      .map(secondaryRoleLabel);
    return {
      tier: 'app',
      kind: 'service',
      product: secondaryProducts.length > 0
        ? cut(`${appProduct} / ${secondaryProducts.join(' / ')}`, 80)
        : cut(appProduct, 80),
      role: secondaryTiers.length > 0
        ? cut(`业务应用（含${secondaryTiers.map(secondaryRoleLabel).join('、')}）`, 60)
        : '业务应用',
      systemService: false,
      note: noteLabels.length > 0
        ? `同一主机同时运行${noteLabels.join('、')}与业务进程，已按业务应用归类`
        : undefined,
    };
  }
  if (accessRule) return { tier: 'access', kind: accessRule.kind, product: accessRule.product, role: accessRule.role, systemService: false };
  if (dataRule) return { tier: 'data', kind: dataRule.kind, product: dataRule.product, role: dataRule.role, systemService: false };
  if (middlewareRule) return { tier: 'middleware', kind: middlewareRule.kind, product: middlewareRule.product, role: middlewareRule.role, systemService: false };
  if (opsRule) return { tier: 'ops', kind: opsRule.kind, product: opsRule.product, role: opsRule.role, systemService: true };
  if ((host.services ?? []).length === 0) {
    return { tier: 'ops', kind: 'unknown', product: 'Unknown', role: '基础设施主机', systemService: true };
  }
  return { tier: 'app', kind: 'service', product: detectAppProduct(host), role: '业务应用', systemService: false };
}

/** 从任意文本里找出每个平衡的 {...} 块，返回能 JSON.parse 且含 hosts/edges 的对象。 */
function extractLearningInput(text) {
  const candidates = [];
  for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === '{') depth += 1;
      else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          const slice = text.slice(start, index + 1);
          try {
            const parsed = JSON.parse(slice);
            if (parsed && Array.isArray(parsed.hosts) && Array.isArray(parsed.edges)) {
              candidates.push(parsed);
            }
          } catch {
            // 不是合法 JSON，跳过
          }
          break;
        }
      }
    }
    if (candidates.length > 0) break;
  }
  return candidates[0] ?? candidates.at(-1) ?? null;
}

function buildDraft(input) {
  const nodeById = new Map();
  const nodeByIp = new Map();
  const nodes = [];
  for (const host of input.hosts) {
    const classification = classify(host);
    const node = {
      id: host.id,
      label: host.hostname,
      kind: classification.kind,
      tier: classification.tier,
      product: classification.product,
      role: classification.role,
      systemService: classification.systemService === true,
      hostname: host.hostname,
      ip: host.ip,
      appSystemId: host.appSystemId ?? null,
      appSystemName: host.appSystemName,
      status: host.status ?? 'online',
      services: (host.services ?? []).slice(0, 8),
      ...(classification.note ? { note: classification.note } : {}),
    };
    nodes.push(node);
    nodeById.set(host.id, node);
    nodeByIp.set(host.ip, node);
  }
  // 外部依赖在 prompt 里已经带了稳定 id（externalPeers[].id）
  for (const peer of input.externalPeers ?? []) {
    const id = peer.id ?? `x:${peer.ip}`;
    if (nodeById.has(id)) continue;
    const node = {
      id,
      label: peer.ip,
      kind: 'external',
      tier: 'external',
      product: '外部依赖',
      role: '未纳管外部服务',
      systemService: false,
      ip: peer.ip,
      inferred: true,
      status: 'unknown',
      services: (peer.ports ?? []).slice(0, 6).map((port) => ({ name: `port ${port}`, port })),
    };
    nodes.push(node);
    nodeById.set(id, node);
    nodeByIp.set(peer.ip, node);
  }
  const externalNode = (ip) => {
    if (!ip) return null;
    const existing = nodeByIp.get(ip);
    if (existing) return existing.id;
    const id = `x:${ip}`;
    if (!nodeById.has(id)) {
      const node = {
        id,
        label: ip,
        kind: 'external',
        tier: 'external',
        product: '外部依赖',
        role: '未纳管外部服务',
        systemService: false,
        ip,
        inferred: true,
        status: 'unknown',
        services: [],
      };
      nodes.push(node);
      nodeById.set(id, node);
    }
    return id;
  };
  const edges = [];
  const seen = new Set();
  for (const edge of input.edges) {
    const source = nodeById.get(edge.from);
    if (!source) continue;
    let target = nodeById.get(edge.to);
    if (!target) {
      const targetId = edge.external ? externalNode(edge.to) : nodeByIp.get(edge.to)?.id;
      target = targetId ? nodeById.get(targetId) : null;
    }
    if (!target) continue;
    const key = `${source.id}->${target.id}:${edge.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({
      source: source.id,
      target: target.id,
      port: edge.port,
      count: Math.max(edge.opened ?? 0, edge.active ?? 0, edge.count ?? 0, 1),
      opened: edge.opened ?? 0,
      failed: edge.failed ?? 0,
      protocol: edge.protocol ?? 'tcp',
      label: `${edge.fromService || source.label} → ${edge.service || `port ${edge.port}`}:${edge.port}`,
      confidence: edge.external ? 0.7 : 0.92,
    });
  }
  const failures = edges.filter((edge) => edge.failed > 0);
  const crossSystem = edges.filter((edge) => {
    const source = nodes.find((node) => node.id === edge.source);
    const target = nodes.find((node) => node.id === edge.target);
    return source && target && source.appSystemId && target.appSystemId && source.appSystemId !== target.appSystemId;
  });
  const total = edges.reduce((sum, edge) => sum + edge.count, 0);
  const insights = [];
  if (failures.length > 0) {
    const worst = failures.sort((left, right) => right.failed - left.failed)[0];
    insights.push({
      id: 'ins-failure',
      title: '高频失败链路',
      detail: `${worst.label} 窗口内失败 ${worst.failed} 次，建议检查目标端口健康与超时配置。`,
      severity: worst.failed > 50 ? 'critical' : 'warning',
      nodeIds: [worst.source, worst.target],
      edgeIds: [],
    });
  }
  if (crossSystem.length > 0) {
    insights.push({
      id: 'ins-cross',
      title: '跨业务系统调用',
      detail: `检测到 ${crossSystem.length} 条跨业务系统访问，核心链路 ${crossSystem[0].label} 连接数 ${crossSystem[0].count}。`,
      severity: 'info',
      nodeIds: [crossSystem[0].source, crossSystem[0].target],
    });
  }
  const dataNodes = nodes.filter((node) => node.tier === 'data');
  if (dataNodes.length > 0) {
    insights.push({
      id: 'ins-data',
      title: '数据层组件',
      detail: `数据层识别到 ${dataNodes.length} 个组件（${dataNodes.slice(0, 3).map((node) => node.product).join('、')}），建议关注容量与备份。`,
      severity: 'info',
      nodeIds: dataNodes.slice(0, 3).map((node) => node.id),
    });
  }
  const opsNodes = nodes.filter((node) => node.tier === 'ops');
  if (opsNodes.length > 0) {
    insights.push({
      id: 'ins-ops',
      title: '运维观测组件',
      detail: `识别到 ${opsNodes.length} 个运维/系统服务节点（${opsNodes.slice(0, 3).map((node) => node.product).join('、')}），已归入 ops 层。`,
      severity: 'info',
      nodeIds: opsNodes.slice(0, 3).map((node) => node.id),
    });
  }
  const access = nodes.filter((node) => node.tier === 'access');
  const hotPaths = (access.length > 0 ? access : nodes).slice(0, 3).map((root) => {
    const first = edges.filter((edge) => edge.source === root.id).sort((left, right) => right.count - left.count).slice(0, 3);
    return {
      label: `${root.label}${first.length > 0 ? ` → ${first.map((edge) => nodes.find((node) => node.id === edge.target)?.label ?? edge.target).join(' / ')}` : ''}`,
      nodeIds: [root.id, ...first.map((edge) => edge.target)].slice(0, 5),
      edgeIds: [],
      connections: first.reduce((sum, edge) => sum + edge.count, 0),
    };
  });
  const summary = `窗口内共 ${input.hosts.length} 台纳管主机、${edges.length} 条访问关系、${new Set(input.hosts.map((host) => host.appSystemId).filter(Boolean)).size} 个业务系统，总连接数 ${total}；发现 ${insights.length} 条洞察。`;
  return {
    summary,
    nodes,
    edges,
    insights,
    hotPaths,
    risks: insights.filter((insight) => insight.severity !== 'info'),
    confidence: 0.86,
  };
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/healthz') return json(res, 200, { status: 'ok' });
  if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
    return json(res, 404, { error: 'not_found' });
  }
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    try {
      const request = JSON.parse(body);
      const messages = Array.isArray(request.messages) ? request.messages : [];
      const text = messages.map((message) => (typeof message.content === 'string' ? message.content : '')).join('\n');
      const input = extractLearningInput(text);
      if (!input) {
        console.log('[mock] 未从 prompt 中提取到 TopologyLearningInput，返回非法内容以验证兜底');
        return json(res, 200, {
          id: 'mock-no-input',
          choices: [{ index: 0, message: { role: 'assistant', content: '{"nodes":[],"edges":[]' } }],
          usage: { prompt_tokens: body.length, completion_tokens: 10 },
        });
      }
      const draft = buildDraft(input);
      console.log(`[mock] 已生成模型拓扑：nodes=${draft.nodes.length} edges=${draft.edges.length}`);
      return json(res, 200, {
        id: `mock-${Date.now()}`,
        object: 'chat.completion',
        model: request.model ?? 'topology-mock',
        choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(draft) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: body.length, completion_tokens: JSON.stringify(draft).length },
      });
    } catch (error) {
      console.error('[mock] 处理失败', error);
      return json(res, 500, { error: { message: String(error) } });
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[mock-topology-model] OpenAI 兼容 mock 已启动: http://0.0.0.0:${PORT}/v1`);
});
