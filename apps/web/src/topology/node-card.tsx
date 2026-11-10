import { memo } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactElement } from 'react';
import { cardLayout, formatConnections, measureText, serviceLabel, type PositionedNode } from './layout.js';
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
}

function chipWidth(text: string): number {
  return Math.round(measureText(text, 11) + 13);
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
}: NodeCardProps): ReactElement {
  const { node: data, aggregated } = node;
  const card = cardLayout(data, aggregated, node.aggregated ? 'system' : 'host');
  const statusLabel = data.status === 'offline' ? '离线' : data.status === 'unknown' ? '未上报' : '在线';
  const statusColor = data.status === 'offline' ? '#ff6b6b' : data.status === 'unknown' ? '#8fa3bf' : '#34d399';
  const anomalies = data.anomalies ?? [];
  const maxChips = aggregated ? 3 : 2;
  const services = data.services.slice(0, maxChips);
  const extraServices = data.services.length - services.length;

  const className = [
    'topo-node',
    aggregated ? 'is-system' : '',
    selected ? 'is-selected' : '',
    hovered ? 'is-hovered' : '',
    highlighted ? 'is-lit' : '',
    dimmed ? 'is-dimmed' : '',
    searching ? (matched ? 'is-match' : 'is-miss') : '',
    data.status === 'offline' ? 'is-offline' : '',
    data.status === 'unknown' ? 'is-unknown' : '',
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

  const subText = aggregated
    ? `${node.hostCount} 台主机 · 内部 ${formatConnections(node.internalConnections)} 连接`
    : card.subText;
  const titleLines = card.titleLines.length > 0 ? card.titleLines : [data.label];
  const statusY = card.iconY + card.iconTile / 2;
  const chipAvailable = card.w - 20;

  let chipX = 10;
  const chips = services.map((service) => {
    const label = serviceLabel(service);
    const width = chipWidth(label);
    const item = { service, label, width, x: chipX };
    chipX += width + 5;
    return item;
  });
  const visibleChips = chips.filter((item) => item.x + item.width <= chipAvailable);
  const hiddenChips = services.length - visibleChips.length + extraServices;

  return (
    <g
      className={className}
      transform={`translate(${node.x.toFixed(1)} ${node.y.toFixed(1)})`}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      role="button"
      aria-label={`${data.label} ${statusLabel}`}
    >
      <rect className="topo-node-glow" x={-6} y={-6} width={card.w + 12} height={card.h + 12} rx={16} fill={node.systemColor} />
      <rect className="topo-node-bg" width={card.w} height={card.h} rx={aggregated ? 14 : 11} />
      <rect className="topo-node-tint" width={card.w} height={card.h} rx={aggregated ? 14 : 11} fill={node.systemColor} />
      <rect
        className="topo-node-bar"
        x={0.8}
        y={12}
        width={3}
        height={card.h - 24}
        rx={1.6}
        fill={node.systemColor}
      />
      <rect
        className="topo-node-icon-tile"
        x={card.iconX}
        y={card.iconY}
        width={card.iconTile}
        height={card.iconTile}
        rx={aggregated ? 9 : 7}
        fill={node.systemColor}
      />
      <g transform={`translate(${card.iconX + (card.iconTile - card.iconSize) / 2} ${card.iconY + (card.iconTile - card.iconSize) / 2})`}>
        <KindIcon kind={data.kind} size={card.iconSize} color={node.systemColor} strokeWidth={1.9} />
      </g>
      <text
        className={aggregated ? 'topo-node-title is-system' : 'topo-node-title'}
        x={card.titleX}
        y={card.titleY}
        fontSize={card.titleFont}
      >
        {titleLines.map((line, index) => (
          <tspan key={`${line}-${index}`} x={card.titleX} dy={index === 0 ? 0 : card.titleLineHeight}>
            {line}
          </tspan>
        ))}
      </text>
      <circle className="topo-node-status" cx={card.w - 12} cy={statusY} r={3} fill={statusColor} />
      <text className="topo-node-sub" x={card.subX} y={card.subY}>
        {subText}
      </text>
      {card.ipText ? (
        <text className="topo-node-ip" x={card.subX} y={card.ipY}>
          {card.ipText}
        </text>
      ) : null}
      {anomalies.length > 0 ? (
        <g className="topo-node-alert">
          <circle className="topo-node-alert-halo" cx={card.w - 12} cy={aggregated ? 34 : 29} r={7} fill="#ff5d5d" />
          <circle cx={card.w - 12} cy={aggregated ? 34 : 29} r={3.4} fill="#ff5d5d" />
          {anomalies.length > 1 ? (
            <text x={card.w - 20} y={aggregated ? 38 : 33} textAnchor="end">
              {anomalies.length}
            </text>
          ) : null}
        </g>
      ) : null}
      {visibleChips.map((item) => (
        <g key={`${item.service.name}-${item.service.port}`} className="topo-node-chip">
          <rect x={item.x} y={card.chipY} width={item.width} height={17} rx={4.5} fill={node.systemColor} />
          <text x={item.x + item.width / 2} y={card.chipY + 12.5} textAnchor="middle">
            {item.label}
          </text>
        </g>
      ))}
      {hiddenChips > 0 ? (
        <text
          className="topo-node-chip-more"
          x={visibleChips.length > 0 ? Math.min(chipAvailable, chipX) - 2 : 10}
          y={card.chipY + 12.5}
          textAnchor="start"
        >
          +{hiddenChips}
        </text>
      ) : null}
      <g className="topo-node-metrics">
        <text x={10} y={card.metricsY} fontSize={card.metricsFont}>
          <tspan className="metric-in">入 {formatConnections(node.incoming)}</tspan>
          <tspan x={10 + measureText(`入 ${formatConnections(node.incoming)}`, 11.5) + 12} className="metric-out">
            出 {formatConnections(node.outgoing)}
          </tspan>
          <tspan
            x={10 + measureText(`入 ${formatConnections(node.incoming)}`, 11.5) + measureText(`出 ${formatConnections(node.outgoing)}`, 11.5) + 24}
            className={node.failed > 0 ? 'metric-fail is-hot' : 'metric-fail'}
          >
            异常 {formatConnections(node.failed)}
          </tspan>
        </text>
      </g>
      {selected ? <rect className="topo-node-ring" width={card.w} height={card.h} rx={aggregated ? 14 : 11} stroke={node.systemColor} /> : null}
    </g>
  );
}

export const NodeCard = memo(NodeCardView);
