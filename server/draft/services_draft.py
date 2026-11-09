from django.db import transaction
from django.utils import timezone
from uuid import UUID

from .models import Division, Team, Player, DraftState, DraftPick, Trade


class DraftService:
    """Service for draft operations."""

    @classmethod
    @transaction.atomic
    def start_draft(
        cls, division_id: UUID, draft_format: str, draft_order: list[UUID],
        force_restart: bool = False
    ) -> DraftState:
        """Start a new draft for a division.

        Args:
            division_id: Division to start draft for
            draft_format: 'straight', 'snake', or 'recalculated'
            draft_order: List of team UUIDs in draft order
            force_restart: If True, allows restarting an in-progress draft.
                          If False (default), raises error if draft exists with picks.
        """
        division = Division.objects.get(id=division_id)

        # Check for existing draft state
        existing_draft = DraftState.objects.filter(division_id=division_id).first()
        if existing_draft:
            picks_count = existing_draft.picks.count()
            if picks_count > 0 and not force_restart:
                raise ValueError(
                    f"Draft already in progress with {picks_count} picks made. "
                    "Use 'Reset Draft' to start over, or resume the existing draft."
                )
            # Delete existing draft state (either no picks or force_restart=True)
            existing_draft.delete()

        division_team_ids = {
            str(tid) for tid in Team.objects.filter(division=division).values_list("id", flat=True)
        }
        if any(str(tid) not in division_team_ids for tid in draft_order):
            raise ValueError("Draft order contains teams not in this division")
        current_team = Team.objects.get(id=draft_order[0], division=division)

        # Convert UUIDs to strings for JSON storage
        draft_order_str = [str(tid) for tid in draft_order]

        # Create draft state
        draft_state = DraftState.objects.create(
            division=division,
            draft_format=draft_format,
            draft_order=draft_order_str,
            current_round_order=draft_order_str,
            current_round=1,
            current_pick_in_round=1,
            current_team=current_team,
            is_draft_complete=False,
        )

        # Update division phase
        division.phase = "draft"
        division.save()

        # Check for mandatory pick
        cls._check_and_set_mandatory_pick(draft_state, current_team, 1)

        return draft_state

    @classmethod
    @transaction.atomic
    def draft_player(
        cls, draft_state_id: UUID, player_id: UUID, team_id: UUID
    ) -> DraftState:
        """Draft a player."""
        import logging
        logger = logging.getLogger(__name__)

        draft_state = DraftState.objects.select_for_update().get(id=draft_state_id)
        logger.info(f"[draft_player] Starting pick. current_round={draft_state.current_round}, current_pick_in_round={draft_state.current_pick_in_round}, picks_so_far={draft_state.picks.count()}")

        if draft_state.is_draft_complete:
            raise ValueError("Draft is already complete")

        # Verify it's the correct team's turn
        if str(draft_state.current_team_id) != str(team_id):
            raise ValueError("Not this team's turn to pick")

        # Check for mandatory pick
        if (
            draft_state.mandatory_player_id
            and str(draft_state.mandatory_player_id) != str(player_id)
        ):
            raise ValueError("Must draft mandatory player first")

        # Verify player is available (use select_for_update to prevent race conditions)
        player = (
            Player.objects.select_for_update()
            .filter(id=player_id, division_id=draft_state.division_id)
            .first()
        )
        if player is None:
            raise ValueError("Player not found in this division")
        if player.is_drafted:
            raise ValueError("Player is already drafted")

        team = Team.objects.filter(id=team_id, division_id=draft_state.division_id).first()
        if team is None:
            raise ValueError("Team not found in this division")
        overall_pick = draft_state.picks.count() + 1

        # Create the pick
        DraftPick.objects.create(
            draft_state=draft_state,
            round=draft_state.current_round,
            pick=overall_pick,
            team_id=team_id,
            player_id=player_id,
        )

        # Update player as drafted
        player.is_drafted = True
        player.drafted_by_team = team
        player.drafted_in_round = draft_state.current_round
        player.drafted_at_pick = overall_pick
        player.save()

        # Update team score
        team.total_score = sum(p.total_score for p in team.roster.all())
        age_breakdown = dict(team.age_breakdown)
        age_key = str(player.little_league_age)
        age_breakdown[age_key] = age_breakdown.get(age_key, 0) + 1
        team.age_breakdown = age_breakdown
        team.save()

        # Handle sibling locking - follow chains for 3+ sibling groups
        cls._lock_sibling_chain(player, team)

        # Advance to next pick
        cls._advance_to_next_pick(draft_state)

        draft_state.refresh_from_db()
        return draft_state

    @classmethod
    @transaction.atomic
    def skip_pick(cls, draft_state_id: UUID, team_id: UUID) -> DraftState:
        """Skip the current pick (team gets one fewer player)."""
        draft_state = DraftState.objects.select_for_update().get(id=draft_state_id)

        if draft_state.is_draft_complete:
            raise ValueError("Draft is already complete")

        # Verify it's the correct team's turn
        if str(draft_state.current_team_id) != str(team_id):
            raise ValueError("Not this team's turn to pick")

        # Cannot skip if there's a mandatory pick
        if draft_state.mandatory_player_id:
            raise ValueError("Cannot skip - mandatory pick required")

        if not Team.objects.filter(id=team_id, division_id=draft_state.division_id).exists():
            raise ValueError("Team not found in this division")

        # Cannot skip if remaining players >= remaining draft spots
        # (all players must be drafted)
        division = draft_state.division
        available_players = division.players.filter(is_drafted=False).count()
        total_picks = len(draft_state.draft_order) * division.roster_size
        picks_made = draft_state.picks.count()
        remaining_spots = total_picks - picks_made
        if available_players >= remaining_spots:
            raise ValueError("Cannot skip - all remaining players must be drafted")

        overall_pick = draft_state.picks.count() + 1

        # Create a skipped pick record (no player assigned)
        DraftPick.objects.create(
            draft_state=draft_state,
            round=draft_state.current_round,
            pick=overall_pick,
            team_id=team_id,
            player_id=None,
            was_skipped=True,
        )

        # Advance to next pick
        cls._advance_to_next_pick(draft_state)

        draft_state.refresh_from_db()
        return draft_state

    @classmethod
    @transaction.atomic
    def undo_last_pick(cls, draft_state_id: UUID) -> DraftState:
        """Undo the last pick (including skipped picks)."""
        draft_state = DraftState.objects.select_for_update().get(id=draft_state_id)

        last_pick = draft_state.picks.order_by("-pick").first()
        if not last_pick:
            raise ValueError("No pick to undo")

        # Handle skipped picks (no player was drafted)
        if last_pick.was_skipped or not last_pick.player_id:
            # Just delete the pick and revert draft state
            last_pick.delete()

            # Revert draft state
            draft_order = draft_state.draft_order
            team_count = len(draft_order)
            pick_in_round = ((last_pick.pick - 1) % team_count) + 1

            draft_state.current_round = last_pick.round
            draft_state.current_pick_in_round = pick_in_round
            draft_state.current_team_id = last_pick.team_id
            draft_state.is_draft_complete = False
            draft_state.mandatory_player = None
            draft_state.mandatory_reason = ""
            draft_state.mandatory_sibling_name = ""
            draft_state.save()

            # Check for mandatory pick at reverted position
            current_team = Team.objects.get(id=last_pick.team_id)
            cls._check_and_set_mandatory_pick(draft_state, current_team, last_pick.round)

            draft_state.refresh_from_db()
            return draft_state

        # Handle normal picks (player was drafted)
        player = Player.objects.get(id=last_pick.player_id)
        team = Team.objects.get(id=last_pick.team_id)

        # Reset player draft status
        player.is_drafted = False
        player.drafted_by_team = None
        player.drafted_in_round = None
        player.drafted_at_pick = None
        player.save()

        # If player had siblings, remove sibling locks for the entire chain
        cls._unlock_sibling_chain(player)

        # Update team score
        team.total_score = sum(p.total_score for p in team.roster.all())
        age_breakdown = dict(team.age_breakdown)
        age_key = str(player.little_league_age)
        if age_key in age_breakdown:
            age_breakdown[age_key] -= 1
            if age_breakdown[age_key] == 0:
                del age_breakdown[age_key]
        team.age_breakdown = age_breakdown
        team.save()

        # Delete the pick
        last_pick.delete()

        # Revert draft state
        draft_order = draft_state.draft_order
        team_count = len(draft_order)
        pick_in_round = ((last_pick.pick - 1) % team_count) + 1

        draft_state.current_round = last_pick.round
        draft_state.current_pick_in_round = pick_in_round
        draft_state.current_team_id = last_pick.team_id
        draft_state.is_draft_complete = False
        draft_state.mandatory_player = None
        draft_state.mandatory_reason = ""
        draft_state.mandatory_sibling_name = ""
        draft_state.save()

        # Check for mandatory pick at reverted position
        current_team = Team.objects.get(id=last_pick.team_id)
        cls._check_and_set_mandatory_pick(draft_state, current_team, last_pick.round)

        draft_state.refresh_from_db()
        return draft_state

    @classmethod
    @transaction.atomic
    def create_trade(
        cls,
        draft_state_id: UUID,
        team1_id: UUID,
        team2_id: UUID,
        player1_id: UUID,
        player2_id: UUID,
        reason: str,
    ) -> DraftState:
        """Create a trade."""
        from datetime import timedelta
        from django.utils import timezone

        draft_state = DraftState.objects.select_for_update().get(id=draft_state_id)
        division_id = draft_state.division_id

        # Idempotency check: prevent duplicate trades within 10 seconds
        recent_trade = Trade.objects.filter(
            draft_state=draft_state,
            team1_id=team1_id,
            team2_id=team2_id,
            player1_id=player1_id,
            player2_id=player2_id,
            timestamp__gte=timezone.now() - timedelta(seconds=10),
        ).exists()
        if recent_trade:
            raise ValueError("This trade was already processed")

        # Verify players belong to correct teams
        players = Player.objects.select_for_update().filter(division_id=division_id)
        player1 = players.filter(id=player1_id).first()
        player2 = players.filter(id=player2_id).first()
        if player1 is None or player2 is None:
            raise ValueError("Player not found in this division")

        if str(player1.drafted_by_team_id) != str(team1_id):
            raise ValueError("Player 1 does not belong to team 1")
        if str(player2.drafted_by_team_id) != str(team2_id):
            raise ValueError("Player 2 does not belong to team 2")

        teams = Team.objects.filter(division_id=division_id)
        team1 = teams.filter(id=team1_id).first()
        team2 = teams.filter(id=team2_id).first()
        if team1 is None or team2 is None:
            raise ValueError("Team not found in this division")

        # Create trade record
        Trade.objects.create(
            draft_state=draft_state,
            team1_id=team1_id,
            team2_id=team2_id,
            player1_id=player1_id,
            player2_id=player2_id,
            reason=reason,
        )

        # Swap players
        player1.drafted_by_team = team2
        player1.save()
        player2.drafted_by_team = team1
        player2.save()

        # Update team scores
        team1.total_score = sum(p.total_score for p in team1.roster.all())
        team1.save()
        team2.total_score = sum(p.total_score for p in team2.roster.all())
        team2.save()

        draft_state.refresh_from_db()
        return draft_state

    @classmethod
    def _advance_to_next_pick(cls, draft_state: DraftState) -> None:
        """Advance to the next pick."""
        import logging
        logger = logging.getLogger(__name__)

        division = draft_state.division
        draft_order = draft_state.draft_order
        team_count = len(draft_order)
        roster_size = division.roster_size
        total_picks = team_count * roster_size
        current_picks = draft_state.picks.count()

        logger.info(f"[_advance_to_next_pick] team_count={team_count}, roster_size={roster_size}, total_picks={total_picks}, current_picks={current_picks}")

        if current_picks >= total_picks:
            # Draft complete
            draft_state.is_draft_complete = True
            draft_state.current_team = None
            draft_state.mandatory_player = None
            draft_state.mandatory_reason = ""
            draft_state.mandatory_sibling_name = ""
            draft_state.save()

            division.phase = "complete"
            division.completed_at = timezone.now()
            division.save()
            return

        # Calculate next position
        next_round = (current_picks // team_count) + 1
        next_pick_in_round = (current_picks % team_count) + 1

        # Calculate round order based on draft format
        # Only recalculate order at the START of a new round (pick 1 of round)
        if next_pick_in_round == 1:
            if draft_state.draft_format == "snake":
                # Reverse order on even rounds
                if next_round % 2 == 0:
                    current_round_order = list(reversed(draft_order))
                else:
                    current_round_order = draft_order
            elif draft_state.draft_format == "recalculated":
                # Sort teams by total score (ascending) - lowest picks first
                teams = Team.objects.filter(division=division).order_by("total_score")
                current_round_order = [str(t.id) for t in teams]
            else:
                # Straight draft
                current_round_order = draft_order
        else:
            # Mid-round: keep the existing round order
            current_round_order = draft_state.current_round_order

        next_team_id = current_round_order[next_pick_in_round - 1]
        next_team = Team.objects.get(id=next_team_id)

        draft_state.current_round = next_round
        draft_state.current_pick_in_round = next_pick_in_round
        draft_state.current_team = next_team
        draft_state.current_round_order = current_round_order
        draft_state.mandatory_player = None
        draft_state.mandatory_reason = ""
        draft_state.mandatory_sibling_name = ""
        draft_state.save()

        # Check for mandatory pick
        cls._check_and_set_mandatory_pick(draft_state, next_team, next_round)

    @classmethod
    def _get_remaining_picks_for_team(
        cls, draft_state: DraftState, team: Team, current_round: int
    ) -> int:
        """Calculate how many picks a team has remaining (including current pick)."""
        division = draft_state.division
        team_count = len(draft_state.draft_order)
        roster_size = division.roster_size
        total_rounds = roster_size

        # Count picks already made by this team
        picks_made = draft_state.picks.filter(team_id=team.id).count()

        # Remaining picks = total rounds - picks already made
        return total_rounds - picks_made

    @classmethod
    def _check_and_set_mandatory_pick(
        cls, draft_state: DraftState, team: Team, current_round: int
    ) -> None:
        """Check and set mandatory pick if applicable.

        Logic:
        1. First check if there's a mandatory pick due THIS round (projected/locked round matches)
        2. If not, check if we need to force a mandatory pick early because there aren't
           enough remaining picks to draft all required players at their projected rounds
        """
        from django.db.models import Q

        division = draft_state.division

        # Get all undrafted mandatory players for this team (coach's kids + locked siblings)
        coach_kids = list(Player.objects.filter(
            division=division,
            coach_team=team,
            is_drafted=False,
        ).order_by('projected_round', 'locked_to_round'))

        locked_siblings = list(Player.objects.filter(
            division=division,
            locked_to_team=team,
            is_drafted=False,
        ).exclude(
            # Exclude coach's kids that are already in coach_kids list
            coach_team=team
        ).order_by('projected_round', 'locked_to_round'))

        all_mandatory = coach_kids + locked_siblings

        if not all_mandatory:
            return

        # Check for sibling locked to this team in their effective round (immediate requirement)
        locked_sibling = Player.objects.filter(
            Q(locked_to_round=current_round)
            | Q(projected_round=current_round, locked_to_round__isnull=True),
            division=division,
            locked_to_team=team,
            is_drafted=False,
        ).first()

        if locked_sibling:
            draft_state.mandatory_player = locked_sibling
            draft_state.mandatory_reason = "sibling"
            draft_state.mandatory_sibling_name = locked_sibling.sibling or ""
            draft_state.save()
            return

        # Check for coach's kid in their projected round (immediate requirement)
        coach_kid = Player.objects.filter(
            Q(locked_to_round=current_round)
            | Q(projected_round=current_round, locked_to_round__isnull=True),
            division=division,
            coach_team=team,
            is_drafted=False,
        ).first()

        if coach_kid:
            draft_state.mandatory_player = coach_kid
            draft_state.mandatory_reason = "coach-kid"
            draft_state.mandatory_sibling_name = ""
            draft_state.save()
            return

        # Check if we need to force a mandatory pick early due to insufficient remaining picks
        remaining_picks = cls._get_remaining_picks_for_team(draft_state, team, current_round)
        mandatory_count = len(all_mandatory)

        if mandatory_count >= remaining_picks:
            # Must draft a mandatory player now - not enough picks left to wait
            # Pick the one with the earliest effective round
            def get_effective_round(p):
                return p.locked_to_round if p.locked_to_round is not None else (p.projected_round or 999)

            all_mandatory.sort(key=get_effective_round)
            forced_player = all_mandatory[0]

            # Determine reason
            if forced_player.coach_team_id == team.id:
                draft_state.mandatory_player = forced_player
                draft_state.mandatory_reason = "coach-kid"
                draft_state.mandatory_sibling_name = ""
            else:
                draft_state.mandatory_player = forced_player
                draft_state.mandatory_reason = "sibling"
                draft_state.mandatory_sibling_name = forced_player.sibling or ""

            draft_state.save()

    @classmethod
    def _lock_sibling_chain(cls, player: Player, team: Team) -> None:
        """Lock all siblings in a chain/group to a team.

        For 3+ siblings (e.g., Braden → Austin → Caden), this follows the chain
        in both directions to lock ALL related siblings, not just direct links.
        """
        from django.db.models import Q

        division = player.division
        processed_ids = {player.id}
        to_process = [player]

        while to_process:
            current = to_process.pop(0)

            # Forward direction: current's sibling_id
            if current.sibling_id and current.sibling_id not in processed_ids:
                sibling = Player.objects.filter(
                    id=current.sibling_id, division=division, is_drafted=False
                ).first()
                if sibling:
                    sibling.locked_to_team = team
                    sibling.save()
                    processed_ids.add(sibling.id)
                    to_process.append(sibling)

            # Reverse direction: anyone whose sibling_id points to current
            reverse_siblings = Player.objects.filter(
                sibling_id=current.id, division=division, is_drafted=False
            ).exclude(id__in=processed_ids)

            for sibling in reverse_siblings:
                sibling.locked_to_team = team
                sibling.save()
                processed_ids.add(sibling.id)
                to_process.append(sibling)

    @classmethod
    def _unlock_sibling_chain(cls, player: Player) -> None:
        """Unlock all siblings in a chain/group when undoing a pick.

        Similar to _lock_sibling_chain but removes locks instead of adding them.
        Only unlocks siblings that are NOT drafted (since drafted siblings
        should stay with their team).
        """
        division = player.division
        processed_ids = {player.id}
        to_process = [player]

        while to_process:
            current = to_process.pop(0)

            # Forward direction: current's sibling_id
            if current.sibling_id and current.sibling_id not in processed_ids:
                sibling = Player.objects.filter(
                    id=current.sibling_id, division=division, is_drafted=False
                ).first()
                if sibling:
                    sibling.locked_to_team = None
                    sibling.save()
                    processed_ids.add(sibling.id)
                    to_process.append(sibling)

            # Reverse direction: anyone whose sibling_id points to current
            reverse_siblings = Player.objects.filter(
                sibling_id=current.id, division=division, is_drafted=False
            ).exclude(id__in=processed_ids)

            for sibling in reverse_siblings:
                sibling.locked_to_team = None
                sibling.save()
                processed_ids.add(sibling.id)
                to_process.append(sibling)
