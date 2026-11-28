"""
Division views (replaces DRF DivisionViewSet).
"""

from django.db import models
from django.db.models import Q
from django.utils import timezone
from django.views.decorators.csrf import csrf_protect
from django.views.decorators.http import require_http_methods

from ..models import Division, Team
from ..transformers import transform_division, transform_division_summary
from ..input_validators import validate_division_create_data, validate_division_update_data
from .helpers import (
    json_response,
    parse_json_body,
    require_auth,
    get_organization_from_request,
)


# Default scoring weights
DEFAULT_SCORING_WEIGHTS = {
    "fielding": {"field": 15.0, "throw": 13.0},
    "hitting": {"power": 9.0, "form": 9.0, "contact": 9.0},
    "pitching": {"strength": 20.0, "form": 15.0},
    "catching": 5.0,
    "running": 5.0,
}


@require_http_methods(["GET", "POST"])
@csrf_protect
@require_auth
def divisions_list_create(request):
    """List divisions or create a new one."""
    organization = get_organization_from_request(request)

    if request.method == "GET":
        # List divisions - include org divisions and personal divisions
        if request.user.role == "master_admin":
            divisions = Division.objects.all()
        else:
            # User sees: org divisions (if in an org) + their personal divisions
            if organization:
                divisions = Division.objects.filter(
                    Q(organization=organization) | Q(owner=request.user)
                )
            else:
                # No org selected - show only personal divisions
                divisions = Division.objects.filter(owner=request.user)

        return json_response([transform_division_summary(d) for d in divisions])

    # POST - create division
    data, parse_error = parse_json_body(request)
    if parse_error:
        return json_response({"error": parse_error}, status=400)

    cleaned, errors = validate_division_create_data(data)
    if errors:
        return json_response(errors, status=400)

    age_range = cleaned.pop("age_range")
    scoring_weights = cleaned.pop("scoring_weights", None) or DEFAULT_SCORING_WEIGHTS
    team_count = cleaned["team_count"]
    coaches = cleaned.pop("coaches", None) or []

    # Determine if this is an org division or personal division
    # If user has an org selected AND is admin, create org division
    # Otherwise, create personal division
    is_org_division = organization and request.user.is_org_admin(organization)

    # Clean up any empty divisions with the same name
    name = cleaned.get("name")
    if name:
        if is_org_division:
            empty_divisions = Division.objects.filter(
                organization=organization,
                name__iexact=name,
            ).annotate(
                player_count=models.Count("players")
            ).filter(player_count=0)
        else:
            empty_divisions = Division.objects.filter(
                owner=request.user,
                organization__isnull=True,
                name__iexact=name,
            ).annotate(
                player_count=models.Count("players")
            ).filter(player_count=0)
        empty_divisions.delete()

    # Create division
    if is_org_division:
        division = Division.objects.create(
            organization=organization,
            owner=None,
            age_range_min=age_range["min"],
            age_range_max=age_range["max"],
            scoring_weights=scoring_weights,
            **cleaned,
        )
    else:
        # Personal division
        division = Division.objects.create(
            organization=None,
            owner=request.user,
            age_range_min=age_range["min"],
            age_range_max=age_range["max"],
            scoring_weights=scoring_weights,
            **cleaned,
        )

    # Create teams with optional coach info
    for i in range(team_count):
        coach_info = coaches[i] if i < len(coaches) else {}
        head_coach = coach_info.get("head_coach", "") or coach_info.get("headCoach", "")
        assistant_coach = coach_info.get("assistant_coach", "") or coach_info.get("assistantCoach", "")
        team_name = coach_info.get("team_name", "") or coach_info.get("teamName", "")
        Team.objects.create(
            division=division,
            name=team_name or head_coach,  # Team name defaults to head coach name if not provided
            head_coach=head_coach,
            assistant_coach=assistant_coach,
            draft_position=i + 1,
        )

    return json_response(transform_division(division, include_all=True), status=201)


@require_http_methods(["GET", "PUT", "PATCH", "DELETE"])
@csrf_protect
@require_auth
def division_detail(request, pk):
    """Retrieve, update, or delete a division."""
    organization = get_organization_from_request(request)

    # Get division with access control
    try:
        if request.user.role == "master_admin":
            division = Division.objects.get(id=pk)
        else:
            # User can access: org divisions (if member) or their own personal divisions
            if organization:
                division = Division.objects.get(
                    Q(id=pk) & (Q(organization=organization) | Q(owner=request.user))
                )
            else:
                division = Division.objects.get(id=pk, owner=request.user)
    except Division.DoesNotExist:
        return json_response({"error": "Not found"}, status=404)

    if request.method == "GET":
        include = request.GET.get("include")
        if include == "all":
            return json_response(transform_division(division, include_all=True))
        return json_response(transform_division_summary(division))

    if request.method == "DELETE":
        # Only owner or org admin can delete
        can_delete = (
            request.user.role == "master_admin" or
            division.owner == request.user or
            (division.organization and request.user.is_org_admin(division.organization))
        )
        if not can_delete:
            return json_response({"error": "Permission denied"}, status=403)
        division.delete()
        return json_response({}, status=204)

    # PUT or PATCH - update
    data, parse_error = parse_json_body(request)
    if parse_error:
        return json_response({"error": parse_error}, status=400)

    # Check permissions for updates
    can_update = (
        request.user.role == "master_admin" or
        division.owner == request.user or
        (division.organization and request.user.is_org_admin(division.organization))
    )
    if not can_update:
        return json_response({"error": "Permission denied"}, status=403)

    # Protect division during/after draft - only allow phase changes
    if division.phase in ("draft", "complete"):
        allowed_fields = {"phase"}
        if division.mode == "league-generated":
            allowed_fields.add("team_builder_settings")
        requested_fields = set(data.keys())
        if not requested_fields.issubset(allowed_fields):
            return json_response(
                {"error": "Cannot modify division during or after draft. Only phase changes allowed. Use Reset Draft to start over."},
                status=400
            )

    cleaned, errors = validate_division_update_data(data)
    if errors:
        return json_response(errors, status=400)

    # Apply updates
    for attr, value in cleaned.items():
        setattr(division, attr, value)

    if cleaned.get("phase") == "complete":
        division.completed_at = timezone.now()

    division.save()

    return json_response(transform_division(division, include_all=True))


@require_http_methods(["POST"])
@csrf_protect
@require_auth
def division_reset(request, pk):
    """Reset a division's draft state - owner or admin only."""
    organization = get_organization_from_request(request)

    # Get division with access control
    try:
        if request.user.role == "master_admin":
            division = Division.objects.get(id=pk)
        else:
            if organization:
                division = Division.objects.get(
                    Q(id=pk) & (Q(organization=organization) | Q(owner=request.user))
                )
            else:
                division = Division.objects.get(id=pk, owner=request.user)
    except Division.DoesNotExist:
        return json_response({"error": "Not found"}, status=404)

    # Verify user can reset this division
    can_reset = (
        request.user.role == "master_admin" or
        division.owner == request.user or
        (division.organization and request.user.is_org_admin(division.organization))
    )
    if not can_reset:
        return json_response(
            {"error": "Only division owner or organization admin can reset drafts"},
            status=403
        )

    # Delete draft state if exists
    if hasattr(division, "draft_state"):
        division.draft_state.delete()

    # Reset all players
    division.players.update(
        is_drafted=False,
        drafted_by_team=None,
        drafted_in_round=None,
        drafted_at_pick=None,
        locked_to_round=None,
        locked_to_team=None,
    )

    # Reset all teams
    division.teams.update(total_score=0, age_breakdown={})

    # Update phase
    division.phase = "config"
    division.completed_at = None
    division.save()

    # Refresh from database to clear cached draft_state reference
    division.refresh_from_db()

    return json_response(transform_division(division, include_all=True))
