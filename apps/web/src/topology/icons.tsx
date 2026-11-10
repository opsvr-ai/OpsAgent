/** 拓扑画布用到的内联 SVG 图标（不依赖图标字体 / 外链）。 */
import type { ReactNode } from 'react';
import type { TopologyNodeKind, TopologyTier } from '@opsagent/contracts';

interface IconProps {
  readonly size?: number;
  readonly color?: string;
  readonly strokeWidth?: number;
}

function frame(children: ReactNode, { size = 16, color = 'currentColor', strokeWidth = 1.8 }: IconProps): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export function KindIcon({ kind, ...props }: IconProps & { readonly kind: TopologyNodeKind }): ReactNode {
  switch (kind) {
    case 'gateway':
      return frame(
        <>
          <rect x="3" y="6" width="18" height="12" rx="3" />
          <path d="M7 12h9" />
          <path d="M13 9l3 3-3 3" />
        </>,
        props,
      );
    case 'service':
      return frame(
        <>
          <rect x="4" y="4" width="16" height="16" rx="4" />
          <rect x="9" y="9" width="6" height="6" rx="1.4" />
          <path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2" />
        </>,
        props,
      );
    case 'database':
      return frame(
        <>
          <ellipse cx="12" cy="6" rx="7.2" ry="3" />
          <path d="M4.8 6v11.4c0 1.7 3.2 3.1 7.2 3.1s7.2-1.4 7.2-3.1V6" />
          <path d="M4.8 11.5c0 1.7 3.2 3.1 7.2 3.1s7.2-1.4 7.2-3.1" />
        </>,
        props,
      );
    case 'cache':
      return frame(
        <>
          <path d="M12 3l8 4-8 4-8-4 8-4z" />
          <path d="M4 12l8 4 8-4" />
          <path d="M4 17l8 4 8-4" />
        </>,
        props,
      );
    case 'mq':
      return frame(
        <>
          <rect x="3" y="4.5" width="18" height="5" rx="2" />
          <rect x="3" y="14.5" width="18" height="5" rx="2" />
          <path d="M7 7h.01M7 17h.01" />
          <path d="M12 9.5v5" />
        </>,
        props,
      );
    case 'storage':
      return frame(
        <>
          <rect x="3" y="4" width="18" height="7" rx="2" />
          <rect x="3" y="13" width="18" height="7" rx="2" />
          <path d="M7 7.5h.01M7 16.5h.01" />
        </>,
        props,
      );
    case 'external':
      return frame(
        <>
          <circle cx="12" cy="12" r="8.4" />
          <path d="M3.6 12h16.8" />
          <path d="M12 3.6c2.6 2.8 2.6 14 0 16.8M12 3.6c-2.6 2.8-2.6 14 0 16.8" />
        </>,
        props,
      );
    default:
      return frame(
        <>
          <circle cx="12" cy="12" r="8.6" />
          <path d="M9.6 9.2a2.5 2.5 0 113.6 2.3c-.8.5-1.2 1-1.2 1.9" />
          <path d="M12 17.2h.01" />
        </>,
        props,
      );
  }
}

export function TierIcon({ tier, ...props }: IconProps & { readonly tier: TopologyTier }): ReactNode {
  switch (tier) {
    case 'ingress':
      return frame(
        <>
          <path d="M4 5h16" />
          <path d="M12 8v8" />
          <path d="M8.5 12.5L12 16l3.5-3.5" />
          <path d="M7 20h10" />
        </>,
        props,
      );
    case 'app':
      return frame(
        <>
          <rect x="3" y="3" width="7.5" height="7.5" rx="2" />
          <rect x="13.5" y="3" width="7.5" height="7.5" rx="2" />
          <rect x="3" y="13.5" width="7.5" height="7.5" rx="2" />
          <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="2" />
        </>,
        props,
      );
    case 'middleware':
      return frame(
        <>
          <path d="M12 3l9 4.5-9 4.5-9-4.5L12 3z" />
          <path d="M3 12l9 4.5 9-4.5" />
          <path d="M3 16.5L12 21l9-4.5" />
        </>,
        props,
      );
    case 'data':
      return frame(
        <>
          <ellipse cx="12" cy="5.6" rx="7.2" ry="2.8" />
          <path d="M4.8 5.6v12.8c0 1.6 3.2 2.8 7.2 2.8s7.2-1.2 7.2-2.8V5.6" />
          <path d="M4.8 12c0 1.6 3.2 2.8 7.2 2.8s7.2-1.2 7.2-2.8" />
        </>,
        props,
      );
    case 'external':
      return frame(
        <>
          <circle cx="12" cy="12" r="8.4" />
          <path d="M3.6 12h16.8" />
          <path d="M12 3.6c2.6 2.8 2.6 14 0 16.8M12 3.6c-2.6 2.8-2.6 14 0 16.8" />
        </>,
        props,
      );
    default:
      return frame(
        <>
          <rect x="3" y="4" width="18" height="7" rx="2" />
          <rect x="3" y="13" width="18" height="7" rx="2" />
          <path d="M7 7.5h.01M7 16.5h.01" />
        </>,
        props,
      );
  }
}

export function MiniIcon({
  name,
  ...props
}: IconProps & {
  readonly name:
    | 'search'
    | 'close'
    | 'plus'
    | 'minus'
    | 'fit'
    | 'target'
    | 'spark'
    | 'refresh'
    | 'play'
    | 'chevron'
    | 'filter'
    | 'link'
    | 'alert'
    | 'clock'
    | 'arrow-right'
    | 'arrow-left'
    | 'layers'
    | 'pin'
    | 'warning';
}): ReactNode {
  switch (name) {
    case 'search':
      return frame(
        <>
          <circle cx="11" cy="11" r="6.6" />
          <path d="M16 16l4.5 4.5" />
        </>,
        props,
      );
    case 'close':
      return frame(
        <>
          <path d="M6 6l12 12M18 6L6 18" />
        </>,
        props,
      );
    case 'plus':
      return frame(<path d="M12 5v14M5 12h14" />, props);
    case 'minus':
      return frame(<path d="M5 12h14" />, props);
    case 'fit':
      return frame(
        <>
          <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
        </>,
        props,
      );
    case 'target':
      return frame(
        <>
          <circle cx="12" cy="12" r="7" />
          <circle cx="12" cy="12" r="2.4" />
          <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
        </>,
        props,
      );
    case 'spark':
      return frame(
        <>
          <path d="M12 3l1.8 5.1L19 10l-5.2 1.9L12 17l-1.8-5.1L5 10l5.2-1.9L12 3z" />
          <path d="M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2z" />
        </>,
        props,
      );
    case 'refresh':
      return frame(
        <>
          <path d="M20 5v5h-5" />
          <path d="M19.2 10a7.5 7.5 0 10-1.6 7.2" />
        </>,
        props,
      );
    case 'play':
      return frame(<path d="M8 5.5l11 6.5-11 6.5v-13z" />, props);
    case 'chevron':
      return frame(<path d="M6 9l6 6 6-6" />, props);
    case 'filter':
      return frame(
        <>
          <path d="M3.5 5h17l-6.5 7.6V20l-4-2.2v-5.2L3.5 5z" />
        </>,
        props,
      );
    case 'link':
      return frame(
        <>
          <path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 10-5.7-5.7L11.5 7" />
          <path d="M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 105.7 5.7L12.5 17" />
        </>,
        props,
      );
    case 'alert':
      return frame(
        <>
          <path d="M12 3.5L21 19H3L12 3.5z" />
          <path d="M12 9.5v4.2M12 16.8h.01" />
        </>,
        props,
      );
    case 'warning':
      return frame(
        <>
          <circle cx="12" cy="12" r="8.6" />
          <path d="M12 7.8v5M12 16.2h.01" />
        </>,
        props,
      );
    case 'clock':
      return frame(
        <>
          <circle cx="12" cy="12" r="8.4" />
          <path d="M12 7.5V12l3 2" />
        </>,
        props,
      );
    case 'arrow-right':
      return frame(
        <>
          <path d="M4 12h15" />
          <path d="M14 7l5 5-5 5" />
        </>,
        props,
      );
    case 'arrow-left':
      return frame(
        <>
          <path d="M20 12H5" />
          <path d="M10 7l-5 5 5 5" />
        </>,
        props,
      );
    case 'layers':
      return frame(
        <>
          <path d="M12 3l9 4.5-9 4.5-9-4.5L12 3z" />
          <path d="M3 12l9 4.5 9-4.5" />
          <path d="M3 16.5L12 21l9-4.5" />
        </>,
        props,
      );
    case 'pin':
      return frame(
        <>
          <path d="M12 21s6.5-6.2 6.5-11a6.5 6.5 0 10-13 0C5.5 14.8 12 21 12 21z" />
          <circle cx="12" cy="10" r="2.3" />
        </>,
        props,
      );
    default:
      return frame(<circle cx="12" cy="12" r="8" />, props);
  }
}
