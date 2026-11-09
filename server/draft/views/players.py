"""
Player views (replaces DRF PlayerViewSet).
"""

import math
import uuid as uuid_module

from django.views.decorators.csrf import csrf_protect
from django.views.decorators.http import require_http_methods

from ..models import Division, Team, Player
from ..transformers import transform_player
from ..input_validators import validate_player_data, validate_bulk_players_data
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
def players_list_create(request):
    """List players or create a new one."""
    organization = get_organization_from_request(request)

    if request.method == "GET":
        # Get players, optionally filtered by division
        division_id = request.GET.get("division_id")
        queryset = Player.objects.all()

        if division_id:
            queryset = queryset.filter(division_id=division_id)

        # Apply organization filtering for non-master-admins
        if request.user.role != "master_admin" and organization:
            queryset = queryset.filter(division__organization=organization)
        elif request.user.role != "master_admin":
            queryset = Player.objects.none()

        return json_response([transform_player(p) for p in queryset])

    # POST - create player
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
    except Division.DoesNotExist:
        return json_response({"error": "Division not found"}, status=404)

    denied = require_division_admin(request, division)
    if denied:
        return denied

    # Protect division during/after draft
    if division.phase in ("draft", "complete"):
        return json_response(
            {"error": "Cannot add players during or after draft. Use Reset Draft to start over."},
            status=400
        )

    cleaned, errors = validate_player_data(data)
    if errors:
        return json_response(errors, status=400)

    # Handle coach_team_id
    coach_team = None
    coach_team_id = cleaned.pop("coach_team_id", None)
    if coach_team_id:
        try:
            coach_team = Team.objects.get(id=coach_team_id, division=division)
        except Team.DoesNotExist:
            pass

    player = Player.objects.create(
        division=division,
        coach_team=coach_team,
        **cleaned,
    )

    return json_response(transform_player(player), status=201)


@require_http_methods(["GET", "PUT", "PATCH", "DELETE"])
@csrf_protect
@require_auth
def player_detail(request, pk):
    """Retrieve, update, or delete a player."""
    organization = get_organization_from_request(request)

    try:
        if request.user.role == "master_admin":
            player = Player.objects.get(id=pk)
        elif organization:
            player = Player.objects.get(id=pk, division__organization=organization)
        else:
            return json_response({"error": "Not found"}, status=404)
    except Player.DoesNotExist:
        return json_response({"error": "Not found"}, status=404)

    if request.method == "GET":
        return json_response(transform_player(player))

    denied = require_division_admin(request, player.division)
    if denied:
        return denied

    if request.method == "DELETE":
        # Protect division during/after draft
        if player.division.phase in ("draft", "complete"):
            return json_response(
                {"error": "Cannot delete players during or after draft. Use Reset Draft to start over."},
                status=400
            )
        player.delete()
        return json_response({}, status=204)

    # PUT or PATCH - update
    # Protect division during/after draft
    if player.division.phase in ("draft", "complete"):
        return json_response(
            {"error": "Cannot modify players during or after draft. Use Reset Draft to start over."},
            status=400
        )
    data, parse_error = parse_json_body(request)
    if parse_error:
        return json_response({"error": parse_error}, status=400)

    cleaned, errors = validate_player_data(data)
    if errors:
        return json_response(errors, status=400)

    # Handle coach_team_id
    coach_team_id = cleaned.pop("coach_team_id", None)
    if coach_team_id:
        try:
            player.coach_team = Team.objects.get(id=coach_team_id, division=player.division)
        except Team.DoesNotExist:
            player.coach_team = None

    for attr, value in cleaned.items():
        setattr(player, attr, value)
    player.save()

    return json_response(transform_player(player))


@require_http_methods(["POST"])
@csrf_protect
@require_auth
def players_bulk_create(request):
    """Bulk create players."""
    organization = get_organization_from_request(request)

    data, parse_error = parse_json_body(request)
    if parse_error:
        return json_response({"error": parse_error}, status=400)

    cleaned, errors = validate_bulk_players_data(data)
    if errors:
        return json_response(errors, status=400)

    division_id = cleaned["division_id"]
    players_data = cleaned["players"]

    try:
        if request.user.role == "master_admin":
            division = Division.objects.get(id=division_id)
        elif organization:
            division = Division.objects.get(id=division_id, organization=organization)
        else:
            return json_response({"error": "Division not found"}, status=404)
    except Division.DoesNotExist:
        return json_response({"error": "Division not found"}, status=404)

    denied = require_division_admin(request, division)
    if denied:
        return denied

    # Protect division during/after draft
    if division.phase in ("draft", "complete"):
        return json_response(
            {"error": "Cannot add players during or after draft. Use Reset Draft to start over."},
            status=400
        )

    created_players = []

    # Track old_id -> new_id mapping for sibling references
    old_to_new_id = {}
    sibling_refs = {}  # new_player_id -> old_sibling_id

    for player_data in players_data:
        # Extract the original ID if present (for sibling mapping)
        original_id = player_data.pop("id", None)

        coach_team_id = player_data.pop("coach_team_id", None)
        coach_team = None
        if coach_team_id:
            try:
                coach_team = Team.objects.get(id=coach_team_id, division=division)
            except (Team.DoesNotExist, ValueError):
                pass

        # Store sibling_id for later remapping, then clear it
        old_sibling_id = player_data.pop("sibling_id", None)

        # Sanitize remaining UUID fields - clear invalid values
        for uuid_field in ["locked_to_team_id", "drafted_by_team_id"]:
            if uuid_field in player_data and player_data[uuid_field]:
                try:
                    uuid_module.UUID(str(player_data[uuid_field]))
                except (ValueError, AttributeError):
                    player_data[uuid_field] = None

        # Convert UUID fields to actual relations
        locked_to_team = None
        if player_data.get("locked_to_team_id"):
            try:
                locked_to_team = Team.objects.get(id=player_data.pop("locked_to_team_id"))
            except Team.DoesNotExist:
                player_data.pop("locked_to_team_id", None)

        drafted_by_team = None
        if player_data.get("drafted_by_team_id"):
            try:
                drafted_by_team = Team.objects.get(id=player_data.pop("drafted_by_team_id"))
            except Team.DoesNotExist:
                player_data.pop("drafted_by_team_id", None)

        player = Player.objects.create(
            division=division,
            coach_team=coach_team,
            locked_to_team=locked_to_team,
            drafted_by_team=drafted_by_team,
            **player_data,
        )
        created_players.append(player)

        # Track ID mapping
        if original_id:
            old_to_new_id[str(original_id)] = player.id

        # Track sibling reference to fix later
        if old_sibling_id:
            sibling_refs[player.id] = str(old_sibling_id)

    # Second pass: Fix sibling_id references using the mapping
    for player_id, old_sibling_id in sibling_refs.items():
        new_sibling_id = old_to_new_id.get(old_sibling_id)
        if new_sibling_id:
            Player.objects.filter(id=player_id).update(sibling_id=new_sibling_id)
            # Update the player object in our list too
            for p in created_players:
                if p.id == player_id:
                    p.sibling_id = new_sibling_id
                    break

    # Update roster size (use ceiling to ensure all players can be drafted)
    total_players = division.players.count()
    division.roster_size = (
        math.ceil(total_players / division.team_count)
        if division.team_count > 0
        else 0
    )
    division.save()

    return json_response(
        [transform_player(p) for p in created_players],
        status=201,
    )


@require_http_methods(["DELETE"])
@csrf_protect
@require_auth
def players_delete_by_division(request):
    """Delete all players in a division."""
    organization = get_organization_from_request(request)

    division_id = request.GET.get("division_id")
    if not division_id:
        return json_response(
            {"error": "division_id query parameter is required"},
            status=400
        )

    # Verify division access
    try:
        if request.user.role == "master_admin":
            division = Division.objects.get(id=division_id)
        elif organization:
            division = Division.objects.get(id=division_id, organization=organization)
        else:
            return json_response({"error": "Division not found"}, status=404)
    except Division.DoesNotExist:
        return json_response({"error": "Division not found"}, status=404)

    denied = require_division_admin(request, division)
    if denied:
        return denied

    # Protect division during/after draft
    if division.phase in ("draft", "complete"):
        return json_response(
            {"error": "Cannot delete players during or after draft. Use Reset Draft to start over."},
            status=400
        )

    count, _ = Player.objects.filter(division_id=division_id).delete()
    return json_response({"deleted": count})
