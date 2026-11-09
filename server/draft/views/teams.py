"""
Team views (replaces DRF TeamViewSet).
"""

from django.core.exceptions import ValidationError
from django.views.decorators.csrf import csrf_protect
from django.views.decorators.http import require_http_methods

from ..models import Division, Team, Player
from ..transformers import transform_team
from ..input_validators import validate_team_update_data
from .helpers import (
    json_response,
    parse_json_body,
    require_auth,
    require_division_admin,
    get_organization_from_request,
)


@require_http_methods(["GET", "POST"])
@csrf_protect
@require_auth
def teams_list_create(request):
    """List teams or create a new one."""
    organization = get_organization_from_request(request)

    if request.method == "GET":
        # Get teams, optionally filtered by division
        division_id = request.GET.get("division_id")
        queryset = Team.objects.all()

        if division_id:
            queryset = queryset.filter(division_id=division_id)

        # Apply organization filtering for non-master-admins
        if request.user.role != "master_admin" and organization:
            queryset = queryset.filter(division__organization=organization)
        elif request.user.role != "master_admin":
            queryset = Team.objects.none()

        return json_response([transform_team(t) for t in queryset])

    # POST - create team
    data, parse_error = parse_json_body(request)
    if parse_error:
        return json_response({"error": parse_error}, status=400)

    division_id = data.get("division_id")
    if not division_id:
        return json_response({"error": "division_id is required"}, status=400)

    try:
        if request.user.role == "master_admin":
            division = Division.objects.get(id=division_id)
        elif organization:
            division = Division.objects.get(id=division_id, organization=organization)
        else:
            return json_response({"error": "Division not found"}, status=404)
    except (Division.DoesNotExist, ValueError, ValidationError):
        return json_response({"error": "Division not found"}, status=404)

    denied = require_division_admin(request, division)
    if denied:
        return denied

    cleaned, errors = validate_team_update_data(data)
    if errors:
        return json_response(errors, status=400)

    team = Team.objects.create(
        division=division,
        **cleaned,
    )

    return json_response(transform_team(team), status=201)


@require_http_methods(["GET", "PUT", "PATCH"])
@csrf_protect
@require_auth
def team_detail(request, pk):
    """Retrieve or update a team."""
    organization = get_organization_from_request(request)

    try:
        if request.user.role == "master_admin":
            team = Team.objects.get(id=pk)
        elif organization:
            team = Team.objects.get(id=pk, division__organization=organization)
        else:
            return json_response({"error": "Not found"}, status=404)
    except Team.DoesNotExist:
        return json_response({"error": "Not found"}, status=404)

    if request.method == "GET":
        return json_response(transform_team(team))

    denied = require_division_admin(request, team.division)
    if denied:
        return denied

    # PUT or PATCH - update
    data, parse_error = parse_json_body(request)
    if parse_error:
        return json_response({"error": parse_error}, status=400)

    # During/after draft, only allow name and coach changes
    if team.division.phase in ("draft", "complete"):
        allowed_fields = {"name", "head_coach", "assistant_coach"}
        requested_fields = set(data.keys())
        if not requested_fields.issubset(allowed_fields):
            return json_response(
                {"error": "During draft, only team name and coaches can be modified."},
                status=400
            )

    cleaned, errors = validate_team_update_data(data)
    if errors:
        return json_response(errors, status=400)

    for attr, value in cleaned.items():
        setattr(team, attr, value)
    team.save()

    return json_response(transform_team(team))


@require_http_methods(["PUT"])
@csrf_protect
@require_auth
def teams_bulk_update(request):
    """Bulk update teams."""
    organization = get_organization_from_request(request)

    data, parse_error = parse_json_body(request)
    if parse_error:
        return json_response({"error": parse_error}, status=400)

    division_id = data.get("division_id")
    teams_data = data.get("teams", [])

    if not division_id:
        return json_response({"error": "division_id is required"}, status=400)

    if not isinstance(teams_data, list):
        return json_response({"error": "teams must be a list"}, status=400)

    try:
        if request.user.role == "master_admin":
            division = Division.objects.get(id=division_id)
        elif organization:
            division = Division.objects.get(id=division_id, organization=organization)
        else:
            return json_response({"error": "Division not found"}, status=404)
    except (Division.DoesNotExist, ValueError, ValidationError):
        return json_response({"error": "Division not found"}, status=404)

    denied = require_division_admin(request, division)
    if denied:
        return denied

    updated_teams = []
    for team_data in teams_data:
        team_id = team_data.pop("id", None)
        if not team_id:
            continue

        try:
            team = Team.objects.get(id=team_id, division=division)
        except (Team.DoesNotExist, ValueError, ValidationError):
            continue

        cleaned, errors = validate_team_update_data(team_data)
        if errors:
            return json_response(errors, status=400)

        for attr, value in cleaned.items():
            setattr(team, attr, value)
        team.save()
        updated_teams.append(team)

    return json_response([transform_team(t) for t in updated_teams])


@require_http_methods(["POST"])
@csrf_protect
@require_auth
def team_assign_coach_kid(request, pk):
    """Assign a player as coach's kid."""
    organization = get_organization_from_request(request)

    try:
        if request.user.role == "master_admin":
            team = Team.objects.get(id=pk)
        elif organization:
            team = Team.objects.get(id=pk, division__organization=organization)
        else:
            return json_response({"error": "Not found"}, status=404)
    except Team.DoesNotExist:
        return json_response({"error": "Not found"}, status=404)

    denied = require_division_admin(request, team.division)
    if denied:
        return denied

    # Protect during/after draft
    if team.division.phase in ("draft", "complete"):
        return json_response(
            {"error": "Cannot modify coach's kids during or after draft. Use Reset Draft to start over."},
            status=400
        )

    data, parse_error = parse_json_body(request)
    if parse_error:
        return json_response({"error": parse_error}, status=400)

    player_id = data.get("player_id")
    if not player_id:
        return json_response({"error": "player_id is required"}, status=400)

    try:
        player = Player.objects.get(id=player_id, division=team.division)
    except (Player.DoesNotExist, ValueError, ValidationError):
        return json_response({"error": "Player not found"}, status=404)

    player.is_coach_kid = True
    player.coach_team = team
    player.save()

    return json_response(transform_team(team))


@require_http_methods(["DELETE"])
@csrf_protect
@require_auth
def team_remove_coach_kid(request, pk, player_id):
    """Remove coach's kid assignment."""
    organization = get_organization_from_request(request)

    # Verify team access
    try:
        if request.user.role == "master_admin":
            team = Team.objects.get(id=pk)
        elif organization:
            team = Team.objects.get(id=pk, division__organization=organization)
        else:
            return json_response({"error": "Not found"}, status=404)
    except Team.DoesNotExist:
        return json_response({"error": "Not found"}, status=404)

    denied = require_division_admin(request, team.division)
    if denied:
        return denied

    # Protect during/after draft
    if team.division.phase in ("draft", "complete"):
        return json_response(
            {"error": "Cannot modify coach's kids during or after draft. Use Reset Draft to start over."},
            status=400
        )

    try:
        player = Player.objects.get(id=player_id, division=team.division)
    except (Player.DoesNotExist, ValueError, ValidationError):
        return json_response({"error": "Player not found"}, status=404)

    player.is_coach_kid = False
    player.coach_team = None
    player.save()

    return json_response({}, status=204)
