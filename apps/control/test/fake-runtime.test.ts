import { describe, expect, it } from 'vitest';
import { FakeRuntime } from '../src/runtime/fake.js';

describe('FakeRuntime', () => {
  it('runs mock.echo end to end without approval', async () => {
    const runtime = new FakeRuntime();
    const session = await runtime.startSession({
      tenantId: 't-1',
      userId: 'u-1',
      roleView: 'sre_duty',
    });

    const events = [];
    for await (const event of runtime.prompt(session.runtimeSessionId, 'echo hello', 'idem-1')) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual([
      'assistant.delta',
      'tool.call',
      'tool.result',
      'session.done',
    ]);
    const tool = events.find((event) => event.type === 'tool.call');
    expect(tool).toMatchObject({ tool: 'mock.echo', risk: 'R0' });
    await runtime.close();
  });

  it('pauses mock.restart until approval and executes on approve', async () => {
    const runtime = new FakeRuntime();
    const session = await runtime.startSession({
      tenantId: 't-1',
      userId: 'u-1',
      roleView: 'sre_duty',
    });
    const iterator = runtime.prompt(session.runtimeSessionId, 'restart service', 'idem-2')[Symbol.asyncIterator]();

    const first = await iterator.next();
    expect(first.value?.type).toBe('assistant.delta');
    const second = await iterator.next();
    expect(second.value?.type).toBe('approval.request');
    if (second.value?.type !== 'approval.request') throw new Error('expected approval');
    expect(second.value.risk).toBe('R2');

    await runtime.respondApproval(session.runtimeSessionId, second.value.approvalId, 'approve');
    const remaining = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      remaining.push(next.value);
    }
    expect(remaining.map((event) => event.type)).toEqual([
      'tool.call',
      'tool.result',
      'session.done',
    ]);
    await runtime.close();
  });

  it('does not execute mock.restart when denied', async () => {
    const runtime = new FakeRuntime();
    const session = await runtime.startSession({
      tenantId: 't-1',
      userId: 'u-1',
      roleView: 'sre_duty',
    });
    const iterator = runtime.prompt(session.runtimeSessionId, 'restart service', 'idem-3')[Symbol.asyncIterator]();
    await iterator.next();
    const approval = await iterator.next();
    if (approval.value?.type !== 'approval.request') throw new Error('expected approval');

    await runtime.respondApproval(session.runtimeSessionId, approval.value.approvalId, 'deny');
    const remaining = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      remaining.push(next.value);
    }
    expect(remaining.some((event) => event.type === 'tool.call')).toBe(false);
    expect(remaining.at(-1)?.type).toBe('session.done');
    await runtime.close();
  });
});
