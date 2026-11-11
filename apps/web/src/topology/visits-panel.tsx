import { useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import type { AccessTrendRow, AccessTrendsResponse, HttpRequestTrendRow, HttpRequestTrendsResponse, TopologyEdgeTag, EdgeTagSuggestion } from '@opsagent/contracts';
import { formatConnections } from './layout.js';
import { MiniIcon } from './icons.js';

export const TAG_CATEGORIES = ['运维工具', '应用调用', '数据访问', '中间件访问', '外部依赖', '其他'] as const;
export const TAG_COLORS = ['#3d7ab8', '#8a63c9', '#2f9e7e', '#d08a2c', '#c25a74', '#65788f'] as const;

export interface RelationRow {
  readonly relationKey: string;
  readonly sourceLabel: string;
  readonly targetLabel: string;
  readonly targetPort: number;
  readonly protocol: string;
  readonly sourceService: string;
  readonly targetService: string;
  readonly count: number;
  readonly opened: number;
  readonly failed: number;
  readonly external: boolean;
  readonly suggestedTag: string;
}

export function suggestedTagForPort(port: number, external: boolean): string {
  if ([22, 10050, 10051, 9100, 9090, 3000].includes(port)) return '运维工具';
  if (external) return '外部依赖';
  if ([3306, 5432, 6379, 27017, 9200, 6432].includes(port)) {
    return [6379, 9200].includes(port) ? '中间件访问' : '数据访问';
  }
  if ([9092, 5672, 5673, 11211, 26379].includes(port)) return '中间件访问';
  return '应用调用';
}

function tagChips(tags: readonly TopologyEdgeTag[]): ReactElement {
  if (tags.length === 0) return <span className="topo-v4-muted">—</span>;
  return (
    <span className="topo-v4-tagchips">
      {tags.map((tag) => (
        <em
          key={tag.id || `${tag.relationKey}-${tag.label}`}
          className="topo-v4-tagchip"
          style={{ color: tag.color ?? '#3d7ab8', borderColor: `${tag.color ?? '#3d7ab8'}55`, background: `${tag.color ?? '#3d7ab8'}14` }}
        >
          {tag.label}
        </em>
      ))}
    </span>
  );
}

function MiniSpark({
  values,
  failed,
  label = '访问趋势',
}: {
  values: readonly number[];
  failed: readonly number[];
  label?: string;
}): ReactElement {
  const width = 96;
  const height = 24;
  if (values.length === 0) return <span className="topo-v4-muted">—</span>;
  const max = Math.max(1, ...values);
  const step = values.length > 1 ? width / (values.length - 1) : width;
  const points = values
    .map((value, index) => `${(index * step).toFixed(1)},${(height - 2 - (value / max) * (height - 5)).toFixed(1)}`)
    .join(' ');
  const failedPoints = failed
    .map((value, index) => (value > 0 ? `${(index * step).toFixed(1)},${(height - 2 - (value / max) * (height - 5)).toFixed(1)}` : null))
    .filter((value): value is string => value !== null);
  return (
    <svg className="topo-v4-spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label}>
      <polyline points={points} fill="none" stroke="var(--primary)" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      {failedPoints.map((point) => {
        const [x, y] = point.split(',');
        return <circle key={point} cx={x} cy={y} r={1.6} fill="var(--danger)" />;
      })}
    </svg>
  );
}

function Sparkline({ row }: { row: AccessTrendRow }): ReactElement {
  return <MiniSpark values={row.buckets.map((bucket) => bucket.opened)} failed={row.buckets.map((bucket) => bucket.failed)} />;
}

export type TrendMode = 'tcp' | 'http';

function TrendModeSwitch({ mode, onChange }: { mode: TrendMode; onChange: (mode: TrendMode) => void }): ReactElement {
  return (
    <div className="topo-v4-tabs-inline topo-v4-mode" role="group" aria-label="访问量类型">
      <button type="button" className={mode === 'tcp' ? 'is-on' : ''} onClick={() => onChange('tcp')}>
        TCP 建连
      </button>
      <button type="button" className={mode === 'http' ? 'is-on' : ''} onClick={() => onChange('http')}>
        HTTP/gRPC 请求
      </button>
    </div>
  );
}

export interface RelationsPanelProps {
  readonly rows: readonly RelationRow[];
  readonly tagsByRelation: ReadonlyMap<string, readonly TopologyEdgeTag[]>;
  readonly selectedKey: string | null;
  readonly savingKey: string | null;
  readonly onSaveTag: (input: { relationKey: string; label: string; category: string; color: string; note: string }) => void;
  readonly onDeleteTag: (tag: TopologyEdgeTag) => void;
  readonly onFocusRow: (row: RelationRow) => void;
  readonly onSuggest: () => void;
  readonly suggesting: boolean;
}

export function RelationsPanel({
  rows,
  tagsByRelation,
  selectedKey,
  savingKey,
  onSaveTag,
  onDeleteTag,
  onFocusRow,
  onSuggest,
  suggesting,
}: RelationsPanelProps): ReactElement {
  const [search, setSearch] = useState('');
  const [tagFilter, setTagFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [category, setCategory] = useState<string>(TAG_CATEGORIES[0]);
  const [color, setColor] = useState<string>(TAG_COLORS[0]);
  const [note, setNote] = useState('');

  const allTags = useMemo(() => {
    const map = new Map<string, string>();
    for (const tags of tagsByRelation.values()) {
      for (const tag of tags) map.set(tag.label, tag.category ?? '其他');
    }
    return [...map.entries()].map(([name, categoryValue]) => ({ name, category: categoryValue }));
  }, [tagsByRelation]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return rows.filter((row) => {
      const tags = tagsByRelation.get(row.relationKey) ?? [];
      if (tagFilter && !tags.some((tag) => tag.label === tagFilter)) return false;
      if (categoryFilter && !tags.some((tag) => (tag.category ?? '其他') === categoryFilter)) return false;
      if (query) {
        const haystack = `${row.sourceLabel} ${row.targetLabel} ${row.targetPort} ${row.sourceService} ${row.targetService}`.toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return true;
    });
  }, [categoryFilter, rows, search, tagFilter, tagsByRelation]);

  const startEdit = (row: RelationRow): void => {
    setEditingKey(row.relationKey);
    setLabel('');
    setCategory(row.suggestedTag);
    setColor(TAG_COLORS[0]);
    setNote('');
  };

  return (
    <div className="topo-v4-body">
      <div className="topo-v4-filters">
        <label className="topo-v4-search">
          <MiniIcon name="search" size={13} />
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索主机 / 服务 / 端口" />
        </label>
        <label className="topo-v4-select">
          <span>标签</span>
          <select className="select" value={tagFilter} onChange={(event) => setTagFilter(event.target.value)}>
            <option value="">全部标签</option>
            {allTags.map((tag) => (
              <option key={tag.name} value={tag.name}>
                {tag.name}
              </option>
            ))}
          </select>
        </label>
        <label className="topo-v4-select">
          <span>类别</span>
          <select className="select" value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)}>
            <option value="">全部类别</option>
            {TAG_CATEGORIES.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
        <span className="topo-v4-count">{filtered.length} / {rows.length} 条关系</span>
        <button type="button" className="btn btn-outline btn-sm topo-v4-ai-btn" onClick={onSuggest} disabled={suggesting}>
          <MiniIcon name="spark" size={13} /> {suggesting ? 'AI 分析中…' : 'AI 自动打标签'}
        </button>
      </div>

      <div className="topo-v4-tablewrap">
        <table className="topo-v4-table">
          <thead>
            <tr>
              <th>访问关系</th>
              <th>服务 / 端口</th>
              <th className="is-num">访问次数</th>
              <th className="is-num">失败</th>
              <th>标签</th>
              <th className="is-actions">操作</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={6} className="topo-v4-empty">
                  没有匹配的访问关系。调整标签 / 类别筛选，或在「显示设置」恢复管理流量。
                </td>
              </tr>
            ) : null}
            {filtered.map((row) => {
              const tags = tagsByRelation.get(row.relationKey) ?? [];
              const editing = editingKey === row.relationKey;
              return (
                <tr
                  key={row.relationKey}
                  className={`${selectedKey === row.relationKey ? 'is-active' : ''}${editing ? ' is-editing' : ''}`}
                  onClick={() => onFocusRow(row)}
                >
                  <td>
                    <span className="topo-v4-relation">
                      <strong>{row.sourceLabel}</strong>
                      <MiniIcon name="arrow-right" size={12} />
                      <strong>{row.targetLabel}</strong>
                      <em>:{row.targetPort}</em>
                    </span>
                    <span className="topo-v4-sub">{row.protocol} · {row.external ? '外部依赖' : '内部访问'}</span>
                  </td>
                  <td>
                    <span className="topo-v4-sub mono">{row.sourceService} → {row.targetService}</span>
                  </td>
                  <td className="is-num">{formatConnections(row.count)}</td>
                  <td className={`is-num${row.failed > 0 ? ' is-danger' : ''}`}>{formatConnections(row.failed)}</td>
                  <td onClick={(event) => event.stopPropagation()}>
                    {tagChips(tags)}
                    {editing ? null : (
                      <button type="button" className="topo-v4-inline-btn" onClick={() => startEdit(row)}>
                        <MiniIcon name="tag" size={11} /> 打标签
                      </button>
                    )}
                  </td>
                  <td className="is-actions" onClick={(event) => event.stopPropagation()}>
                    <button type="button" className="topo-v4-inline-btn" onClick={() => onFocusRow(row)}>
                      定位
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {editingKey ? (
        <div className="topo-v4-editor">
          <div className="topo-v4-editor-head">
            <strong>新增访问关系标签</strong>
            <span>{editingKey}</span>
            <button type="button" className="topo-icon-btn" aria-label="取消打标签" onClick={() => setEditingKey(null)}>
              <MiniIcon name="close" size={13} />
            </button>
          </div>
          <div className="topo-v4-editor-grid">
            <label>
              <span>标签名称</span>
              <input className="input" value={label} onChange={(event) => setLabel(event.target.value)} placeholder="如：订单主链路 / 运维 SSH" />
            </label>
            <label>
              <span>类别</span>
              <select className="select" value={category} onChange={(event) => setCategory(event.target.value)}>
                {TAG_CATEGORIES.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>颜色</span>
              <span className="topo-v4-colors">
                {TAG_COLORS.map((value) => (
                  <button
                    key={value}
                    type="button"
                    className={`topo-v4-color${color === value ? ' is-on' : ''}`}
                    style={{ background: value }}
                    aria-label={`颜色 ${value}`}
                    onClick={() => setColor(value)}
                  />
                ))}
              </span>
            </label>
            <label className="is-wide">
              <span>备注（可选）</span>
              <input className="input" value={note} onChange={(event) => setNote(event.target.value)} placeholder="标签说明，便于团队协作" />
            </label>
          </div>
          {tagsByRelation.get(editingKey)?.length ? (
            <div className="topo-v4-existing">
              <span>已有标签：</span>
              {tagsByRelation.get(editingKey)?.map((tag) => (
                <span key={tag.id} className="topo-v4-existing-tag" style={{ color: tag.color ?? '#3d7ab8' }}>
                  {tag.label}
                  <button type="button" aria-label={`删除标签 ${tag.label}`} onClick={() => onDeleteTag(tag)}>
                    <MiniIcon name="close" size={10} />
                  </button>
                </span>
              ))}
            </div>
          ) : null}
          <div className="topo-v4-editor-actions">
            <button type="button" className="btn btn-outline btn-sm" onClick={() => setEditingKey(null)}>
              取消
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={!label.trim() || savingKey === editingKey}
              onClick={() => {
                onSaveTag({ relationKey: editingKey, label: label.trim(), category, color, note: note.trim() });
                setEditingKey(null);
              }}
            >
              {savingKey === editingKey ? '保存中…' : '保存标签'}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export interface TrendsPanelProps {
  readonly mode: TrendMode;
  readonly onModeChange: (mode: TrendMode) => void;
  readonly data: AccessTrendsResponse | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly windowHours: number;
  readonly scopeLabel: string;
  readonly tagsByRelation: ReadonlyMap<string, readonly TopologyEdgeTag[]>;
  readonly selectedKey: string | null;
  readonly adoptingKey: string | null;
  readonly onWindowChange: (hours: number) => void;
  readonly onRowClick: (row: AccessTrendRow) => void;
  readonly onAdopt: (row: AccessTrendRow) => void;
  readonly onEditTag: (row: AccessTrendRow) => void;
  readonly onRetry: () => void;
}

export function TrendsPanel({
  mode,
  onModeChange,
  data,
  loading,
  error,
  windowHours,
  scopeLabel,
  tagsByRelation,
  selectedKey,
  adoptingKey,
  onWindowChange,
  onRowClick,
  onAdopt,
  onEditTag,
  onRetry,
}: TrendsPanelProps): ReactElement {
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<'opened' | 'failed'>('opened');
  const rows = data?.rows ?? [];
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return [...rows]
      .filter((row) => {
        if (!query) return true;
        return `${row.sourceHost} ${row.targetHost} ${row.targetPort} ${row.sourceService}`.toLowerCase().includes(query);
      })
      .sort((a, b) => (sort === 'opened' ? b.totalOpened - a.totalOpened : b.totalFailed - a.totalFailed));
  }, [rows, search, sort]);
  const totalOpened = rows.reduce((sum, row) => sum + row.totalOpened, 0);
  const totalFailed = rows.reduce((sum, row) => sum + row.totalFailed, 0);
  const topLink = [...rows].sort((a, b) => b.totalOpened - a.totalOpened)[0];

  if (loading) {
    return <div className="topo-v4-state"><span className="topo2-spinner" /> 正在加载访问量趋势…</div>;
  }
  if (error) {
    return (
      <div className="topo-v4-state">
        <MiniIcon name="warning" size={18} />
        <strong>访问量分析暂不可用</strong>
        <p>{error}</p>
        <button type="button" className="btn btn-outline btn-sm" onClick={onRetry}>
          重试
        </button>
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div className="topo-v4-state">
        <MiniIcon name="chart" size={20} />
        <strong>暂无访问量数据</strong>
        <p>当前时间窗内还没有 Agent 建连统计；接口上线后这里会展示 24h / 7d 的小时 / 天级趋势。</p>
      </div>
    );
  }

  return (
    <div className="topo-v4-body">
      <div className="topo-v4-trend-summary">
        <div>
          <span>访问总次数</span>
          <strong>{formatConnections(totalOpened)}</strong>
          <em>失败 {formatConnections(totalFailed)}</em>
        </div>
        <div>
          <span>Top 链路</span>
          <strong>{topLink ? `${topLink.sourceHost} → ${topLink.targetHost}:${topLink.targetPort}` : '—'}</strong>
          <em>{topLink ? `${formatConnections(topLink.totalOpened)} 次` : ''}</em>
        </div>
        <div>
          <span>时间范围</span>
          <strong>{windowHours === 24 ? '最近 24 小时' : '最近 7 天'}</strong>
          <em>{data ? `${new Date(data.from).toLocaleString('zh-CN', { hour12: false })} 起` : ''}</em>
        </div>
        <div>
          <span>当前范围</span>
          <strong>{scopeLabel}</strong>
          <em>{data?.bucket === 'hour' ? '按小时分桶' : '按天分桶'} · {rows.length} 条关系</em>
        </div>
      </div>

      <div className="topo-v4-filters">
        <TrendModeSwitch mode={mode} onChange={onModeChange} />
        <div className="topo-v4-tabs-inline">
          <button type="button" className={windowHours === 24 ? 'is-on' : ''} onClick={() => onWindowChange(24)}>
            24 小时
          </button>
          <button type="button" className={windowHours === 168 ? 'is-on' : ''} onClick={() => onWindowChange(168)}>
            7 天
          </button>
        </div>
        <label className="topo-v4-search">
          <MiniIcon name="search" size={13} />
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索源 / 目标 / 端口" />
        </label>
        <div className="topo-v4-sort">
          <button type="button" className={sort === 'opened' ? 'is-on' : ''} onClick={() => setSort('opened')}>
            按访问次数
          </button>
          <button type="button" className={sort === 'failed' ? 'is-on' : ''} onClick={() => setSort('failed')}>
            按失败
          </button>
        </div>
      </div>

      <div className="topo-v4-tablewrap">
        <table className="topo-v4-table">
          <thead>
            <tr>
              <th>源 → 目标:端口</th>
              <th>服务</th>
              <th className="is-num">访问次数</th>
              <th className="is-num">失败</th>
              <th>趋势</th>
              <th>标签 / 建议</th>
              <th className="is-actions">操作</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((row) => {
              const tags = tagsByRelation.get(row.relationKey) ?? row.tags ?? [];
              return (
                <tr
                  key={row.id || row.relationKey}
                  className={selectedKey === row.relationKey ? 'is-active' : ''}
                  onClick={() => onRowClick(row)}
                >
                  <td>
                    <span className="topo-v4-relation">
                      <strong>{row.sourceHost}</strong>
                      <MiniIcon name="arrow-right" size={12} />
                      <strong>{row.targetHost}</strong>
                      <em>:{row.targetPort}</em>
                    </span>
                    <span className="topo-v4-sub mono">{row.protocol} · {row.sourceService}</span>
                  </td>
                  <td>
                    <span className="topo-v4-sub mono">{row.sourceService} → :{row.targetPort}</span>
                  </td>
                  <td className="is-num">{formatConnections(row.totalOpened)}</td>
                  <td className={`is-num${row.totalFailed > 0 ? ' is-danger' : ''}`}>{formatConnections(row.totalFailed)}</td>
                  <td><Sparkline row={row} /></td>
                  <td onClick={(event) => event.stopPropagation()}>
                    {tagChips(tags)}
                    {row.suggestedTag && !tags.some((tag) => tag.label === row.suggestedTag) ? (
                      <button
                        type="button"
                        className="topo-v4-suggest"
                        disabled={adoptingKey === row.relationKey}
                        onClick={() => onAdopt(row)}
                      >
                        建议：{row.suggestedTag} · 采纳
                      </button>
                    ) : null}
                  </td>
                  <td className="is-actions" onClick={(event) => event.stopPropagation()}>
                    <button type="button" className="topo-v4-inline-btn" onClick={() => onEditTag(row)}>
                      打标签
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="topo-v4-note">
        访问次数 = Agent 每 10s 窗口统计的 TCP 建连次数（opened 合计），非 HTTP 请求数；失败为窗口内建连失败次数。
        当前窗口内共 {filtered.length} 条关系，点击任意行可在画布高亮对应边。
      </p>
    </div>
  );
}


export interface HttpRequestsPanelProps {
  readonly mode: TrendMode;
  readonly onModeChange: (mode: TrendMode) => void;
  readonly data: HttpRequestTrendsResponse | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly windowHours: number;
  readonly scopeLabel: string;
  readonly tagsByRelation: ReadonlyMap<string, readonly TopologyEdgeTag[]>;
  readonly selectedKey: string | null;
  readonly onWindowChange: (hours: number) => void;
  readonly onRowClick: (row: HttpRequestTrendRow) => void;
  readonly onEditTag: (row: HttpRequestTrendRow) => void;
  readonly onRetry: () => void;
}

const PROTOCOL_LABEL: Record<HttpRequestTrendRow['protocol'], string> = {
  http1: 'HTTP/1',
  http2: 'HTTP/2',
  grpc: 'gRPC',
};

export function HttpRequestsPanel({
  mode,
  onModeChange,
  data,
  loading,
  error,
  windowHours,
  scopeLabel,
  tagsByRelation,
  selectedKey,
  onWindowChange,
  onRowClick,
  onEditTag,
  onRetry,
}: HttpRequestsPanelProps): ReactElement {
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<'requests' | 'errors'>('requests');
  const rows = data?.rows ?? [];
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return [...rows]
      .filter((row) => {
        if (!query) return true;
        return `${row.sourceHost} ${row.targetHost} ${row.targetPort} ${row.method} ${row.protocol} ${row.sourceService}`
          .toLowerCase()
          .includes(query);
      })
      .sort((a, b) => (sort === 'requests' ? b.totalRequests - a.totalRequests : b.totalErrors - a.totalErrors));
  }, [rows, search, sort]);
  const totalRequests = rows.reduce((sum, row) => sum + row.totalRequests, 0);
  const totalErrors = rows.reduce((sum, row) => sum + row.totalErrors, 0);
  const topRow = [...rows].sort((a, b) => b.totalRequests - a.totalRequests)[0];

  if (loading) {
    return <div className="topo-v4-state"><span className="topo2-spinner" /> 正在加载 HTTP/gRPC 请求量…</div>;
  }
  if (error) {
    return (
      <div className="topo-v4-state">
        <MiniIcon name="chart" size={20} />
        <strong>HTTP/gRPC 请求量暂未就绪</strong>
        <p>当前环境暂未返回请求级数据（{error}）。仅统计明文 HTTP/1 请求行、HTTP/2 HEADERS 与 gRPC 请求；HTTPS / gRPC-TLS 无法解密，不计数。</p>
        <p>接口上线或存在明文 HTTP 流量后，这里会展示请求量、失败与趋势。</p>
        <button type="button" className="btn btn-outline btn-sm" onClick={onRetry}>重试</button>
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div className="topo-v4-state">
        <MiniIcon name="chart" size={20} />
        <strong>暂无 HTTP/gRPC 请求数据</strong>
        <p>仅统计 Agent 旁路可见的明文 HTTP/1 请求行、HTTP/2 HEADERS 与 gRPC 请求；HTTPS/gRPC-TLS 无法解密，不计数。</p>
        <p>可切换到「TCP 建连」查看连接级趋势。</p>
      </div>
    );
  }

  return (
    <div className="topo-v4-body">
      <div className="topo-v4-trend-summary">
        <div>
          <span>请求总数</span>
          <strong>{formatConnections(totalRequests)}</strong>
          <em>失败 {formatConnections(totalErrors)}</em>
        </div>
        <div>
          <span>Top 关系</span>
          <strong>{topRow ? `${topRow.sourceHost} → ${topRow.targetHost}:${topRow.targetPort}` : '—'}</strong>
          <em>{topRow ? `${formatConnections(topRow.totalRequests)} 次 · ${PROTOCOL_LABEL[topRow.protocol]} ${topRow.method}` : ''}</em>
        </div>
        <div>
          <span>时间范围</span>
          <strong>{windowHours === 24 ? '最近 24 小时' : '最近 7 天'}</strong>
          <em>{data ? `${new Date(data.from).toLocaleString('zh-CN', { hour12: false })} 起` : ''}</em>
        </div>
        <div>
          <span>当前范围</span>
          <strong>{scopeLabel}</strong>
          <em>{data?.bucket === 'hour' ? '按小时分桶' : '按天分桶'} · {rows.length} 条请求关系</em>
        </div>
      </div>

      <div className="topo-v4-filters">
        <TrendModeSwitch mode={mode} onChange={onModeChange} />
        <div className="topo-v4-tabs-inline">
          <button type="button" className={windowHours === 24 ? 'is-on' : ''} onClick={() => onWindowChange(24)}>24 小时</button>
          <button type="button" className={windowHours === 168 ? 'is-on' : ''} onClick={() => onWindowChange(168)}>7 天</button>
        </div>
        <label className="topo-v4-search">
          <MiniIcon name="search" size={13} />
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索源 / 目标 / 端口 / 方法" />
        </label>
        <div className="topo-v4-sort">
          <button type="button" className={sort === 'requests' ? 'is-on' : ''} onClick={() => setSort('requests')}>按请求数</button>
          <button type="button" className={sort === 'errors' ? 'is-on' : ''} onClick={() => setSort('errors')}>按失败</button>
        </div>
      </div>

      <div className="topo-v4-tablewrap">
        <table className="topo-v4-table">
          <thead>
            <tr>
              <th>源 → 目标:端口</th>
              <th>服务</th>
              <th>协议</th>
              <th>方法</th>
              <th className="is-num">请求数</th>
              <th className="is-num">失败</th>
              <th>趋势</th>
              <th>标签/建议</th>
              <th className="is-actions">操作</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((row) => {
              const tags = tagsByRelation.get(row.relationKey) ?? row.tags ?? [];
              return (
                <tr
                  key={row.id || row.relationKey}
                  className={selectedKey === row.relationKey ? 'is-active' : ''}
                  onClick={() => onRowClick(row)}
                >
                  <td>
                    <span className="topo-v4-relation">
                      <strong>{row.sourceHost}</strong>
                      <MiniIcon name="arrow-right" size={12} />
                      <strong>{row.targetHost}</strong>
                      <em>:{row.targetPort}</em>
                    </span>
                    <span className="topo-v4-sub mono">{row.sourceIp} · {row.targetIp}</span>
                  </td>
                  <td><span className="topo-v4-sub mono">{row.sourceService}</span></td>
                  <td><span className={`topo-v5-proto is-${row.protocol}`}>{PROTOCOL_LABEL[row.protocol]}</span></td>
                  <td><span className="topo-v5-method">{row.method || '—'}</span></td>
                  <td className="is-num">{formatConnections(row.totalRequests)}</td>
                  <td className={`is-num${row.totalErrors > 0 ? ' is-danger' : ''}`}>{formatConnections(row.totalErrors)}</td>
                  <td><MiniSpark values={row.buckets.map((bucket) => bucket.requests)} failed={row.buckets.map((bucket) => bucket.errors)} label="请求趋势" /></td>
                  <td>
                    {tags.length > 0 ? tagChips(tags) : (
                      <span className="topo-v4-muted">建议：{/^\d+\./.test(row.targetHost) ? '外部依赖' : '应用调用'}</span>
                    )}
                  </td>
                  <td className="is-actions" onClick={(event) => event.stopPropagation()}>
                    <button type="button" className="topo-v4-inline-btn" onClick={() => onEditTag(row)}>打标签</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="topo-v4-note">
        请求数 = 明文 HTTP/1 请求行 + HTTP/2 HEADERS 计数；HTTPS / gRPC-TLS 无法解密，不计数。gRPC 按配置端口识别，方法来自 HTTP/2 :method 头。
        当前窗口内 {filtered.length} 条请求关系，点击任意行可在画布高亮对应边。
      </p>
    </div>
  );
}

export interface TagSuggestionsDialogProps {
  readonly suggestions: readonly EdgeTagSuggestion[];
  readonly labels: ReadonlyMap<string, string>;
  readonly loading: boolean;
  readonly error: string | null;
  readonly warning: string | null;
  readonly model: string | null;
  readonly fallback: boolean;
  readonly applying: boolean;
  readonly onClose: () => void;
  readonly onConfirm: (selected: readonly EdgeTagSuggestion[]) => void;
}

export function TagSuggestionsDialog({
  suggestions,
  labels,
  loading,
  error,
  warning,
  model,
  fallback,
  applying,
  onClose,
  onConfirm,
}: TagSuggestionsDialogProps): ReactElement {
  const [selected, setSelected] = useState<Set<string>>(() => new Set(suggestions.map((item) => item.relationKey)));
  useEffect(() => {
    // 真实接口是异步返回，建议到达后默认全选；用户后续取消不受影响。
    setSelected(new Set(suggestions.map((item) => item.relationKey)));
  }, [suggestions]);
  const allSelected = suggestions.length > 0 && suggestions.every((item) => selected.has(item.relationKey));
  return (
    <div className="topo-v5-suggest-overlay" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <div className="topo-v5-suggest" role="dialog" aria-modal="true" aria-label="AI 自动打标签建议">
        <header className="topo-v5-suggest-head">
          <div>
            <div className="topo-rail-eyebrow">AI AUTO TAG · 大模型建议</div>
            <h3>AI 自动打标签</h3>
          </div>
          <button type="button" className="topo-icon-btn" aria-label="关闭 AI 建议" onClick={onClose}>
            <MiniIcon name="close" size={16} />
          </button>
        </header>

        {loading ? (
          <div className="topo-v4-state"><span className="topo2-spinner" /> 大模型正在分析访问关系…</div>
        ) : error ? (
          <div className="topo-v4-state">
            <MiniIcon name="warning" size={18} />
            <strong>自动打标签失败</strong>
            <p>{error}</p>
          </div>
        ) : suggestions.length === 0 ? (
          <div className="topo-v4-state">
            <MiniIcon name="spark" size={20} />
            <strong>没有可建议的关系</strong>
            <p>当前图里没有新的可打标签关系，或大模型未返回建议。可稍后重试。</p>
          </div>
        ) : (
          <>
            {warning ? <div className="topo-v5-warning"><MiniIcon name="warning" size={13} /> {warning}</div> : null}
            <div className="topo-v5-meta">
              <span>{fallback ? '规则引擎建议' : `大模型 · ${model ?? '—'}`}</span>
              <span>{suggestions.length} 条建议</span>
            </div>
            <div className="topo-v5-toolbar">
              <label className="topo-v5-check">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={(event) => setSelected(event.target.checked ? new Set(suggestions.map((item) => item.relationKey)) : new Set())}
                />
                全选
              </label>
              <span className="topo-v4-muted">已选 {selected.size} 条</span>
            </div>
            <div className="topo-v5-suggest-list">
              {suggestions.map((item) => {
                const checked = selected.has(item.relationKey);
                return (
                  <label key={`${item.relationKey}|${item.label}`} className={`topo-v5-suggest-row${checked ? ' is-checked' : ''}`}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => {
                        setSelected((current) => {
                          const next = new Set(current);
                          if (next.has(item.relationKey)) next.delete(item.relationKey);
                          else next.add(item.relationKey);
                          return next;
                        });
                      }}
                    />
                    <span className="topo-v5-suggest-main">
                      <span className="topo-v5-suggest-relation">{labels.get(item.relationKey) ?? item.relationKey}</span>
                      <span className="topo-v5-suggest-reason">{item.reason ?? '未提供原因'}</span>
                    </span>
                    <span className="topo-v5-suggest-tag" style={{ color: item.category === '运维工具' ? 'var(--warn)' : 'var(--blue-text)' }}>
                      {item.label}
                      <em>{item.category}</em>
                    </span>
                    <span className="topo-v5-conf">{Math.round(item.confidence * 100)}%</span>
                    <span className={`topo-v5-source is-${item.source}`}>{item.source === 'model' ? '大模型' : '规则'}</span>
                  </label>
                );
              })}
            </div>
            <footer className="topo-v5-suggest-foot">
              <button type="button" className="btn btn-outline btn-sm" onClick={onClose}>取消</button>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={selected.size === 0 || applying}
                onClick={() => onConfirm(suggestions.filter((item) => selected.has(item.relationKey)))}
              >
                {applying ? '正在保存…' : `采纳所选（${selected.size}）`}
              </button>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}
