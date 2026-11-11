import { memo } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactElement } from 'react';
import {
  formatConnections,
  hostCardLayout,
  measureText,
  productTone,
  systemCardLayout,
  truncateText,
  type PositionedNode,
} from './layout.js';
import { KindIcon } from './icons.js';

export interface NodeCardProps {
  readonly node: PositionedNode;
  readonly selected: boolean;
  readonly hovered: boolean;
  readonly highlighted: boolean;
  readonly dimmed: boolean;
  readonly searching: boolean;
  readonly matched: boolean;
  readonly onHover: (id: string | null) => void;
  readonly onSelect: (id: string) => void;
  readonly onFocus: (id: string) => void;
  readonly position?: { readonly x: number; readonly y: number };
  readonly dragging?: boolean;
  readonly onPointerDown?: (event: ReactPointerEvent<SVGGElement>) => void;
}

function StatusDot({ status, x, y }: { status: string; x: number; y: number }): ReactElement {
  const fill = status === 'offline' ? '#dc5a5a' : status === 'unknown' ? '#a0aab8' : '#12a171';
  return (
    <g>
      <circle cx={x} cy={y} r={4.6} fill={fill} opacity="0.16" />
      <circle cx={x} cy={y} r={2.6} fill={fill} />
    </g>
  );
}

function NodeCardView({
  node,
  selected,
  hovered,
  highlighted,
  dimmed,
  searching,
  matched,
  onHover,
  onSelect,
  onFocus,
  position,
  dragging,
  onPointerDown,
}: NodeCardProps): ReactElement {
  const data = node.node;
  const statusLabel = data.status === 'offline' ? '离线' : data.status === 'unknown' ? '未上报' : '在线';
  const anomalies = data.anomalies ?? [];
  const className = [
    'topo2-node',
    dragging ? 'is-dragging' : '',
    node.aggregated ? 'is-system' : '',
    selected ? 'is-selected' : '',
    hovered ? 'is-hovered' : '',
    highlighted ? 'is-lit' : '',
    dimmed ? 'is-dimmed' : '',
    searching ? (matched ? 'is-match' : 'is-miss') : '',
    data.status === 'offline' ? 'is-offline' : '',
    anomalies.length > 0 ? 'is-anomalous' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const handlePointerEnter = (): void => onHover(node.id);
  const handlePointerLeave = (): void => onHover(null);
  const handleClick = (event: ReactPointerEvent<SVGGElement>): void => {
    event.stopPropagation();
    onSelect(node.id);
  };
  const handleDoubleClick = (event: ReactPointerEvent<SVGGElement>): void => {
    event.stopPropagation();
    onFocus(node.id);
  };

  const tone = productTone(data.product);
  const title = `${data.label} · ${data.product ?? ''} ${data.role ?? ''} · ${statusLabel}`;
  const tooltip = [
    data.label,
    data.product ? `组件：${data.product}` : '',
    data.role ? `角色：${data.role}` : '',
    data.ip ? `IP：${data.ip}` : '',
    data.systemService ? '系统服务' : '',
    anomalies.length > 0 ? `异常：${anomalies.join('；')}` : '',
    data.note ? `备注：${data.note}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  if (node.aggregated) {
    const card = systemCardLayout(data);
    return (
      <g
        className={className}
        transform={`translate(${(position?.x ?? node.x).toFixed(1)} ${(position?.y ?? node.y).toFixed(1)})`}
        onPointerEnter={handlePointerEnter}
        onPointerLeave={handlePointerLeave}
        onPointerDown={onPointerDown}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        role="button"
        aria-label={`${data.label}，${node.hostCount} 台主机`}
      >
        <title>{tooltip}</title>
        <rect className="topo2-node-shadow" width={card.w} height={card.h} rx={12} />
        <rect className="topo2-node-bg" width={card.w} height={card.h} rx={12} />
        <rect className="topo2-node-bar" width={4} height={card.h - 20} x={0.5} y={10} rx={2} fill={node.systemColor} />
        <text className="topo2-node-title is-system" x={16} y={logoBaseline(card.titleLines.length, card.titleFont)} fontSize={card.titleFont}>
          {card.titleLines.map((line, index) => (
            <tspan key={`${line}-${index}`} x={16} dy={index === 0 ? 0 : 19}>
              {line}
            </tspan>
          ))}
        </text>
        <text className="topo2-node-sub" x={16} y={card.titleLines.length > 1 ? 62 : 50}>
          {node.hostCount} 台主机 · 内部链路 {formatConnections(node.internalConnections)} 条
        </text>
        <text className="topo2-node-sub" x={16} y={card.titleLines.length > 1 ? 80 : 68}>
          {truncateText(data.product ?? '业务系统', card.w - 32, 11)}
        </text>
        <g className="topo2-node-metrics">
          <text x={16} y={card.h - 12} fontSize={11}>
            <tspan>入 {formatConnections(node.incoming)}</tspan>
            <tspan x={16 + measureText(`入 ${formatConnections(node.incoming)}`, 11) + 12}>出 {formatConnections(node.outgoing)}</tspan>
          </text>
        </g>
        {node.failed > 0 ? (
          <text className="topo2-node-metric-fail" x={card.w - 14} y={card.h - 12} textAnchor="end">
            异常 {formatConnections(node.failed)}
          </text>
        ) : null}
        <StatusDot status={data.status} x={card.w - 13} y={13} />
        {data.note?.includes('手动调整') ? (
          <g className="topo2-node-manual">
            <rect x={card.w - 40} y={23} width={31} height={13} rx={3} />
            <text x={card.w - 24.5} y={32.5} textAnchor="middle">手动</text>
          </g>
        ) : null}
        {selected ? <rect className="topo2-node-ring" width={card.w} height={card.h} rx={12} stroke={node.systemColor} /> : null}
      </g>
    );
  }

  const card = node.card ?? hostCardLayout(data, true);
  const productWidth = Math.min(card.productMaxWidth, Math.round(measureText(card.productText, 11.5) + 12));
  return (
    <g
      className={className}
      transform={`translate(${(position?.x ?? node.x).toFixed(1)} ${(position?.y ?? node.y).toFixed(1)})`}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
      onPointerDown={onPointerDown}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      role="button"
      aria-label={`${data.label} ${data.product ?? ''} ${statusLabel}`}
    >
      <title>{tooltip}</title>
      <rect className="topo2-node-shadow" width={card.w} height={card.h} rx={10} />
      <rect className="topo2-node-bg" width={card.w} height={card.h} rx={10} />
      <rect className="topo2-node-bar" width={3.5} height={card.h - 16} x={0.5} y={8} rx={1.8} fill={node.systemColor} />
      <g className="topo2-product-badge" style={{ color: tone.fg }}>
        <rect width={productWidth} height={13} x={9} y={5} rx={4} style={{ fill: tone.bg, stroke: tone.border }} />
        <text x={9 + productWidth / 2} y={14.5} textAnchor="middle">
          {truncateText(card.productText, productWidth - 8, 11.5)}
        </text>
      </g>
      <text
        className="topo2-node-title"
        x={9}
        y={card.titleY}
        fontSize={card.titleFont}
        {...(card.titleCompress ? { textLength: card.titleWidth, lengthAdjust: 'spacingAndGlyphs' } : {})}
      >
        {card.titleLines.map((line, index) => (
          <tspan key={`${line}-${index}`} x={9} dy={index === 0 ? 0 : card.titleLineHeight}>
            {line}
          </tspan>
        ))}
      </text>
      <text className="topo2-node-role" x={9} y={card.roleY}>
        {card.roleLines.map((line, index) => (
          <tspan key={`${line}-${index}`} x={9} dy={index === 0 ? 0 : card.roleLineHeight}>
            {line}
          </tspan>
        ))}
      </text>
      {card.chips.map((chip, index) => {
        const previous = card.chips.slice(0, index);
        const x = 9 + previous.reduce((sum, item) => sum + Math.round(measureText(item, 11.5) + 10) + 4, 0);
        const width = Math.round(measureText(chip, 11.5) + 10);
        return (
          <g key={chip} className="topo2-chip">
            <rect x={x} y={card.chipY} width={width} height={14} rx={4} />
            <text x={x + width / 2} y={card.chipY + 10.2} textAnchor="middle">
              {chip}
            </text>
          </g>
        );
      })}
      {card.moreLabel ? (
        <text className="topo2-chip-more" x={card.w - 9} y={card.chipY + 10.8} textAnchor="end">
          {card.moreLabel}
        </text>
      ) : null}
      <g className="topo2-node-metrics">
        <text x={8} y={card.metricsY} fontSize={11}>
          <tspan className="topo2-metric-in">入{formatConnections(node.incoming)}</tspan>
          <tspan x={8 + measureText(`入${formatConnections(node.incoming)}`, 11) + 6} className="topo2-metric-out">
            出{formatConnections(node.outgoing)}
          </tspan>
          {node.failed > 0 ? (
            <tspan
              x={8 + measureText(`入${formatConnections(node.incoming)}`, 11) + measureText(`出${formatConnections(node.outgoing)}`, 11) + 12}
              className="topo2-metric-fail"
            >
              ✕{formatConnections(node.failed)}
            </tspan>
          ) : null}
        </text>
      </g>
      <StatusDot status={data.status} x={card.w - 11} y={12} />
      {anomalies.length > 0 ? (
        <g className="topo2-node-alert">
          <circle cx={card.w - 11} cy={26} r={3} fill="#dc5a5a" />
          {anomalies.length > 1 ? (
            <text x={card.w - 17} y={29} textAnchor="end">
              {anomalies.length}
            </text>
          ) : null}
        </g>
      ) : null}
      {selected ? <rect className="topo2-node-ring" width={card.w} height={card.h} rx={10} stroke={node.systemColor} /> : null}
    </g>
  );
}

function logoBaseline(lines: number, font: number): number {
  return lines > 1 ? 34 : 32 + font * 0.1;
}

export const NodeCard = memo(NodeCardView);
