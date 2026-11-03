import { useEffect, useState } from 'react';
import {
  createConnector,
  getConnector,
  listConnectors,
  saveConnectorCredentials,
  testConnector,
  type ConnectorDetail,
  type ConnectorSummary,
} from '../api/client.js';
import { DesignShell } from './design-shell.js';

export interface ConnectorsProps {
  readonly onBack: () => void;
}

const TYPES = ['prometheus', 'grafana', 'alertmanager', 'zabbix', 'clickhouse', 'postgres', 'mysql', 'redis', 'ssh', 'http'];

const META: Record<string, { label: string; category: 'monitor' | 'data' | 'infra' | 'custom'; description: string; tools: number; risk: string; icon: string }> = {
  prometheus: { label: 'Prometheus', category: 'monitor', description: '指标查询、目标发现、告警规则与标签检索。', tools: 4, risk: 'R0–R2', icon: 'activity' },
  zabbix: { label: 'Zabbix', category: 'monitor', description: '主机、触发器、问题与历史数据；支持只读查询。', tools: 5, risk: 'R0–R2', icon: 'activity' },
  grafana: { label: 'Grafana', category: 'monitor', description: '仪表盘、数据源与告警规则检索。', tools: 4, risk: 'R0–R1', icon: 'grid' },
  alertmanager: { label: 'Alertmanager', category: 'monitor', description: '告警分组、静默与路由查询。', tools: 3, risk: 'R0–R2', icon: 'bell' },
  clickhouse: { label: 'ClickHouse', category: 'data', description: '日志与指标分析、只读 SQL 查询。', tools: 3, risk: 'R0–R1', icon: 'database' },
  postgres: { label: 'PostgreSQL', category: 'data', description: '连接池、慢查询与只读诊断 SQL。', tools: 3, risk: 'R0–R2', icon: 'database' },
  mysql: { label: 'MySQL', category: 'data', description: '连接数、慢日志与只读诊断查询。', tools: 3, risk: 'R0–R2', icon: 'database' },
  redis: { label: 'Redis', category: 'data', description: '内存、慢日志、键空间与延迟诊断。', tools: 3, risk: 'R0–R2', icon: 'database' },
  ssh: { label: 'SSH 主机', category: 'infra', description: '只读命令、磁盘与进程排查；写操作需审批。', tools: 5, risk: 'R1–R3', icon: 'server' },
  http: { label: 'HTTP 探测', category: 'custom', description: 'HTTP 健康检查与自定义接口探测。', tools: 2, risk: 'R0–R1', icon: 'plug' },
};

const CATEGORY_LABELS: Record<string, string> = {
  all: '全部',
  monitor: '监控告警',
  data: '数据库与中间件',
  infra: '容器与主机',
  custom: '自定义生成',
};

function configSummary(config: Record<string, unknown>): string {
  const entries = Object.entries(config);
  if (entries.length === 0) return '未配置参数';
  return entries.slice(0, 2).map(([key, value]) => `${key}: ${String(value)}`).join(' · ');
}

export function Connectors({ onBack }: ConnectorsProps) {
  const [connectors, setConnectors] = useState<ConnectorSummary[] | null>(null);
  const [name, setName] = useState('');
  const [type, setType] = useState('prometheus');
  const [baseUrl, setBaseUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [probe, setProbe] = useState<Record<string, string>>({});
  const [detail, setDetail] = useState<ConnectorDetail | null>(null);
  const [credentialsText, setCredentialsText] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [detailTab, setDetailTab] = useState<'connection' | 'tools'>('connection');
  const [category, setCategory] = useState('all');
  const [query, setQuery] = useState('');

  useEffect(() => {
    void listConnectors()
      .then(setConnectors)
      .catch(() => setError('连接器加载失败'));
  }, []);

  async function create() {
    if (!name.trim()) {
      setError('请填写名称');
      return;
    }
    setError(null);
    try {
      const connector = await createConnector({
        connectorType: type,
        name: name.trim(),
        config: baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {},
      });
      setConnectors((current) => [connector, ...(current ?? [])]);
      setName('');
      setBaseUrl('');
      setShowCreate(false);
    } catch {
      setError('创建失败');
    }
  }

  async function test(id: string) {
    setError(null);
    try {
      const result = await testConnector(id);
      setProbe((current) => ({ ...current, [id]: `${result.status} · ${result.latencyMs}ms` }));
    } catch {
      setProbe((current) => ({ ...current, [id]: '探测失败' }));
    }
  }

  async function openDetail(id: string) {
    setError(null);
    try {
      setDetail(await getConnector(id));
      setCredentialsText('');
    } catch {
      setError('连接器详情加载失败');
    }
  }

  async function saveCredentials() {
    if (!detail) return;
    setError(null);
    try {
      const parsed = JSON.parse(credentialsText) as Record<string, unknown>;
      await saveConnectorCredentials(detail.id, parsed);
      setDetail({ ...detail, hasCredentials: true });
      setCredentialsText('');
    } catch {
      setError('凭据保存失败，需为 JSON 对象');
    }
  }

  const rows = (connectors ?? []).filter((connector) => {
    const meta = META[connector.connectorType];
    const matchesCategory = category === 'all' || meta?.category === category;
    const text = `${connector.name} ${connector.connectorType}`.toLowerCase();
    return matchesCategory && text.includes(query.trim().toLowerCase());
  });
  const healthy = connectors?.filter((item) => item.status === 'active' || item.status === 'healthy').length ?? 0;
  const tools = (connectors ?? []).reduce((total, item) => total + (META[item.connectorType]?.tools ?? 2), 0);

  if (detail) {
    const meta = META[detail.connectorType] ?? {
      label: detail.connectorType,
      category: 'custom' as const,
      description: '自定义连接器。',
      tools: 2,
      risk: 'R0–R2',
      icon: 'plug',
    };
    const toolNames = [`${detail.connectorType}.query`, `${detail.connectorType}.status`, `${detail.connectorType}.inspect`, `${detail.connectorType}.history`].slice(0, meta.tools);
    return (
      <DesignShell
        active="connectors"
        eyebrow="连接器详情"
        title={meta.label}
        subtitle={`${detail.name} · ${meta.description}`}
        onBack={() => setDetail(null)}
        actions={
          <>
            <button type="button" className="btn btn-outline" onClick={() => void test(detail.id)}>测试连接</button>
            <button type="button" className="btn btn-primary" onClick={() => void saveCredentials()}>保存配置</button>
          </>
        }
      >
        {error ? <p role="alert">{error}</p> : null}
        <div className="detail-hero">
          <span className="icon-tile is-blue detail-icon"><svg><use href={`/icons.svg#i-${meta.icon}`} /></svg></span>
          <div>
            <div className="row-sm">
              <span className={`badge ${detail.status === 'active' ? 'badge-ok' : 'badge-warn'}`}>{detail.status}</span>
              <span className="badge badge-neutral">{meta.risk}</span>
              <span className="mono muted">{detail.name}</span>
              <span className="muted">{meta.tools} 个工具 · {configSummary(detail.config)}</span>
            </div>
          </div>
        </div>
        <div className="notice-line" style={{ marginBottom: 16 }}>
          凭据加解密在平台内完成；轮换凭据后，新会话使用新凭据，正在运行的会话不受影响。
        </div>
        <div className="tabs" style={{ marginBottom: 16 }}>
          <button type="button" className={`tab${detailTab === 'connection' ? ' is-active' : ''}`} onClick={() => setDetailTab('connection')}>连接配置</button>
          <button type="button" className={`tab${detailTab === 'tools' ? ' is-active' : ''}`} onClick={() => setDetailTab('tools')}>能力与工具<span className="count">{meta.tools}</span></button>
          <button type="button" className="tab">权限分配</button>
          <button type="button" className="tab">健康与审计</button>
        </div>
        <div className="connector-detail-layout">
          <div className="stack">
            {detailTab === 'connection' ? (
              <section className="card">
                <div className="card-head"><h2>基本连接</h2><span className="badge badge-neutral">租户级配置</span></div>
                <div className="card-body">
                  <div className="form-grid">
                    <div className="field"><label htmlFor="detail-name">显示名称</label><input id="detail-name" value={detail.name} readOnly /></div>
                    <div className="field"><label htmlFor="detail-type">连接器类型</label><input id="detail-type" value={detail.connectorType} readOnly /></div>
                    <div className="field" style={{ gridColumn: '1 / -1' }}><label htmlFor="detail-url">Base URL</label><input id="detail-url" value={String(detail.config.baseUrl ?? '')} readOnly placeholder="未配置 Base URL" /></div>
                    <div className="field"><label htmlFor="detail-env">环境</label><select id="detail-env" defaultValue="prod"><option value="prod">生产环境</option><option value="staging">预发环境</option></select></div>
                    <div className="field"><label htmlFor="detail-tags">标签</label><input id="detail-tags" value={`${meta.category} · ${detail.connectorType}`} readOnly /></div>
                  </div>
                  <h3 style={{ marginTop: 16 }}>鉴权</h3>
                  <label htmlFor="connector-credentials">凭据 JSON（保存后不可回读）</label>
                  <textarea
                    id="connector-credentials"
                    value={credentialsText}
                    onChange={(event) => setCredentialsText(event.target.value)}
                    rows={3}
                    placeholder={detail.hasCredentials ? '凭据已配置；输入新 JSON 可轮换' : '{"token":"..."}'}
                  />
                  <div className="form-actions">
                    <button type="button" className="btn btn-primary" onClick={() => void saveCredentials()}>保存凭据</button>
                  </div>
                </div>
              </section>
            ) : (
              <section className="card">
                <div className="card-head"><h2>暴露的工具</h2><span className="badge badge-neutral">{meta.tools} 个</span></div>
                <div className="card-body stack-sm">
                  {toolNames.map((tool, index) => (
                    <div key={tool} className="row-between">
                      <span className="mono">{tool}</span>
                      <span className={`badge ${index === toolNames.length - 1 && meta.risk.includes('R2') ? 'badge-warn' : 'badge-ok'}`}>{index === toolNames.length - 1 && meta.risk.includes('R2') ? '需审批' : '只读'}</span>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>
          <aside className="stack">
            <section className="card">
              <div className="card-head"><h2>连接测试</h2><span className="badge badge-ok">通过</span></div>
              <div className="card-body stack-sm">
                <div className="aside-row"><span>API 可达</span><span className="badge badge-ok">正常</span></div>
                <div className="aside-row"><span>响应时间</span><span className="mono">{probe[detail.id] ?? '84ms'}</span></div>
                <div className="aside-row"><span>凭据</span><span>{detail.hasCredentials ? '已配置' : '未配置'}</span></div>
                <div className="aside-row"><span>风险等级</span><span>{meta.risk}</span></div>
                <button type="button" className="btn btn-outline btn-sm" onClick={() => void test(detail.id)}>重新测试</button>
              </div>
            </section>
            <section className="card">
              <div className="card-head"><h2>主动探测</h2></div>
              <div className="card-body">
                <p className="muted">测试只会调用只读元数据接口，不写入任何业务数据；每次探测都写入审计。</p>
              </div>
            </section>
          </aside>
        </div>
      </DesignShell>
    );
  }

  return (
    <DesignShell
      active="connectors"
      eyebrow="Integration hub · 连接器与工具"
      title="集成与连接器"
      subtitle="标准运维平台通过连接器接入；长尾系统用 HTTP 探测或 AI 创造模式生成，连接器只在平台内定义与探测。"
      onBack={onBack}
      actions={
        <>
          <button type="button" className="btn btn-outline" onClick={() => setCategory('all')}>数据源</button>
          <button type="button" className="btn btn-primary" onClick={() => setShowCreate((current) => !current)}>接入连接器</button>
        </>
      }
    >
      {error ? <p role="alert">{error}</p> : null}

      <div className="status-strip" style={{ marginBottom: 20 }}>
        <div className="status-cell"><span className="icon-tile is-blue"><svg><use href="/icons.svg#i-plug" /></svg></span><div><strong>已接入</strong><span>{connectors?.length ?? 0} 个连接器</span></div></div>
        <div className="status-cell"><span className="icon-tile is-green"><svg><use href="/icons.svg#i-check" /></svg></span><div><strong>健康</strong><span>{healthy} 个正常</span></div></div>
        <div className="status-cell"><span className="icon-tile"><svg><use href="/icons.svg#i-bolt" /></svg></span><div><strong>可用工具</strong><span>{tools} 个能力</span></div></div>
        <div className="status-cell"><span className="icon-tile is-amber"><svg><use href="/icons.svg#i-shield" /></svg></span><div><strong>授权角色</strong><span>租户内按角色授权</span></div></div>
      </div>

      {showCreate ? (
        <section className="card">
          <div className="card-head"><h2>接入连接器</h2><span className="muted">凭据保存后可探测</span></div>
          <div className="card-body">
            <div className="form-grid">
              <div className="field">
                <label htmlFor="connector-name">名称</label>
                <input id="connector-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="例如 prod-prometheus" />
              </div>
              <div className="field">
                <label htmlFor="connector-type">类型</label>
                <select id="connector-type" value={type} onChange={(event) => setType(event.target.value)}>
                  {TYPES.map((item) => <option key={item} value={item}>{META[item]?.label ?? item}</option>)}
                </select>
              </div>
              <div className="field">
                <label htmlFor="connector-url">Base URL（HTTP 类）</label>
                <input id="connector-url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="http://prometheus:9090" />
              </div>
            </div>
            <div className="form-actions">
              <button type="button" className="btn btn-primary" onClick={() => void create()}>创建连接器</button>
            </div>
          </div>
        </section>
      ) : null}

      <div className="tabs" style={{ marginBottom: 14 }}>
        {Object.entries(CATEGORY_LABELS).map(([key, label]) => {
          const count = key === 'all' ? connectors?.length ?? 0 : (connectors ?? []).filter((item) => META[item.connectorType]?.category === key).length;
          return (
            <button key={key} type="button" className={`tab${category === key ? ' is-active' : ''}`} onClick={() => setCategory(key)}>
              {label}<span className="count">{count}</span>
            </button>
          );
        })}
        <input
          className="input tab-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索连接器、工具"
          aria-label="搜索连接器"
        />
      </div>

      <div className="connector-layout">
        <div>
          {connectors === null ? <p className="muted">加载中…</p> : null}
          {connectors?.length === 0 ? <p className="muted">暂无连接器</p> : null}
          {connectors && connectors.length > 0 && rows.length === 0 ? <p className="muted">没有匹配的连接器</p> : null}
          <div className="grid connector-cards">
            {rows.map((connector) => {
              const meta = META[connector.connectorType] ?? {
                label: connector.connectorType,
                category: 'custom' as const,
                description: '自定义连接器。',
                tools: 2,
                risk: 'R0–R2',
                icon: 'plug',
              };
              return (
                <article key={connector.id} className="card connector-card">
                  <div className="card-body">
                    <div className="scenario-top">
                      <span className="icon-tile is-blue"><svg><use href={`/icons.svg#i-${meta.icon}`} /></svg></span>
                      <span className="badge badge-neutral">{meta.label}</span>
                      <span className={`badge ${connector.status === 'active' || connector.status === 'healthy' ? 'badge-ok' : 'badge-warn'}`}>{connector.status === 'active' ? '已启用' : connector.status}</span>
                    </div>
                    <h3>{connector.name}</h3>
                    <p className="muted">{meta.description}</p>
                    <p className="connector-meta">{meta.tools} 个工具 · {meta.risk} · {configSummary(connector.config)}</p>
                    {probe[connector.id] ? <p className="muted">{probe[connector.id]}</p> : null}
                    <div className="row-sm">
                      <button type="button" className="btn btn-outline btn-sm" onClick={() => void test(connector.id)}>测试连接</button>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => void openDetail(connector.id)}>详情</button>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        </div>

        <aside className="stack">
          <section className="card">
            <div className="card-head"><h2>接入方式与治理</h2></div>
            <div className="card-body stack-sm">
              <div className="aside-row"><span>标准连接器</span><span className="mono">{connectors?.length ?? 0}</span></div>
              <p className="muted">Long-lived credentials are encrypted at rest; each probe respects tenant boundary.</p>
              <div className="aside-row"><span>HTTP 探测</span><span className="badge badge-neutral">自定义</span></div>
              <p className="muted">HTTP 探测只读受限，默认不写入业务系统。</p>
              <div className="aside-row"><span>AI 创造模式</span><span className="badge badge-neutral">生成后审核</span></div>
              <p className="muted">生成结果不会直接发布，需提交审核并通过后才进入租户目录。</p>
            </div>
          </section>
          <section className="card">
            <div className="card-head"><h2>健康检查</h2><span className="badge badge-ok">{healthy} 正常</span></div>
            <div className="card-body stack-sm">
              {(connectors ?? []).slice(0, 5).map((connector) => (
                <div key={connector.id} className="row-between">
                  <span>{connector.name}</span>
                  <span className={`badge ${connector.status === 'active' || connector.status === 'healthy' ? 'badge-ok' : 'badge-warn'}`}>{connector.status}</span>
                </div>
              ))}
              {connectors?.length === 0 ? <p className="muted">暂无健康数据</p> : null}
            </div>
          </section>
        </aside>
      </div>
    </DesignShell>
  );
}
