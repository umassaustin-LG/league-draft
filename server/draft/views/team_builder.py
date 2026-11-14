"""
Team Builder views for auto-assignment of players to teams.

Endpoints:
- POST /api/team-builder/{division_id}/run/ - Run the algorithm
- POST /api/team-builder/{division_id}/apply/ - Apply assignments to database
- GET /api/team-builder/{division_id}/config/ - Get current config
- PATCH /api/team-builder/{division_id}/config/ - Update config
"""

import uuid
from django.db.models import Q
from django.views.decorators.csrf import csrf_protect
from django.views.decorators.http import require_http_methods

from ..models import Division, Team, Player
from ..services.team_builder import (
    TeamBuilderService,
    TeamBuilderConfig,
    TeamBuilderPlayer,
    detect_two_way_requests,
    resolve_coach_request,
)
from ..transformers import transform_team_builder_result
from ..input_validators import validate_team_builder_config, validate_team_builder_run
from .helpers import (
    get_organization_from_request,
    json_response,
    parse_json_body,
    require_auth,
    validate_uuid,
)


def _get_division_for_write(request, div_uuid):
    """
    Load a division the caller may modify via Team Builder.
    Returns (division, None) or (None, error_response).
    """
    user = request.user
    organization = get_organization_from_request(request)

    try:
        if user.role == "master_admin":
            division = Division.objects.get(id=div_uuid)
        elif organization:
            division = Division.objects.get(
                Q(id=div_uuid) & (Q(organization=organization) | Q(owner=user))
            )
        else:
            division = Division.objects.get(id=div_uuid, owner=user)
    except Division.DoesNotExist:
        return None, json_response({"error": "Division not found"}, status=404)

    can_write = (
        user.role == "master_admin"
        or division.owner_id == user.id
        or (division.organization and user.is_org_admin(division.organization))
    )
    if not can_write:
        return None, json_response({"error": "Permission denied"}, status=403)

    return division, None


def _build_team_builder_players(division: Division) -> list[TeamBuilderPlayer]:
    """
    Build TeamBuilderPlayer objects from division players.
    Resolves coach requests and teammate requests to IDs.
    """
    players = list(Player.objects.filter(division=division))
    teams = list(Team.objects.filter(division=division))

    # Build name -> player ID map for teammate resolution
    name_to_id: dict[str, uuid.UUID] = {}
    for p in players:
        name_to_id[p.name.lower()] = p.id
        name_to_id[f"{p.first_name} {p.last_name}".lower()] = p.id
        name_to_id[p.last_name.lower()] = p.id  # Allow last name only

    tb_players: list[TeamBuilderPlayer] = []

    for player in players:
        # Resolve coach request to team ID
        resolved_coach_team_id = resolve_coach_request(
            player.coach_request,
            teams
        )

        # Resolve teammate requests to player IDs
        resolved_teammate_ids: list[uuid.UUID] = []
        for req in (player.teammate_requests or []):
            req_lower = req.strip().lower()
            if req_lower in name_to_id:
                resolved_teammate_ids.append(name_to_id[req_lower])

        tb_player = TeamBuilderPlayer(
            id=player.id,
            bib=player.bib,
            first_name=player.first_name,
            last_name=player.last_name,
            name=player.name,
            total_score=player.total_score,
            is_coach_kid=player.is_coach_kid,
            coach_team_id=player.coach_team_id if player.coach_team else None,
            sibling_id=player.sibling_id,
            locked_to_team_id=player.locked_to_team_id if player.locked_to_team else None,
            coach_request=player.coach_request or "",
            teammate_requests=player.teammate_requests or [],
            school=player.school or "",
            grade=player.grade,
            resolved_coach_team_id=resolved_coach_team_id,
            resolved_teammate_ids=resolved_teammate_ids,
        )
        tb_players.append(tb_player)

    # Detect two-way requests
    two_way_map = detect_two_way_requests(tb_players)

    # Update players with two-way vs one-way categorization
    for tb_player in tb_players:
        two_way_ids = two_way_map.get(tb_player.id, set())
        tb_player.two_way_teammate_ids = list(two_way_ids)
        tb_player.one_way_teammate_ids = [
            pid for pid in tb_player.resolved_teammate_ids
            if pid not in two_way_ids
        ]

    return tb_players


@require_http_methods(["POST"])
@csrf_protect
@require_auth
def team_builder_run(request, division_id):
    """
    Run the team builder algorithm without persisting results.

    POST /api/team-builder/{division_id}/run/

    Body:
    {
        "config": {
            "balanceTolerance": 0.10,
            "topTalentRounds": 2,
            "maxRosterSize": 13,
            "prioritizeBalance": true
        }
    }

    Returns:
    {
        "assignments": [...],
        "teamSummaries": [...],
        "playerHappiness": [...],
        "stats": {...},
        "warnings": [...]
    }
    """
    # Validate division ID
    div_uuid, uuid_error = validate_uuid(division_id, "division_id")
    if uuid_error:
        return json_response({"error": uuid_error}, status=400)

    # Parse request body
    data, parse_error = parse_json_body(request)
    if parse_error:
        return json_response({"error": parse_error}, status=400)

    # Validate config if provided
    config_data = data.get("config", {})
    cleaned_config, config_errors = validate_team_builder_config(config_data)
    if config_errors:
        return json_response(config_errors, status=400)

    division, access_error = _get_division_for_write(request, div_uuid)
    if access_error:
        return access_error

    # Verify mode is league-generated
    if division.mode != "league-generated":
        return json_response(
            {"error": "Team Builder is only available for league-generated divisions"},
            status=400
        )

    # Build config
    config = TeamBuilderConfig(
        balance_tolerance=cleaned_config.get("balance_tolerance", 0.10),
        top_talent_rounds=cleaned_config.get("top_talent_rounds", 2),
        max_roster_size=cleaned_config.get("max_roster_size", 13),
        prioritize_balance=cleaned_config.get("prioritize_balance", True),
    )

    # Build player data
    tb_players = _build_team_builder_players(division)
    teams = list(Team.objects.filter(division=division))

    if not tb_players:
        return json_response({"error": "No players in division"}, status=400)

    if not teams:
        return json_response({"error": "No teams in division"}, status=400)

    # Run algorithm
    service = TeamBuilderService(config)
    result = service.run_algorithm(tb_players, teams)

    # Transform result for JSON response
    return json_response(transform_team_builder_result(result))


@require_http_methods(["POST"])
@csrf_protect
@require_auth
def team_builder_apply(request, division_id):
    """
    Apply team builder results to the database.

    POST /api/team-builder/{division_id}/apply/

    Body:
    {
        "config": {...}  // Same config used for run
    }

    This runs the algorithm and persists the results, creating a DraftState
    and DraftPicks as if it were a completed draft.
    """
    # Validate division ID
    div_uuid, uuid_error = validate_uuid(division_id, "division_id")
    if uuid_error:
        return json_response({"error": uuid_error}, status=400)

    # Parse request body
    data, parse_error = parse_json_body(request)
    if parse_error:
        return json_response({"error": parse_error}, status=400)

    # Validate config if provided
    config_data = data.get("config", {})
    cleaned_config, config_errors = validate_team_builder_config(config_data)
    if config_errors:
        return json_response(config_errors, status=400)

    division, access_error = _get_division_for_write(request, div_uuid)
    if access_error:
        return access_error

    # Verify mode is league-generated
    if division.mode != "league-generated":
        return json_response(
            {"error": "Team Builder is only available for league-generated divisions"},
            status=400
        )

    # Build config
    config = TeamBuilderConfig(
        balance_tolerance=cleaned_config.get("balance_tolerance", 0.10),
        top_talent_rounds=cleaned_config.get("top_talent_rounds", 2),
        max_roster_size=cleaned_config.get("max_roster_size", 13),
        prioritize_balance=cleaned_config.get("prioritize_balance", True),
    )

    # Build player data
    tb_players = _build_team_builder_players(division)
    teams = list(Team.objects.filter(division=division))

    if not tb_players:
        return json_response({"error": "No players in division"}, status=400)

    if not teams:
        return json_response({"error": "No teams in division"}, status=400)

    # Run algorithm
    service = TeamBuilderService(config)
    result = service.run_algorithm(tb_players, teams)

    # Apply to database
    draft_state = TeamBuilderService.apply_assignments(div_uuid, result)

    # Return result with draft state ID
    response_data = transform_team_builder_result(result)
    response_data["draftStateId"] = str(draft_state.id)
    response_data["applied"] = True

    return json_response(response_data)


@require_http_methods(["POST"])
@csrf_protect
@require_auth
def team_builder_update_requests(request, division_id):
    """
    Bulk update player request data (coach request, teammate requests, school, grade).

    POST /api/team-builder/{division_id}/update-requests/

    Body:
    {
        "players": [
            {
                "id": "uuid",
                "coachRequest": "Smith",
                "teammateRequests": ["John Doe", "Jane Smith"],
                "school": "Lincoln Elementary",
                "grade": 4
            },
            ...
        ]
    }
    """
    # Validate division ID
    div_uuid, uuid_error = validate_uuid(division_id, "division_id")
    if uuid_error:
        return json_response({"error": uuid_error}, status=400)

    # Parse request body
    data, parse_error = parse_json_body(request)
    if parse_error:
        return json_response({"error": parse_error}, status=400)

    division, access_error = _get_division_for_write(request, div_uuid)
    if access_error:
        return access_error

    # Update each player
    players_data = data.get("players", [])
    updated_count = 0
    errors = []

    for player_data in players_data:
        player_id = player_data.get("id")
        if not player_id:
            errors.append({"error": "Missing player id"})
            continue

        try:
            player = Player.objects.get(id=player_id, division=division)

            if "coachRequest" in player_data:
                player.coach_request = player_data["coachRequest"] or ""
            if "teammateRequests" in player_data:
                player.teammate_requests = player_data["teammateRequests"] or []
            if "school" in player_data:
                player.school = player_data["school"] or ""
            if "grade" in player_data:
                player.grade = player_data["grade"]

            player.save()
            updated_count += 1

        except Player.DoesNotExist:
            errors.append({"playerId": player_id, "error": "Player not found"})

    return json_response({
        "updated": updated_count,
        "errors": errors if errors else None
    })
