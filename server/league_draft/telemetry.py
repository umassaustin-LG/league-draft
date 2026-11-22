"""Privacy filtering shared by Sentry event, transaction and breadcrumb hooks."""

import re

SENSITIVE = re.compile(
    r"name|email|phone|address|player|roster|sibling|coach|parent|guardian|birth|dob|age|"
    r"school|score|evaluation|team|notes|password|token|csrf|cookie|authorization|secret", re.I
)
DROPPED = re.compile(r"^(data|body|request_body|cookies|headers|query_string|queryString|search)$", re.I)
EMAIL = re.compile(r"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}", re.I)
PHONE = re.compile(r"(?<!\w)\+?\d[\d ().-]{7,}\d(?!\w)")
URL_QUERY = re.compile(r"(https?://[^\s?#]+|/[^\s?#]*)[?#][^\s]*", re.I)


def scrub(value):
    if isinstance(value, str):
        return PHONE.sub('[REDACTED]', EMAIL.sub('[REDACTED]', URL_QUERY.sub(r'\1', value)))
    if isinstance(value, (list, tuple)):
        return [scrub(item) for item in value]
    if isinstance(value, dict):
        result = {}
        for key, item in value.items():
            if DROPPED.search(key):
                continue
            if key == 'user':
                user_id = item.get('id') if isinstance(item, dict) else None
                result[key] = {'id': scrub(user_id)} if isinstance(user_id, (str, int)) else {}
            else:
                result[key] = '[REDACTED]' if SENSITIVE.search(key) else scrub(item)
        return result
    return value


def before_send(event, hint):
    return scrub(event)
