const REDACTED = '[REDACTED]';
const TRUNCATED = '[TRUNCATED]';
const MAX_DEPTH = 6;
const MAX_STRING = 1024;
const MAX_ARRAY = 50;
const SENSITIVE_KEY = /password|passwd|secret|token|authorization|cookie|api[_-]?key|private[_-]?key/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function redactMetadata(input: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return TRUNCATED;

  if (typeof input === 'string') {
    return input.length > MAX_STRING ? `${input.slice(0, MAX_STRING - 1)}…` : input;
  }

  if (Array.isArray(input)) {
    return input.slice(0, MAX_ARRAY).map((value) => redactMetadata(value, depth + 1));
  }

  if (!isRecord(input)) return input;

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (SENSITIVE_KEY.test(key)) {
      result[key] = REDACTED;
    } else {
      result[key] = redactMetadata(value, depth + 1);
    }
  }
  return result;
}
