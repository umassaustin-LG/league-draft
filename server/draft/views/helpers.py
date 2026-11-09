"""
Shared utilities for plain Django views.
"""

import hashlib
import ipaddress
import json
import time
import uuid
from datetime import datetime, timezone as dt_timezone
from functools import wraps
from typing import Any, Optional, Tuple

from django.conf import settings
from django.db.models import F
from django.http import JsonResponse

from ..models import RateLimitCounter


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


def _parse_ip(value: str) -> Optional[str]:
    try:
        return str(ipaddress.ip_address(value.strip()))
    except ValueError:
        return None


def get_client_ip(request) -> str:
    """
    Get the client IP address from the request.

    X-Forwarded-For is client-controlled, so it is only consulted when
    NUM_TRUSTED_PROXIES > 0, and then only the entry appended by the outermost
    trusted proxy is used. Otherwise REMOTE_ADDR is used.
    """
    remote_addr = request.META.get("REMOTE_ADDR", "")
    num_proxies = getattr(settings, "NUM_TRUSTED_PROXIES", 0)
    if num_proxies > 0:
        forwarded = [
            part.strip()
            for part in request.META.get("HTTP_X_FORWARDED_FOR", "").split(",")
            if part.strip()
        ]
        if len(forwarded) >= num_proxies:
            ip = _parse_ip(forwarded[-num_proxies])
            if ip:
                return ip
    return remote_addr


class RateLimiter:
    """Fixed-window rate limiter backed by a database table shared across processes."""

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

    def _window(self, identifier: str) -> Tuple[str, datetime, int]:
        now = time.time()
        window_index = int(now // self.duration)
        window_end = (window_index + 1) * self.duration
        raw_key = f"{self.scope}:{identifier}:{window_index}"
        key = hashlib.sha256(raw_key.encode()).hexdigest()
        expires_at = datetime.fromtimestamp(window_end, tz=dt_timezone.utc)
        retry_after = max(1, int(window_end - now) + 1)
        return key, expires_at, retry_after

    def is_blocked(self, identifier: str) -> Tuple[bool, Optional[int]]:
        """Check whether the limit is already exhausted, without counting a request."""
        key, _, retry_after = self._window(identifier)
        count = (
            RateLimitCounter.objects.filter(key=key)
            .values_list("count", flat=True)
            .first()
        ) or 0
        if count >= self.num_requests:
            return True, retry_after
        return False, None

    def hit(self, identifier: str) -> Tuple[bool, Optional[int]]:
        """
        Atomically count a request and check whether it is allowed.

        Returns:
            (allowed, retry_after) - if not allowed, retry_after is seconds to wait
        """
        key, expires_at, retry_after = self._window(identifier)
        counter, created = RateLimitCounter.objects.get_or_create(
            key=key, defaults={"count": 1, "expires_at": expires_at}
        )
        if created:
            RateLimitCounter.objects.filter(
                expires_at__lt=datetime.fromtimestamp(time.time(), tz=dt_timezone.utc)
            ).delete()
            count = 1
        else:
            RateLimitCounter.objects.filter(pk=key).update(count=F("count") + 1)
            count = (
                RateLimitCounter.objects.filter(pk=key)
                .values_list("count", flat=True)
                .first()
            ) or 1

        if count > self.num_requests:
            return False, retry_after
        return True, None

    is_allowed = hit


# Pre-configured rate limiters
auth_rate_limiter = RateLimiter("auth", "5/minute")
password_reset_rate_limiter = RateLimiter("password_reset", "3/hour")
anon_rate_limiter = RateLimiter("anon", "100/hour")
# Per-account limiters, keyed by normalized email, so rotating source IPs doesn't help
login_failure_rate_limiter = RateLimiter("login_failure", "10/hour")
password_reset_email_rate_limiter = RateLimiter("password_reset_email", "3/hour")


def account_identifier(email: str) -> str:
    """Normalize an email address for use as a per-account rate limit identifier."""
    return (email or "").strip().lower()


def rate_limited_response(retry_after: Optional[int]) -> JsonResponse:
    response = json_response(
        {"error": "Too many requests. Please try again later."},
        status=429
    )
    response["Retry-After"] = str(retry_after)
    return response


def rate_limit(limiter: RateLimiter):
    """Decorator to apply rate limiting."""
    def decorator(view_func):
        @wraps(view_func)
        def wrapper(request, *args, **kwargs):
            identifier = get_client_ip(request)
            allowed, retry_after = limiter.hit(identifier)
            if not allowed:
                return rate_limited_response(retry_after)
            return view_func(request, *args, **kwargs)
        return wrapper
    return decorator
