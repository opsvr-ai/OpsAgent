import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import type { StudioBundle, StudioGenerator } from './service.js';

export interface HeadlessRunner {
  run(prompt: string): Promise<string>;
}

export interface HeadlessRunnerOptions {
  readonly command?: string;
  readonly timeoutMs?: number;
  readonly cwd?: string;
}

export class DshHeadlessRunner implements HeadlessRunner {
  private readonly command: string;
  private readonly timeoutMs: number;
  private readonly cwd: string;

  constructor(options: HeadlessRunnerOptions = {}) {
    this.command = options.command ?? process.env.DSH_HEADLESS_COMMAND ?? 'dsh';
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.cwd = options.cwd ?? tmpdir();
  }

  run(prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child =
        process.platform === 'win32'
          ? spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `${this.command} headless -`], {
              cwd: this.cwd,
              windowsHide: true,
              stdio: ['pipe', 'pipe', 'pipe'],
            })
          : spawn(this.command, ['headless', '-'], {
              cwd: this.cwd,
              windowsHide: true,
              stdio: ['pipe', 'pipe', 'pipe'],
            });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('dsh_headless_timeout'));
      }, this.timeoutMs);
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(new Error(`dsh_headless_failed:${code}:${stderr.slice(0, 500)}`));
          return;
        }
        resolve(stdout);
      });
      child.stdin.write(prompt);
      child.stdin.end();
    });
  }
}

function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = (fenced?.[1] ?? text).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('dsh_bundle_not_json');
  return JSON.parse(candidate.slice(start, end + 1)) as unknown;
}

export class DshHeadlessGenerator implements StudioGenerator {
  constructor(private readonly runner: HeadlessRunner = new DshHeadlessRunner()) {}

  async generate(input: { goal: string; platform: string }): Promise<StudioBundle> {
    const prompt = [
      'You are generating an OpsAgent connector bundle.',
      'Return ONLY JSON: {"files":["..."],"manifest":{}}.',
      'Do not use tools. Do not create or modify any files. No prose, no markdown.',
      `Platform: ${input.platform}`,
      `Goal: ${input.goal}`,
    ].join('\n');
    const output = await this.runner.run(prompt);
    const parsed = extractJson(output) as { files?: unknown; manifest?: unknown };
    if (
      !Array.isArray(parsed.files) ||
      !parsed.files.every((file) => typeof file === 'string') ||
      typeof parsed.manifest !== 'object' ||
      parsed.manifest === null
    ) {
      throw new Error('dsh_bundle_invalid');
    }
    return {
      goal: input.goal,
      files: parsed.files,
      manifest: parsed.manifest as Readonly<Record<string, unknown>>,
    };
  }
}
