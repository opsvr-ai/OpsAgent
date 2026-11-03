import { describe, expect, it, vi } from 'vitest';
import { DshHeadlessGenerator, type HeadlessRunner } from '../src/studio/dsh-generator.js';

describe('DshHeadlessGenerator', () => {
  it('parses a fenced JSON bundle', async () => {
    const runner: HeadlessRunner = {
      run: vi.fn().mockResolvedValue(
        '```json\n{"files":["cordis.patch.yml"],"manifest":{"risk":"R0"}}\n```',
      ),
    };
    const generator = new DshHeadlessGenerator(runner);
    const bundle = await generator.generate({ goal: 'connect cmdb', platform: 'blueking' });
    expect(bundle).toMatchObject({
      goal: 'connect cmdb',
      files: ['cordis.patch.yml'],
      manifest: { risk: 'R0' },
    });
  });

  it('rejects output without a valid bundle', async () => {
    const runner: HeadlessRunner = { run: vi.fn().mockResolvedValue('not json') };
    const generator = new DshHeadlessGenerator(runner);
    await expect(
      generator.generate({ goal: 'x', platform: 'dsh' }),
    ).rejects.toThrow('dsh_bundle_not_json');
  });

  it('rejects a bundle without files', async () => {
    const runner: HeadlessRunner = {
      run: vi.fn().mockResolvedValue('{"manifest":{}}'),
    };
    const generator = new DshHeadlessGenerator(runner);
    await expect(
      generator.generate({ goal: 'x', platform: 'dsh' }),
    ).rejects.toThrow('dsh_bundle_invalid');
  });
});
