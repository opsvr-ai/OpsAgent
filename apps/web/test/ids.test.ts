import { describe, expect, it } from 'vitest';
import { newId } from '../src/ids.js';

describe('newId', () => {
  it('returns a UUID v4 on plain HTTP', () => {
    expect(newId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('falls back when crypto.randomUUID is unavailable', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis.crypto, 'randomUUID');
    Object.defineProperty(globalThis.crypto, 'randomUUID', { value: undefined, configurable: true });
    try {
      expect(newId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    } finally {
      if (descriptor) Object.defineProperty(globalThis.crypto, 'randomUUID', descriptor);
    }
  });
});
