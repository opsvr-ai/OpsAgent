import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonical(item));
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .filter((key) => record[key] !== undefined)
        .map((key) => [key, canonical(record[key])]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonical(value));
}

export class CommandSigner {
  readonly publicKey: string;
  private readonly privateKey: ReturnType<typeof createPrivateKey>;

  constructor(seed: Buffer) {
    if (seed.length !== 32) throw new Error('command signing seed must be 32 bytes');
    this.privateKey = createPrivateKey({
      key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
      format: 'der',
      type: 'pkcs8',
    });
    const spki = createPublicKey(this.privateKey).export({ format: 'der', type: 'spki' });
    this.publicKey = spki.subarray(spki.length - 32).toString('base64');
  }

  sign(payload: unknown): { signedPayload: string; signature: string } {
    const signedPayload = canonicalJson(payload);
    const signature = sign(null, Buffer.from(signedPayload, 'utf8'), this.privateKey).toString('base64');
    return { signedPayload, signature };
  }
}

let signer: CommandSigner | undefined;

export function getCommandSigner(): CommandSigner {
  if (!signer) {
    const material = process.env.OPSAGENT_COMMAND_SIGNING_SEED
      ?? process.env.OPSAGENT_SECRET_KEY
      ?? 'dev-only-secret';
    const seed = createHash('sha256').update(`opsagent-command:${material}`).digest();
    signer = new CommandSigner(seed);
  }
  return signer;
}
