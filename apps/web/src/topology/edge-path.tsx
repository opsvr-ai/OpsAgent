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
  readonly onHover: (id: string | null) => void;
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
    ? '#ff6b6b'
    : edge.external
      ? '#9fb3d1'
      : gradientId
        ? `url(#${gradientId})`
        : edge.colorA;
  const width = edge.systemEdge
    ? 2.4 + edge.ratio * 4.6 + (active ? 0.9 : 0)
    : 1.1 + edge.ratio * 3.6 + (active ? 0.7 : 0);
  const opacity = dimmed ? 0.05 : active ? 1 : edge.systemEdge ? 0.72 : 0.52;
  const dash = edge.anomalous ? '7 5' : edge.external ? '3 6' : undefined;
  const className = [
    'topo-edge',
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
        <path className="topo-edge-glow" d={edge.d} stroke={edge.anomalous ? '#ff5d5d' : edge.colorB} strokeWidth={width + 6} />
      ) : null}
      <path
        className="topo-edge-line"
        d={edge.d}
        stroke={stroke}
        strokeWidth={width}
        strokeOpacity={opacity}
        markerEnd={`url(#${markerId})`}
        {...(dash ? { strokeDasharray: dash } : {})}
      />
      {animated && !dimmed ? (
        <path
          className="topo-edge-flow"
          d={edge.d}
          stroke={edge.anomalous ? '#ffc2c2' : '#e8f1ff'}
          strokeOpacity={active ? 0.92 : 0.62}
          strokeWidth={Math.max(1, width * 0.5)}
        />
      ) : null}
      <path
        className="topo-edge-hit"
        d={edge.d}
        onPointerEnter={() => onHover(edge.edge.id)}
        onPointerLeave={() => onHover(null)}
        onClick={(event: ReactPointerEvent<SVGPathElement>) => {
          event.stopPropagation();
          onHover(edge.edge.id);
        }}
      />
    </g>
  );
}

export const EdgePath = memo(EdgePathView);
