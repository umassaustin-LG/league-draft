const sensitive = new Set(('name names email emails phone phones address addresses player players roster rosters sibling siblings coach coaches parent parents guardian guardians birth dob age ages school schools score scores evaluation evaluations team teams note notes password passwords token tokens csrf cookie cookies authorization secret secrets').split(' '));

function isSensitiveKey(key: string): boolean {
  return key.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase()
    .split(/[^a-z0-9]+/).some(word => sensitive.has(word));
}
const dropped = /^(data|body|request_body|cookies|headers|query_string|queryString|search)$/i;
const email = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const phone = /(?<!\w)\+?\d[\d ().-]{7,}\d(?!\w)/g;

export function scrubString(value: string): string {
  return value.replace(/(https?:\/\/[^\s?#]+|\/[^\s?#]*)[?#][^\s]*/gi, '$1')
    .replace(email, '[REDACTED]').replace(phone, '[REDACTED]');
}

export function scrub<T>(value: T, posthog = false): T {
  const seen = new WeakSet<object>();
  function visit(item: unknown): unknown {
    if (typeof item === 'string') return scrubString(item);
    if (!item || typeof item !== 'object') return item;
    if (seen.has(item)) return '[Circular]';
    seen.add(item);
    if (Array.isArray(item)) return item.map(visit);
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(item)) {
      if (dropped.test(key)) continue;
      if (key === 'user') {
        const id = (entry as { id?: unknown } | null)?.id;
        result[key] = typeof id === 'string' || typeof id === 'number' ? { id: visit(id) } : {};
      } else {
        const systemProperty = posthog && (key === 'token' || key === 'distinct_id' || key.startsWith('$'));
        result[key] = !systemProperty && isSensitiveKey(key) ? '[REDACTED]' : visit(entry);
      }
    }
    return result;
  }
  return visit(value) as T;
}
