import { memo } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactElement } from 'react';
import type { RoutedEdge } from './layout.js';

export interface EdgePathProps {
  readonly edge: RoutedEdge;
  readonly active: boolean;
  readonly dimmed: boolean;
  readonly animated: boolean;
  readonly gradientId: string | null;
  readonly markerId: string;
  readonly onHover: (id: string | null, point?: { x: number; y: number }) => void;
}

function EdgePathView({
  edge,
  active,
  dimmed,
  animated,
  gradientId,
  markerId,
  onHover,
}: EdgePathProps): ReactElement {
  const stroke = edge.anomalous
    ? '#dc5a5a'
    : edge.external
      ? '#8a94a6'
      : gradientId
        ? `url(#${gradientId})`
        : '#8598b0';
  const width = edge.systemEdge
    ? 2 + edge.ratio * 4.2 + (active ? 0.8 : 0)
    : 1.1 + edge.ratio * 2.6 + (active ? 0.6 : 0);
  const opacity = dimmed ? 0.06 : active ? 1 : 0.55;
  const dash = edge.anomalous ? '7 5' : edge.external ? '3 6' : undefined;
  const className = [
    'topo2-edge',
    active ? 'is-active' : '',
    dimmed ? 'is-dimmed' : '',
    edge.anomalous ? 'is-anomalous' : '',
    edge.external ? 'is-external' : '',
    edge.crossSystem ? 'is-cross' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <g className={className}>
      <title>{`${edge.fullLabel} · 新建 ${edge.edge.opened} · 失败 ${edge.edge.failed}`}</title>
      {active ? (
        <path className="topo2-edge-glow" d={edge.d} stroke={stroke} strokeWidth={width + 5} />
      ) : null}
      <path
        className="topo2-edge-line"
        d={edge.d}
        stroke={stroke}
        strokeWidth={width}
        strokeOpacity={opacity}
        markerEnd={`url(#${markerId})`}
        {...(dash ? { strokeDasharray: dash } : {})}
      />
      {animated && !dimmed ? (
        <path
          className="topo2-edge-flow"
          d={edge.d}
          stroke={edge.anomalous ? '#dc5a5a' : '#4d7db8'}
          strokeOpacity={active ? 0.9 : 0.5}
          strokeWidth={Math.max(1, width * 0.45)}
        />
      ) : null}
      <path
        className="topo2-edge-hit"
        d={edge.d}
        onPointerEnter={(event: ReactPointerEvent<SVGPathElement>) =>
          onHover(edge.edge.id, { x: event.clientX, y: event.clientY })
        }
        onPointerMove={(event: ReactPointerEvent<SVGPathElement>) =>
          onHover(edge.edge.id, { x: event.clientX, y: event.clientY })
        }
        onPointerLeave={() => onHover(null)}
        onClick={(event: ReactPointerEvent<SVGPathElement>) => {
          event.stopPropagation();
          onHover(edge.edge.id, { x: event.clientX, y: event.clientY });
        }}
      />
    </g>
  );
}

export const EdgePath = memo(EdgePathView);
