"""
Shared utilities for plain Django views.
"""

import json
import uuid
from functools import wraps
from typing import Any, Optional, Tuple

from django.core.cache import cache
from django.http import JsonResponse


def json_response(data: Any, status: int = 200) -> JsonResponse:
    """Create a JSON response with proper headers."""
    return JsonResponse(data, status=status, safe=False)


def parse_json_body(request) -> Tuple[Optional[dict], Optional[str]]:
    """
    Parse JSON from request body.
    Returns (data, None) on success, (None, error_message) on failure.
    """
    if not request.body:
        return {}, None
    try:
        data = json.loads(request.body)
        return data, None
    except json.JSONDecodeError as e:
        return None, f"Invalid JSON: {str(e)}"


def validate_uuid(value: Any, field_name: str = "id") -> Tuple[Optional[uuid.UUID], Optional[str]]:
    """
    Validate a UUID value.
    Returns (uuid, None) on success, (None, error_message) on failure.
    """
    if value is None:
        return None, f"{field_name} is required"
    try:
        if isinstance(value, uuid.UUID):
            return value, None
        return uuid.UUID(str(value)), None
    except (ValueError, AttributeError):
        return None, f"Invalid {field_name}"


def require_auth(view_func):
    """Decorator that requires authentication."""
    @wraps(view_func)
    def wrapper(request, *args, **kwargs):
        if not request.user.is_authenticated:
            return json_response({"error": "Authentication required"}, status=401)
        return view_func(request, *args, **kwargs)
    return wrapper


def require_org_admin(view_func):
    """Decorator that requires organization admin role."""
    @wraps(view_func)
    def wrapper(request, *args, **kwargs):
        if not request.user.is_authenticated:
            return json_response({"error": "Authentication required"}, status=401)

        # Master admin can do anything
        if request.user.role == "master_admin":
            return view_func(request, *args, **kwargs)

        # Check if user has organization context and is admin
        organization = getattr(request, "organization", None)
        if not organization:
            return json_response({"error": "No organization context"}, status=400)

        if not request.user.is_org_admin(organization):
            return json_response({"error": "Only organization admins can perform this action"}, status=403)

        return view_func(request, *args, **kwargs)
    return wrapper


# Alias for backwards compatibility
require_league_admin = require_org_admin


def can_manage_division(user, division) -> bool:
    """Owner of a personal division, admin of the division's own organization, or master admin."""
    if user.role == "master_admin":
        return True
    if division.owner_id is not None and division.owner_id == user.id:
        return True
    return bool(division.organization_id and user.is_org_admin(division.organization))


def require_division_admin(request, division) -> Optional[JsonResponse]:
    """Return a 403 response unless the user can manage the division, else None."""
    if can_manage_division(request.user, division):
        return None
    return json_response({"error": "Only organization admins can perform this action"}, status=403)


def require_organization_admin(request, organization) -> Optional[JsonResponse]:
    """Return a 403 response unless the user is admin of the given organization, else None."""
    if request.user.role == "master_admin":
        return None
    if organization and request.user.is_org_admin(organization):
        return None
    return json_response({"error": "Only organization admins can perform this action"}, status=403)


def get_organization_from_request(request):
    """Get the organization from the request (set by TenantMiddleware)."""
    return getattr(request, "organization", None)


# Alias for backwards compatibility
def get_league_from_request(request):
    """Get the league from the request (set by TenantMiddleware)."""
    return get_organization_from_request(request)


def get_client_ip(request) -> str:
    """Get the client IP address from the request."""
    x_forwarded_for = request.META.get("HTTP_X_FORWARDED_FOR")
    if x_forwarded_for:
        ip = x_forwarded_for.split(",")[0].strip()
    else:
        ip = request.META.get("REMOTE_ADDR", "")
    return ip


class RateLimiter:
    """Simple rate limiter using Django's cache."""

    def __init__(self, scope: str, rate: str):
        """
        Initialize rate limiter.

        Args:
            scope: Identifier for this rate limit (e.g., "auth", "password_reset")
            rate: Rate limit in format "number/period" (e.g., "5/minute", "3/hour")
        """
        self.scope = scope
        self.num_requests, self.duration = self._parse_rate(rate)

    def _parse_rate(self, rate: str) -> Tuple[int, int]:
        """Parse rate string into (num_requests, seconds)."""
        num, period = rate.split("/")
        num_requests = int(num)
        duration_map = {
            "second": 1,
            "minute": 60,
            "hour": 3600,
            "day": 86400,
        }
        duration = duration_map.get(period, 60)
        return num_requests, duration

    def is_allowed(self, identifier: str) -> Tuple[bool, Optional[int]]:
        """
        Check if the request is allowed.

        Returns:
            (allowed, retry_after) - if not allowed, retry_after is seconds to wait
        """
        cache_key = f"ratelimit:{self.scope}:{identifier}"
        history = cache.get(cache_key, [])

        import time
        now = time.time()

        # Remove old entries
        history = [t for t in history if t > now - self.duration]

        if len(history) >= self.num_requests:
            # Calculate when the oldest request will expire
            retry_after = int(history[0] + self.duration - now) + 1
            return False, retry_after

        # Add current request
        history.append(now)
        cache.set(cache_key, history, self.duration)
        return True, None


# Pre-configured rate limiters
auth_rate_limiter = RateLimiter("auth", "5/minute")
password_reset_rate_limiter = RateLimiter("password_reset", "3/hour")
anon_rate_limiter = RateLimiter("anon", "100/hour")


def rate_limit(limiter: RateLimiter):
    """Decorator to apply rate limiting."""
    def decorator(view_func):
        @wraps(view_func)
        def wrapper(request, *args, **kwargs):
            identifier = get_client_ip(request)
            allowed, retry_after = limiter.is_allowed(identifier)
            if not allowed:
                response = json_response(
                    {"error": "Too many requests. Please try again later."},
                    status=429
                )
                response["Retry-After"] = str(retry_after)
                return response
            return view_func(request, *args, **kwargs)
        return wrapper
    return decorator
