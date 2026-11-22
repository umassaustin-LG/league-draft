import json
import os
from urllib.request import Request, urlopen

from django.http import HttpResponse
from django.views.decorators.csrf import csrf_protect
from django.views.decorators.http import require_http_methods

from ..models import OrganizationMembership
from .helpers import RateLimiter, json_response, rate_limit, require_auth


@require_http_methods(["GET"])
def announcer_status(request):
    return json_response({"enabled": bool(os.environ.get("ELEVENLABS_API_KEY"))})


@require_http_methods(["POST"])
@csrf_protect
@require_auth
@rate_limit(RateLimiter("announcer", "30/minute"))
def announcer_speak(request):
    if not OrganizationMembership.objects.filter(user=request.user).exists():
        return json_response({"error": "League membership required"}, status=403)
    api_key = os.environ.get("ELEVENLABS_API_KEY")
    if not api_key:
        return json_response({"error": "Announcer unavailable"}, status=503)
    try:
        data = json.loads(request.body)
    except (ValueError, UnicodeDecodeError):
        return json_response({"error": "Invalid request"}, status=400)
    text = data.get("text") if isinstance(data, dict) else None
    if not isinstance(text, str) or not text.strip() or len(text) > 200:
        return json_response({"error": "Text must contain 1 to 200 characters"}, status=400)
    voice = os.environ.get("ELEVENLABS_VOICE_ID") or "JBFqnCBsd6RMkjVDRZzb"
    upstream = Request(
        f"https://api.elevenlabs.io/v1/text-to-speech/{voice}",
        data=json.dumps({"text": text, "model_id": "eleven_flash_v2_5"}).encode(),
        headers={"xi-api-key": api_key, "Content-Type": "application/json", "Accept": "audio/mpeg"},
        method="POST",
    )
    try:
        with urlopen(upstream, timeout=20) as response:
            audio = response.read()
    except Exception:
        return json_response({"error": "Announcer unavailable"}, status=502)
    result = HttpResponse(audio, content_type="audio/mpeg")
    result["Cache-Control"] = "no-store"
    return result
