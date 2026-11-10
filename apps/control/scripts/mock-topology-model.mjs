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
 * 符合 TopologyDraft schema 的 JSON（nodes/edges/insights/hotPaths/summary）。
 * 这样 TopologyAnalyzer 会走「模型路径」而不是启发式兜底，可验证：
 *   Agent 窗口样本 → 聚合 → prompt → 模型 HTTP 调用 → JSON 校验 → 拓扑图。
 *
 * 在平台里配置模型（设置 → 模型配置，或 POST /api/models）：
 *   provider: openai, baseUrl: http://host.docker.internal:9099/v1,
 *   model: topology-mock, apiKey: mock-key
 */

import { createServer } from 'node:http';

const PORT = Number.parseInt(process.env.PORT ?? '9099', 10);

const TIER_RULES = [
  { tier: 'ingress', kind: 'gateway', pattern: /nginx|haproxy|envoy|apache|traefik|gateway|kong|slb|f5/i },
  { tier: 'middleware', kind: 'cache', pattern: /redis|memcached/i },
  { tier: 'middleware', kind: 'mq', pattern: /kafka|rabbit|rocketmq|nacos|zookeeper|etcd/i },
  { tier: 'data', kind: 'database', pattern: /mysql|mariadb|postgres|oracle|sqlserver|mongo|clickhouse|tidb|dameng/i },
];

function classify(host) {
  const labels = [
    ...host.services.map((service) => service.name),
    ...host.services.map((service) => service.process ?? ''),
    host.hostname,
  ].join(' ');
  for (const rule of TIER_RULES) {
    if (rule.pattern.test(labels)) return { tier: rule.tier, kind: rule.kind };
  }
  return { tier: 'app', kind: 'service' };
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
    const { tier, kind } = classify(host);
    const node = {
      id: host.id,
      label: host.hostname,
      kind,
      tier,
      hostname: host.hostname,
      ip: host.ip,
      appSystemId: host.appSystemId ?? null,
      appSystemName: host.appSystemName,
      status: host.status ?? 'online',
      services: (host.services ?? []).slice(0, 8),
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
      const node = { id, label: ip, kind: 'external', tier: 'external', ip, inferred: true, status: 'unknown', services: [] };
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
      title: '数据层集中度',
      detail: `数据层 ${dataNodes.length} 个节点承载 ${edges.filter((edge) => dataNodes.some((node) => node.id === edge.target)).length} 条访问关系，建议关注单实例容量与备份。`,
      severity: 'info',
      nodeIds: dataNodes.slice(0, 3).map((node) => node.id),
    });
  }
  const ingress = nodes.filter((node) => node.tier === 'ingress');
  const hotPaths = (ingress.length > 0 ? ingress : nodes).slice(0, 3).map((root) => {
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
