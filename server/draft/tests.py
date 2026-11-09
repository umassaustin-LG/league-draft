from django.test import TestCase

from .models import Division, DraftState, Organization, Player, Team
from .services import DraftService


def _make_division(slug):
    org = Organization.objects.create(name=slug, slug=slug)
    division = Division.objects.create(
        organization=org,
        name=f"{slug} majors",
        preset="majors",
        age_range_min=10,
        age_range_max=12,
        team_count=2,
        roster_size=2,
    )
    teams = [
        Team.objects.create(division=division, name=f"{slug} {i}", draft_position=i)
        for i in (1, 2)
    ]
    players = [
        Player.objects.create(
            division=division,
            bib=str(i),
            first_name=f"{slug}{i}",
            last_name="Kid",
            little_league_age=11,
            birthday="2014-01-01",
            total_score=10 * i,
        )
        for i in range(1, 5)
    ]
    return division, teams, players


class DraftCrossDivisionTests(TestCase):
    def setUp(self):
        self.division, self.teams, self.players = _make_division("mallory")
        self.other_division, self.other_teams, self.other_players = _make_division("acme")
        self.draft = DraftService.start_draft(
            division_id=self.division.id,
            draft_format="straight",
            draft_order=[t.id for t in self.teams],
        )

    def test_draft_player_rejects_player_from_other_division(self):
        victim = self.other_players[0]
        with self.assertRaisesMessage(ValueError, "Player not found in this division"):
            DraftService.draft_player(self.draft.id, victim.id, self.teams[0].id)

        victim.refresh_from_db()
        self.assertFalse(victim.is_drafted)
        self.assertIsNone(victim.drafted_by_team_id)
        self.assertEqual(self.draft.picks.count(), 0)

    def test_draft_player_allows_player_in_division(self):
        DraftService.draft_player(self.draft.id, self.players[0].id, self.teams[0].id)
        self.players[0].refresh_from_db()
        self.assertTrue(self.players[0].is_drafted)
        self.assertEqual(self.players[0].drafted_by_team_id, self.teams[0].id)

    def test_start_draft_rejects_teams_from_other_division(self):
        with self.assertRaisesMessage(ValueError, "Draft order contains teams not in this division"):
            DraftService.start_draft(
                division_id=self.division.id,
                draft_format="straight",
                draft_order=[self.other_teams[0].id, self.teams[0].id],
                force_restart=True,
            )
        self.assertTrue(DraftState.objects.filter(id=self.draft.id).exists())

    def test_skip_pick_rejects_team_from_other_division(self):
        self.draft.current_team = self.other_teams[0]
        self.draft.save()
        with self.assertRaisesMessage(ValueError, "Team not found in this division"):
            DraftService.skip_pick(self.draft.id, self.other_teams[0].id)

    def test_create_trade_rejects_players_from_other_division(self):
        DraftService.draft_player(self.draft.id, self.players[0].id, self.teams[0].id)

        other_draft = DraftService.start_draft(
            division_id=self.other_division.id,
            draft_format="straight",
            draft_order=[t.id for t in self.other_teams],
        )
        victim = self.other_players[0]
        DraftService.draft_player(other_draft.id, victim.id, self.other_teams[0].id)

        with self.assertRaisesMessage(ValueError, "Player not found in this division"):
            DraftService.create_trade(
                draft_state_id=self.draft.id,
                team1_id=self.teams[0].id,
                team2_id=self.other_teams[0].id,
                player1_id=self.players[0].id,
                player2_id=victim.id,
                reason="steal",
            )

        victim.refresh_from_db()
        self.players[0].refresh_from_db()
        self.assertEqual(victim.drafted_by_team_id, self.other_teams[0].id)
        self.assertEqual(self.players[0].drafted_by_team_id, self.teams[0].id)

    def test_create_trade_within_division(self):
        DraftService.draft_player(self.draft.id, self.players[0].id, self.teams[0].id)
        DraftService.draft_player(self.draft.id, self.players[1].id, self.teams[1].id)

        DraftService.create_trade(
            draft_state_id=self.draft.id,
            team1_id=self.teams[0].id,
            team2_id=self.teams[1].id,
            player1_id=self.players[0].id,
            player2_id=self.players[1].id,
            reason="balance",
        )

        self.players[0].refresh_from_db()
        self.players[1].refresh_from_db()
        self.assertEqual(self.players[0].drafted_by_team_id, self.teams[1].id)
        self.assertEqual(self.players[1].drafted_by_team_id, self.teams[0].id)
