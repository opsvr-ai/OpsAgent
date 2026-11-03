import { createContext, useContext } from 'react';
import type { HomeResponse, MeResponse } from '@opsagent/contracts';

export interface SessionContextValue {
  readonly me: MeResponse;
  readonly home: HomeResponse | null;
}

export const SessionContext = createContext<SessionContextValue | null>(null);

export function useSession(): SessionContextValue | null {
  return useContext(SessionContext);
}
