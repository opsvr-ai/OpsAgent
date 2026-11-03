import { describe, expect, it, vi } from 'vitest';
import { DshRuntime, type DshEventRunner } from '../src/runtime/dsh.js';

function runner(events: Record<string, unknown>[]): DshEventRunner {
  return {
    async *run() {
      for (const event of events) yield event;
    },
  };
}

async function collect(iterable: AsyncIterable<{ type: string; [key: string]: unknown }>) {
  const result: { type: string; [key: string]: unknown }[] = [];
  for await (const event of iterable) result.push(event);
  return result;
}

describe('DshRuntime', () => {
  it('maps dsh text and turn_end to runtime events', async () => {
    const runtime = new DshRuntime(
      runner([
        { type: 'session', sessionId: 'dsh-real-1' },
        { type: 'text', text: 'hello' },
        { type: 'status', phase: 'turn_end', reason: { kind: 'completed' } },
      ]),
    );
    const session = await runtime.startSession({
      tenantId: 't-1',
      userId: 'u-1',
      roleView: 'tenant_admin',
    });
    const events = await collect(runtime.prompt(session.runtimeSessionId, 'hi', 'idem-1'));
    expect(events.map((event) => event.type)).toEqual(['assistant.delta', 'session.done']);
    expect(events[0]).toMatchObject({ text: 'hello', sessionId: session.runtimeSessionId });
  });

  it('reuses the dsh session id on the next prompt', async () => {
    const run = vi
      .fn()
      .mockImplementationOnce(async function* () {
        yield { type: 'session', sessionId: 'dsh-real-2' };
        yield { type: 'status', phase: 'turn_end', reason: { kind: 'completed' } };
      })
      .mockImplementationOnce(async function* () {
        yield { type: 'status', phase: 'turn_end', reason: { kind: 'completed' } };
      });
    const runtime = new DshRuntime({ run });
    const session = await runtime.startSession({
      tenantId: 't-1',
      userId: 'u-1',
      roleView: 'tenant_admin',
    });
    await collect(runtime.prompt(session.runtimeSessionId, 'one', 'idem-1'));
    await collect(runtime.prompt(session.runtimeSessionId, 'two', 'idem-2'));
    expect(run).toHaveBeenNthCalledWith(2, 'two', 'dsh-real-2');
  });

  it('emits runtime.error for a failed turn', async () => {
    const runtime = new DshRuntime(
      runner([
        { type: 'status', phase: 'turn_end', reason: { kind: 'error', message: 'boom' } },
      ]),
    );
    const session = await runtime.startSession({
      tenantId: 't-1',
      userId: 'u-1',
      roleView: 'tenant_admin',
    });
    const events = await collect(runtime.prompt(session.runtimeSessionId, 'hi', 'idem-1'));
    expect(events[0]).toMatchObject({ type: 'runtime.error', code: 'error', message: 'boom' });
  });

  it('rejects approval decisions because headless dsh has no bridge', async () => {
    const runtime = new DshRuntime(runner([]));
    await expect(runtime.respondApproval('s', 'a', 'approve')).rejects.toThrow(
      'dsh_runtime_approval_not_supported',
    );
  });
});
