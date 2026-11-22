const sensitive = /name|email|phone|address|player|roster|sibling|coach|parent|guardian|birth|dob|age|school|score|evaluation|team|notes|password|token|csrf|cookie|authorization|secret/i;
const dropped = /^(data|body|request_body|cookies|headers|query_string|queryString|search)$/i;
const email = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const phone = /(?<!\w)\+?\d[\d ().-]{7,}\d(?!\w)/g;

export function scrubString(value: string): string {
  return value.replace(/(https?:\/\/[^\s?#]+|\/[^\s?#]*)[?#][^\s]*/gi, '$1')
    .replace(email, '[REDACTED]').replace(phone, '[REDACTED]');
}

export function scrub<T>(value: T): T {
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
        result[key] = sensitive.test(key) ? '[REDACTED]' : visit(entry);
      }
    }
    return result;
  }
  return visit(value) as T;
}
