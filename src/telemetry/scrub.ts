const sensitive = new Set(('name names email emails phone phones address addresses player players roster rosters sibling siblings coach coaches parent parents guardian guardians birth dob age ages school schools score scores evaluation evaluations team teams note notes password passwords token tokens csrf cookie cookies authorization secret secrets').split(' '));

function isSensitiveKey(key: string): boolean {
  return key.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase()
    .split(/[^a-z0-9]+/).some(word => sensitive.has(word));
}
const dropped = /^(data|body|request_body|cookies|headers|query_string|queryString|search)$/i;
const email = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const phone = /(?<!\w)\+?\d[\d ().-]{7,}\d(?!\w)/g;
const secretRoute = /^(join|join-link|reset|reset-password|password-reset|invite|invites|invitation|invitations|accept|token|confirm)$/i;
const secretSegment = /(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[A-Za-z0-9_-]{20,})/i;

function scrubUrlPaths(value: string): string {
  return value.replace(/https?:\/\/[^\s"'<>]+|\/[^\s"'<>]*/gi, url => {
    const origin = url.match(/^https?:\/\/[^/?#]+/i)?.[0] || '';
    let privatePath = false;
    const path = url.slice(origin.length).split(/[?#]/, 1)[0];
    return origin + path.split('/').map(segment => {
      let decoded = segment;
      try { decoded = decodeURIComponent(segment); } catch { /* Keep malformed URL segments. */ }
      const redact = privatePath || secretSegment.test(decoded);
      if (secretRoute.test(decoded)) privatePath = true;
      return segment && redact ? '[REDACTED]' : segment;
    }).join('/');
  });
}

export function scrubString(value: string): string {
  return scrubUrlPaths(value)
    .replace(email, '[REDACTED]').replace(phone, '[REDACTED]');
}

export function scrubStrings<T>(value: T): T {
  function visit(item: unknown, snapshot = false): unknown {
    if (typeof item === 'string') return scrubString(item);
    if (Array.isArray(item)) return item.map(entry => visit(entry, snapshot));
    if (!item || typeof item !== 'object') return item;
    const prototype = Object.getPrototypeOf(item);
    if (prototype !== Object.prototype && prototype !== null) return item;
    const record = item as Record<string, unknown>;
    if (snapshot && ('cv' in record || typeof record.data === 'string')) return item;
    return Object.fromEntries(Object.entries(record).map(([key, entry]) => [key, visit(entry, key === '$snapshot_data')]));
  }
  return visit(value) as T;
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
