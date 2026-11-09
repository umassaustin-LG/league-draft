"""
Draft views (replaces DRF DraftViewSet).
"""

from django.views.decorators.csrf import csrf_protect
from django.views.decorators.http import require_http_methods

from ..models import Division, DraftState
from ..services import DraftService
from ..transformers import transform_draft_state, transform_player, transform_team
from ..input_validators import (
    validate_draft_start_data,
    validate_draft_pick_data,
    validate_undo_pick_data,
    validate_skip_pick_data,
    validate_trade_data,
)
from .helpers import (
    json_response,
    parse_json_body,
    require_auth,
    get_league_from_request,
)


def _get_full_draft_response(draft_state):
    """Get full draft response with players and teams."""
    division = draft_state.division
    return {
        "draft_state": transform_draft_state(draft_state),
        "players": [transform_player(p) for p in division.players.all()],
        "teams": [transform_team(t) for t in division.teams.all()],
    }


def _verify_division_access(request, division):
    """Verify user has access to the division's league."""
    if request.user.role == "master_admin":
        return None

    league = get_league_from_request(request)
    if not league or league != division.league:
        return json_response(
            {"error": "You do not have access to this division"},
            status=403
        )
    return None


def _require_league_admin(request, division):
    """Verify user is admin of the division's league."""
    if request.user.role == "master_admin":
        return None

    if not request.user.is_league_admin(division.league):
        return json_response(
            {"error": "Only league admins can perform this action"},
            status=403
        )
    return None


@require_http_methods(["GET"])
@csrf_protect
@require_auth
def draft_retrieve(request, division_id):
    """Get draft state for a division."""
    try:
        draft_state = DraftState.objects.get(division_id=division_id)
    except DraftState.DoesNotExist:
        return json_response({"error": "Draft not found"}, status=404)

    # Verify access
    error = _verify_division_access(request, draft_state.division)
    if error:
        return error

    return json_response(transform_draft_state(draft_state))


@require_http_methods(["POST"])
@csrf_protect
@require_auth
def draft_start(request):
    """Start a draft."""
    data, parse_error = parse_json_body(request)
    if parse_error:
        return json_response({"error": parse_error}, status=400)

    cleaned, errors = validate_draft_start_data(data)
    if errors:
        return json_response(errors, status=400)

    # Verify access to division
    try:
        division = Division.objects.get(id=cleaned["division_id"])
    except Division.DoesNotExist:
        return json_response({"error": "Division not found"}, status=404)

    error = _require_league_admin(request, division)
    if error:
        return error

    try:
        draft_state = DraftService.start_draft(
            division_id=cleaned["division_id"],
            draft_format=cleaned["draft_format"],
            draft_order=cleaned["draft_order"],
        )
        return json_response(_get_full_draft_response(draft_state), status=201)
    except Exception as e:
        return json_response({"error": str(e)}, status=400)


@require_http_methods(["POST"])
@csrf_protect
@require_auth
def draft_pick(request):
    """Make a draft pick."""
    data, parse_error = parse_json_body(request)
    if parse_error:
        return json_response({"error": parse_error}, status=400)

    cleaned, errors = validate_draft_pick_data(data)
    if errors:
        return json_response(errors, status=400)

    # Verify access to draft
    try:
        draft_state = DraftState.objects.get(id=cleaned["draft_state_id"])
    except DraftState.DoesNotExist:
        return json_response({"error": "Draft not found"}, status=404)

    error = _require_league_admin(request, draft_state.division)
    if error:
        return error

    try:
        draft_state = DraftService.draft_player(
            draft_state_id=cleaned["draft_state_id"],
            player_id=cleaned["player_id"],
            team_id=cleaned["team_id"],
        )
        return json_response(_get_full_draft_response(draft_state))
    except Exception as e:
        return json_response({"error": str(e)}, status=400)


@require_http_methods(["POST"])
@csrf_protect
@require_auth
def draft_undo(request):
    """Undo last pick - admin only."""
    data, parse_error = parse_json_body(request)
    if parse_error:
        return json_response({"error": parse_error}, status=400)

    cleaned, errors = validate_undo_pick_data(data)
    if errors:
        return json_response(errors, status=400)

    # Verify admin access
    try:
        draft_state = DraftState.objects.get(id=cleaned["draft_state_id"])
    except DraftState.DoesNotExist:
        return json_response({"error": "Draft not found"}, status=404)

    error = _require_league_admin(request, draft_state.division)
    if error:
        return error

    try:
        draft_state = DraftService.undo_last_pick(
            draft_state_id=cleaned["draft_state_id"]
        )
        return json_response(_get_full_draft_response(draft_state))
    except Exception as e:
        return json_response({"error": str(e)}, status=400)


@require_http_methods(["POST"])
@csrf_protect
@require_auth
def draft_skip(request):
    """Skip current pick - admin only. Team gets one fewer player."""
    data, parse_error = parse_json_body(request)
    if parse_error:
        return json_response({"error": parse_error}, status=400)

    cleaned, errors = validate_skip_pick_data(data)
    if errors:
        return json_response(errors, status=400)

    # Verify admin access
    try:
        draft_state = DraftState.objects.get(id=cleaned["draft_state_id"])
    except DraftState.DoesNotExist:
        return json_response({"error": "Draft not found"}, status=404)

    error = _require_league_admin(request, draft_state.division)
    if error:
        return error

    try:
        draft_state = DraftService.skip_pick(
            draft_state_id=cleaned["draft_state_id"],
            team_id=cleaned["team_id"],
        )
        return json_response(_get_full_draft_response(draft_state))
    except Exception as e:
        return json_response({"error": str(e)}, status=400)


@require_http_methods(["POST"])
@csrf_protect
@require_auth
def draft_trade(request):
    """Create a trade - admin only."""
    data, parse_error = parse_json_body(request)
    if parse_error:
        return json_response({"error": parse_error}, status=400)

    cleaned, errors = validate_trade_data(data)
    if errors:
        return json_response(errors, status=400)

    # Verify admin access
    try:
        draft_state = DraftState.objects.get(id=cleaned["draft_state_id"])
    except DraftState.DoesNotExist:
        return json_response({"error": "Draft not found"}, status=404)

    error = _require_league_admin(request, draft_state.division)
    if error:
        return error

    try:
        draft_state = DraftService.create_trade(
            draft_state_id=cleaned["draft_state_id"],
            team1_id=cleaned["team1_id"],
            team2_id=cleaned["team2_id"],
            player1_id=cleaned["player1_id"],
            player2_id=cleaned["player2_id"],
            reason=cleaned["reason"],
        )
        return json_response(_get_full_draft_response(draft_state))
    except Exception as e:
        return json_response({"error": str(e)}, status=400)
