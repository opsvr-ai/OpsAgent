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
    expect(run).toHaveBeenNthCalledWith(2, 'two', 'dsh-real-2', expect.any(Object));
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

  it('maps dsh tool calls and results', async () => {
    const runtime = new DshRuntime(
      runner([
        {
          type: 'tool_call',
          callId: 'c1',
          tool: 'read',
          input: { file_path: 'package.json' },
        },
        { type: 'tool_result', callId: 'c1', status: 'completed', result: '{}' },
        { type: 'status', phase: 'turn_end', reason: { kind: 'completed' } },
      ]),
    );
    const session = await runtime.startSession({
      tenantId: 't-1',
      userId: 'u-1',
      roleView: 'tenant_admin',
    });
    const events = await collect(runtime.prompt(session.runtimeSessionId, 'read', 'idem-1'));
    expect(events.map((event) => event.type)).toEqual([
      'tool.call',
      'tool.result',
      'session.done',
    ]);
    expect(events[0]).toMatchObject({ tool: 'read', risk: 'R0' });
    expect(events[1]).toMatchObject({ tool: 'read' });
  });

  it('passes tenant model credentials to dsh', async () => {
    const run = vi.fn().mockImplementation(async function* () {
      yield { type: 'status', phase: 'turn_end', reason: { kind: 'completed' } };
    });
    const runtime = new DshRuntime({ run }, async () => ({
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      apiKey: 'tenant-key',
    }));
    const session = await runtime.startSession({
      tenantId: 't-1',
      userId: 'u-1',
      roleView: 'tenant_admin',
    });
    await collect(runtime.prompt(session.runtimeSessionId, 'hi', 'idem-1'));
    expect(run).toHaveBeenCalledWith(
      'hi',
      undefined,
      expect.objectContaining({
        DEEPSEEK_API_KEY: 'tenant-key',
        DEEPSEEK_BASE_URL: 'https://api.deepseek.com/v1',
        DEEPSEEK_MODEL: 'deepseek-chat',
      }),
    );
  });

  it('selects the requested tenant model', async () => {
    const run = vi.fn().mockImplementation(async function* () {
      yield { type: 'status', phase: 'turn_end', reason: { kind: 'completed' } };
    });
    const resolver = vi.fn().mockResolvedValue({
      provider: 'openai',
      baseUrl: 'https://llm.example/v1',
      model: 'qwen-prod',
      apiKey: 'selected-key',
    });
    const runtime = new DshRuntime({ run }, resolver);
    const session = await runtime.startSession({
      tenantId: 't-2',
      userId: 'u-2',
      roleView: 'tenant_admin',
    });
    await collect(runtime.prompt(session.runtimeSessionId, 'hi', 'idem-2', {
      modelId: 'model-2',
    }));
    expect(resolver).toHaveBeenCalledWith('t-2', 'model-2');
    expect(run).toHaveBeenCalledWith(
      'hi',
      undefined,
      expect.objectContaining({
        DEEPSEEK_MODEL: 'qwen-prod',
        DSH_ACCOUNT_MODEL: 'qwen-prod',
        OPSAGENT_MODEL_PROVIDER: 'openai',
        OPSAGENT_MODEL_BASE_URL: 'https://llm.example/v1',
        OPSAGENT_MODEL_ID: 'qwen-prod',
        OPSAGENT_MODEL_API_KEY: 'selected-key',
      }),
    );
  });

  it('rejects approval decisions because headless dsh has no bridge', async () => {
    const runtime = new DshRuntime(runner([]));
    await expect(runtime.respondApproval('s', 'a', 'approve')).rejects.toThrow(
      'dsh_runtime_approval_not_supported',
    );
  });
});
