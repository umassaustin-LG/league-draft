from django.views.decorators.cache import never_cache
from django.views.decorators.csrf import csrf_protect
from django.views.decorators.http import require_http_methods
from elevenlabs.core.api_error import ApiError
from httpx import HTTPError

from ..elevenlabs_client import get_elevenlabs_client
from ..models import Division
from .helpers import RateLimiter, can_manage_division, json_response, rate_limit, require_auth


voice_copilot_token_limiter = RateLimiter("voice_copilot_token", "10/minute")


@require_http_methods(["POST"])
@never_cache
@csrf_protect
@require_auth
@rate_limit(voice_copilot_token_limiter)
def voice_copilot_token(request, pk):
    """Issue a speech-to-text token for the voice copilot to users who can manage the division."""
    division = Division.objects.select_related("organization").filter(id=pk).first()
    if division is None:
        return json_response({"error": "Not found"}, status=404)
    if not can_manage_division(request.user, division):
        if division.organization_id and request.user.get_membership(division.organization):
            return json_response({"error": "Only league admins can use the voice copilot"}, status=403)
        return json_response({"error": "Not found"}, status=404)

    client = get_elevenlabs_client()
    if client is None:
        return json_response({"error": "ElevenLabs is not configured"}, status=503)
    try:
        result = client.tokens.single_use.create(token_type="realtime_scribe")
    except (ApiError, HTTPError):
        return json_response({"error": "Unable to create ElevenLabs token"}, status=502)
    return json_response({"token": result.token})
