import { describe, expect, it } from 'vitest';
import {
  PERMISSIONS,
  ROLE_IDS,
  ROLE_TEMPLATES,
  RUNTIME_EVENT_TAGS,
  THEME_MODES,
  permissionsFor,
} from '../src/index.js';

describe('role and permission contracts', () => {
  it('defines exactly nine unique roles', () => {
    expect(ROLE_IDS).toHaveLength(9);
    expect(new Set(ROLE_IDS).size).toBe(9);
  });

  it('gives every role at least one permission from the catalog', () => {
    for (const role of ROLE_IDS) {
      expect(ROLE_TEMPLATES[role].permissions.length).toBeGreaterThan(0);
      for (const permission of ROLE_TEMPLATES[role].permissions) {
        expect(PERMISSIONS).toContain(permission);
      }
    }
  });

  it('unions multi-role permissions without duplicates', () => {
    const union = permissionsFor(['sre_duty', 'dba']);
    expect(union).toContain('session.create');
    expect(union).toContain('scenario.run');
    expect(new Set(union).size).toBe(union.length);
  });
});

describe('theme and runtime contracts', () => {
  it('defines exactly four theme modes', () => {
    expect(THEME_MODES).toEqual(['light', 'dark', 'system', 'time']);
  });

  it('keeps runtime event tags unique', () => {
    expect(new Set(RUNTIME_EVENT_TAGS).size).toBe(RUNTIME_EVENT_TAGS.length);
  });
});
