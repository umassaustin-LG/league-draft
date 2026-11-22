import json

from django.conf import settings
from django.http import HttpResponse
from django.views.decorators.cache import never_cache
from django.views.decorators.csrf import csrf_protect
from django.views.decorators.http import require_http_methods
from elevenlabs.core.api_error import ApiError
from httpx import HTTPError

from ..elevenlabs_client import get_elevenlabs_client
from .helpers import RateLimiter, json_response, rate_limit, require_auth, require_org_admin


token_limiter = RateLimiter("elevenlabs_token", "10/minute")
speech_limiter = RateLimiter("elevenlabs_speech", "30/minute")


def _can_announce(request):
    user = request.user
    if not user.is_authenticated:
        return False
    if user.role == "master_admin":
        return True
    organization = getattr(request, "organization", None) or getattr(request, "league", None)
    if organization is not None:
        return bool(user.is_org_admin(organization))
    return user.memberships.filter(role="admin").exists()


@require_http_methods(["GET"])
@never_cache
def elevenlabs_status(request):
    return json_response({"enabled": bool(settings.ELEVENLABS_API_KEY) and _can_announce(request)})


@require_http_methods(["POST"])
@never_cache
@csrf_protect
@require_auth
@rate_limit(speech_limiter)
def elevenlabs_speak(request):
    if not _can_announce(request):
        return json_response({"error": "League admin required"}, status=403)
    client = get_elevenlabs_client()
    if client is None:
        return json_response({"error": "Announcer unavailable"}, status=503)
    try:
        data = json.loads(request.body)
    except (ValueError, UnicodeDecodeError):
        return json_response({"error": "Invalid request"}, status=400)
    text = data.get("text") if isinstance(data, dict) else None
    if not isinstance(text, str) or not text.strip() or len(text) > 200:
        return json_response({"error": "Text must contain 1 to 200 characters"}, status=400)
    try:
        audio = b"".join(client.text_to_speech.convert(
            voice_id=settings.ELEVENLABS_VOICE_ID,
            text=text,
            model_id="eleven_flash_v2_5",
            output_format="mp3_44100_128",
            request_options={"max_retries": 0},
        ))
    except (ApiError, HTTPError):
        return json_response({"error": "Announcer unavailable"}, status=502)
    return HttpResponse(audio, content_type="audio/mpeg")


@require_http_methods(["POST"])
@never_cache
@csrf_protect
@require_org_admin
@rate_limit(token_limiter)
def elevenlabs_token(request):
    client = get_elevenlabs_client()
    if client is None:
        return json_response({"error": "ElevenLabs is not configured"}, status=503)

    try:
        result = client.tokens.single_use.create(
            token_type="realtime_scribe", request_options={"max_retries": 0}
        )
    except (ApiError, HTTPError):
        return json_response({"error": "Unable to create ElevenLabs token"}, status=502)
    return json_response({"token": result.token})
