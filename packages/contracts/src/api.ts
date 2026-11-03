import type { Permission } from './permissions.js';
import type { RoleId } from './roles.js';
import type { ThemeMode } from './theme.js';

export interface MeResponse {
  readonly user: {
    readonly id: string;
    readonly username: string;
    readonly displayName: string;
    readonly isPlatformAdmin: boolean;
  };
  readonly tenants: readonly {
    readonly id: string;
    readonly slug: string;
    readonly name: string;
    readonly roles: readonly RoleId[];
    readonly permissions: readonly Permission[];
  }[];
}

export interface HomeResponse {
  readonly tenantId: string;
  readonly roleView: string;
  readonly cards: readonly { readonly id: string; readonly title: string }[];
  readonly metrics: {
    readonly connectors: number;
    readonly incidentsOpen: number;
    readonly scenarios: number;
    readonly pendingApprovals: number;
    readonly activeSessions: number;
    readonly agentsOnline: number;
    readonly agentsTotal: number;
    readonly tasksActive: number;
    readonly messagesUnread: number;
  };
  readonly recentIncidents: readonly {
    readonly id: string;
    readonly title: string;
    readonly severity: string;
    readonly status: string;
  }[];
  readonly recentSessions: readonly {
    readonly id: string;
    readonly roleView: string;
    readonly status: string;
  }[];
}

export interface StartSessionRequest {
  readonly tenantId: string;
  readonly roleView: string;
  readonly scenarioId?: string;
}

export interface PromptRequest {
  readonly text: string;
  readonly idempotencyKey: string;
}

export interface ApprovalResponse {
  readonly decision: 'approve' | 'deny';
  readonly reason?: string;
}

export interface ThemeUpdateRequest {
  readonly mode: ThemeMode;
}
