const SENSITIVE = /^(password|passwd|secret|token|apiKey|privateKey|connectionString)$/i;

export function redactConfig(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (SENSITIVE.test(key)) {
      result[key] = '[redacted]';
    } else if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
      result[key] = redactConfig(item as Readonly<Record<string, unknown>>);
    } else {
      result[key] = item;
    }
  }
  return result;
}
