"""
League management views (members, invitations, join links).
"""

import secrets
from datetime import timedelta

from django.conf import settings
from django.core.mail import send_mail
from django.utils import timezone
from django.views.decorators.csrf import csrf_protect
from django.views.decorators.http import require_http_methods

from ..models import Organization, OrganizationMembership, OrganizationInvitation
# Legacy aliases for this file
League = Organization
LeagueMembership = OrganizationMembership
LeagueInvitation = OrganizationInvitation
from ..transformers import transform_league_member, transform_invitation
from ..input_validators import (
    validate_invitation_data,
    validate_accept_invitation_data,
    validate_member_role_data,
)
from .helpers import (
    json_response,
    parse_json_body,
    require_auth,
    rate_limit,
    anon_rate_limiter,
)


def _get_league(league_id):
    """Get league by ID."""
    try:
        return League.objects.get(id=league_id), None
    except League.DoesNotExist:
        return None, json_response({"error": "League not found"}, status=404)


def _require_admin(request, league):
    """Check if user is admin of the league."""
    if not request.user.is_league_admin(league):
        return json_response(
            {"error": "Only league admins can perform this action"},
            status=403
        )
    return None


# -----------------------------------------------------------------------------
# League Member Management
# -----------------------------------------------------------------------------


@require_http_methods(["GET"])
@csrf_protect
@require_auth
def league_members_list(request, league_id):
    """List all members of a league."""
    league, error = _get_league(league_id)
    if error:
        return error

    # Verify user is a member
    if not LeagueMembership.objects.filter(user=request.user, organization=league).exists():
        return json_response(
            {"error": "You are not a member of this league"},
            status=403
        )

    memberships = LeagueMembership.objects.filter(organization=league).select_related("user")
    return json_response([transform_league_member(m) for m in memberships])


@require_http_methods(["DELETE"])
@csrf_protect
@require_auth
def league_member_remove(request, league_id, user_id):
    """Remove a member from the league."""
    league, error = _get_league(league_id)
    if error:
        return error

    error = _require_admin(request, league)
    if error:
        return error

    try:
        membership = LeagueMembership.objects.get(organization=league, user_id=user_id)
    except LeagueMembership.DoesNotExist:
        return json_response({"error": "Member not found"}, status=404)

    # Prevent removing self
    if membership.user == request.user:
        return json_response(
            {"error": "You cannot remove yourself from the league"},
            status=400
        )

    # Prevent removing last admin
    if membership.role == "admin":
        admin_count = LeagueMembership.objects.filter(organization=league, role="admin").count()
        if admin_count <= 1:
            return json_response(
                {"error": "Cannot remove the last admin"},
                status=400
            )

    membership.delete()
    return json_response({}, status=204)


@require_http_methods(["PATCH"])
@csrf_protect
@require_auth
def league_member_update_role(request, league_id, user_id):
    """Update a member's role."""
    league, error = _get_league(league_id)
    if error:
        return error

    error = _require_admin(request, league)
    if error:
        return error

    try:
        membership = LeagueMembership.objects.get(organization=league, user_id=user_id)
    except LeagueMembership.DoesNotExist:
        return json_response({"error": "Member not found"}, status=404)

    data, parse_error = parse_json_body(request)
    if parse_error:
        return json_response({"error": parse_error}, status=400)

    cleaned, errors = validate_member_role_data(data)
    if errors:
        return json_response(errors, status=400)

    new_role = cleaned["role"]

    # Prevent demoting self if last admin
    if membership.user == request.user and membership.role == "admin" and new_role != "admin":
        admin_count = LeagueMembership.objects.filter(organization=league, role="admin").count()
        if admin_count <= 1:
            return json_response(
                {"error": "Cannot demote yourself as the last admin"},
                status=400
            )

    membership.role = new_role
    membership.save()
    return json_response(transform_league_member(membership))


# -----------------------------------------------------------------------------
# League Invitations
# -----------------------------------------------------------------------------


@require_http_methods(["GET", "POST"])
@csrf_protect
@require_auth
def league_invitations_list_create(request, league_id):
    """List pending invitations or create a new one."""
    league, error = _get_league(league_id)
    if error:
        return error

    error = _require_admin(request, league)
    if error:
        return error

    if request.method == "GET":
        invitations = LeagueInvitation.objects.filter(
            organization=league,
            accepted_at__isnull=True,
            is_link_invite=False,
        ).select_related("invited_by")

        # Filter out expired
        invitations = [inv for inv in invitations if not inv.is_expired]

        return json_response([transform_invitation(i) for i in invitations])

    # POST - create invitation
    data, parse_error = parse_json_body(request)
    if parse_error:
        return json_response({"error": parse_error}, status=400)

    cleaned, errors = validate_invitation_data(data)
    if errors:
        return json_response(errors, status=400)

    email = cleaned["email"]
    role = cleaned["role"]

    # Check if already a member
    if LeagueMembership.objects.filter(organization=league, user__email__iexact=email).exists():
        return json_response(
            {"error": "This user is already a member of the league"},
            status=400
        )

    # Check for existing pending invitation
    existing = LeagueInvitation.objects.filter(
        organization=league,
        email__iexact=email,
        accepted_at__isnull=True,
    ).first()
    if existing and not existing.is_expired:
        return json_response(
            {"error": "An invitation has already been sent to this email"},
            status=400
        )

    # Create invitation
    token = secrets.token_urlsafe(32)
    invitation = LeagueInvitation.objects.create(
        organization=league,
        email=email,
        token=token,
        invited_by=request.user,
        role=role,
        is_link_invite=False,
        expires_at=timezone.now() + timedelta(days=7),
    )

    # Send invitation email
    frontend_url = getattr(settings, "FRONTEND_URL", "http://localhost:5173")
    invite_url = f"{frontend_url}/join?token={token}"

    subject = f"You're invited to join {league.name} - Little League Draft"
    message = f"""
Hello,

{request.user.first_name or request.user.email} has invited you to join {league.name} on Little League Draft.

Click the link below to accept the invitation:
{invite_url}

This invitation will expire in 7 days.

Thanks,
Little League Draft Team
"""
    try:
        send_mail(
            subject,
            message,
            settings.DEFAULT_FROM_EMAIL,
            [email],
            fail_silently=False,
        )
    except Exception:
        # Log but don't fail if email fails
        pass

    return json_response(transform_invitation(invitation), status=201)


@require_http_methods(["DELETE"])
@csrf_protect
@require_auth
def league_invitation_cancel(request, league_id, pk):
    """Cancel an invitation."""
    league, error = _get_league(league_id)
    if error:
        return error

    error = _require_admin(request, league)
    if error:
        return error

    try:
        invitation = LeagueInvitation.objects.get(id=pk, organization=league)
    except LeagueInvitation.DoesNotExist:
        return json_response({"error": "Invitation not found"}, status=404)

    invitation.delete()
    return json_response({}, status=204)


@require_http_methods(["POST"])
@csrf_protect
@require_auth
def accept_invitation(request):
    """Accept an invitation (email or link-based)."""
    data, parse_error = parse_json_body(request)
    if parse_error:
        return json_response({"error": parse_error}, status=400)

    cleaned, errors = validate_accept_invitation_data(data)
    if errors:
        return json_response(errors, status=400)

    token = cleaned["token"]

    # First check if it's a join link token
    league = League.objects.filter(
        join_link_token=token,
        join_link_enabled=True,
    ).first()

    if league:
        # Join via link
        if LeagueMembership.objects.filter(user=request.user, organization=league).exists():
            return json_response(
                {"error": "You are already a member of this league"},
                status=400
            )

        LeagueMembership.objects.create(
            user=request.user,
            organization=league,
            role="viewer",
        )
        return json_response({
            "message": "Successfully joined the league",
            "league_id": str(league.id),
            "league_name": league.name,
        })

    # Check email invitation
    try:
        invitation = LeagueInvitation.objects.get(
            token=token,
            accepted_at__isnull=True,
        )
    except LeagueInvitation.DoesNotExist:
        return json_response(
            {"error": "Invalid or expired invitation"},
            status=400
        )

    if invitation.is_expired:
        return json_response(
            {"error": "This invitation has expired"},
            status=400
        )

    # For email invites, check if email matches
    if invitation.email and invitation.email.lower() != request.user.email.lower():
        return json_response(
            {"error": "This invitation was sent to a different email address"},
            status=400
        )

    # Check if already a member
    if LeagueMembership.objects.filter(user=request.user, organization=invitation.organization).exists():
        invitation.accepted_at = timezone.now()
        invitation.save()
        return json_response(
            {"error": "You are already a member of this league"},
            status=400
        )

    # Create membership
    LeagueMembership.objects.create(
        user=request.user,
        organization=invitation.organization,
        role=invitation.role,
    )

    invitation.accepted_at = timezone.now()
    invitation.save()

    return json_response({
        "message": "Successfully joined the league",
        "league_id": str(invitation.organization.id),
        "league_name": invitation.organization.name,
    })


# -----------------------------------------------------------------------------
# Join Link Management
# -----------------------------------------------------------------------------


@require_http_methods(["GET", "POST", "DELETE"])
@csrf_protect
@require_auth
def join_link_view(request, league_id):
    """Manage league join link."""
    league, error = _get_league(league_id)
    if error:
        return error

    error = _require_admin(request, league)
    if error:
        return error

    frontend_url = getattr(settings, "FRONTEND_URL", "http://localhost:5173")

    if request.method == "GET":
        url = None
        if league.join_link_enabled and league.join_link_token:
            url = f"{frontend_url}/join/{league.join_link_token}"

        return json_response({
            "enabled": league.join_link_enabled,
            "token": league.join_link_token,
            "url": url,
        })

    if request.method == "POST":
        # Generate new token
        league.join_link_token = secrets.token_urlsafe(32)
        league.join_link_enabled = True
        league.save()

        url = f"{frontend_url}/join/{league.join_link_token}"

        return json_response({
            "enabled": True,
            "token": league.join_link_token,
            "url": url,
        })

    # DELETE
    league.join_link_enabled = False
    league.save()

    return json_response({
        "enabled": False,
        "token": league.join_link_token,
        "url": None,
    })


@require_http_methods(["GET"])
@rate_limit(anon_rate_limiter)
def public_join_link_view(request, token):
    """Public endpoint to get league info from join link or email invitation token."""
    # First, check if it's a join link token
    league = League.objects.filter(
        join_link_token=token,
        join_link_enabled=True,
    ).first()

    if league:
        return json_response({
            "league_name": league.name,
            "league_slug": league.slug,
            "type": "join_link",
        })

    # Check if it's an email invitation token
    invitation = LeagueInvitation.objects.filter(
        token=token,
        accepted_at__isnull=True,
    ).select_related("organization", "invited_by").first()

    if invitation and not invitation.is_expired:
        return json_response({
            "league_name": invitation.organization.name,
            "league_slug": invitation.organization.slug,
            "type": "email_invitation",
            "invited_by": invitation.invited_by.email if invitation.invited_by else None,
            "role": invitation.role,
        })

    return json_response(
        {"error": "Invalid or expired invitation link"},
        status=404
    )
