"""Privacy filtering shared by Sentry event, transaction and breadcrumb hooks."""

import re

SENSITIVE = set((
    'name names email emails phone phones address addresses player players roster rosters '
    'sibling siblings coach coaches parent parents guardian guardians birth dob age ages '
    'school schools score scores evaluation evaluations team teams note notes password passwords '
    'token tokens csrf cookie cookies authorization secret secrets'
).split())
DROPPED = re.compile(r"^(data|body|request_body|cookies|headers|query_string|queryString|search)$", re.I)
EMAIL = re.compile(r"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}", re.I)
PHONE = re.compile(r"(?<!\w)\+?\d[\d ().-]{7,}\d(?!\w)")
URL_QUERY = re.compile(r"(https?://[^\s?#]+|/[^\s?#]*)[?#][^\s]*", re.I)


def is_sensitive_key(key):
    words = re.sub(r'([A-Z]+)([A-Z][a-z])', r'\1 \2', key)
    words = re.sub(r'([a-z0-9])([A-Z])', r'\1 \2', words).lower()
    return any(word in SENSITIVE for word in re.split(r'[^a-z0-9]+', words))


def scrub(value, posthog=False):
    if isinstance(value, str):
        return PHONE.sub('[REDACTED]', EMAIL.sub('[REDACTED]', URL_QUERY.sub(r'\1', value)))
    if isinstance(value, (list, tuple)):
        return [scrub(item, posthog) for item in value]
    if isinstance(value, dict):
        result = {}
        for key, item in value.items():
            if DROPPED.search(key):
                continue
            if key == 'user':
                user_id = item.get('id') if isinstance(item, dict) else None
                result[key] = {'id': scrub(user_id, posthog)} if isinstance(user_id, (str, int)) else {}
            else:
                system_property = posthog and (key in ('token', 'distinct_id') or key.startswith('$'))
                result[key] = '[REDACTED]' if not system_property and is_sensitive_key(key) else scrub(item, posthog)
        return result
    return value


def before_send(event, hint):
    return scrub(event)
