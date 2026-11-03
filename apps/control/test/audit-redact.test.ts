import { describe, expect, it } from 'vitest';
import { redactMetadata } from '../src/audit/redact.js';

describe('audit metadata redaction', () => {
  it('removes secrets at any nesting level while keeping safe fields', () => {
    const redacted = redactMetadata({
      tenantId: 't-1',
      password: 'plain-text',
      nested: {
        token: 'abc',
        authorization: 'Bearer x',
        safe: 'keep',
        deeper: { secret: 's', cookie: 'c' },
      },
    });

    expect(redacted).toMatchObject({
      tenantId: 't-1',
      password: '[REDACTED]',
      nested: {
        token: '[REDACTED]',
        authorization: '[REDACTED]',
        safe: 'keep',
        deeper: { secret: '[REDACTED]', cookie: '[REDACTED]' },
      },
    });
  });

  it('bounds long strings and arrays', () => {
    const redacted = redactMetadata({
      long: 'x'.repeat(5000),
      list: Array.from({ length: 100 }, (_, index) => index),
    }) as { long: string; list: number[] };

    expect(redacted.long.length).toBeLessThanOrEqual(1024);
    expect(redacted.list.length).toBeLessThanOrEqual(50);
  });
});
