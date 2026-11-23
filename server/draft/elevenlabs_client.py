from django.conf import settings
from elevenlabs.client import ElevenLabs


def get_elevenlabs_client():
    if not settings.ELEVENLABS_API_KEY:
        return None
    return ElevenLabs(api_key=settings.ELEVENLABS_API_KEY, timeout=15)
