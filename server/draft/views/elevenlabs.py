from django.views.decorators.cache import never_cache
from django.views.decorators.csrf import csrf_protect
from django.views.decorators.http import require_http_methods
from elevenlabs.core.api_error import ApiError
from httpx import HTTPError

from ..elevenlabs_client import get_elevenlabs_client
from .helpers import RateLimiter, json_response, rate_limit, require_auth


token_limiter = RateLimiter("elevenlabs_token", "10/minute")


@require_http_methods(["POST"])
@never_cache
@csrf_protect
@require_auth
@rate_limit(token_limiter)
def elevenlabs_token(request):
    client = get_elevenlabs_client()
    if client is None:
        return json_response({"error": "ElevenLabs is not configured"}, status=503)

    try:
        result = client.tokens.single_use.create(token_type="realtime_scribe")
    except (ApiError, HTTPError):
        return json_response({"error": "Unable to create ElevenLabs token"}, status=502)
    return json_response({"token": result.token})
