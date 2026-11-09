import json

from django.test import TestCase

from .models import (
    Division,
    DraftState,
    Organization,
    OrganizationMembership,
    Player,
    Team,
    User,
)
from .services import DraftService


def _make_division(organization, name="AA", mode="league-generated", owner=None):
    return Division.objects.create(
        organization=organization,
        owner=owner,
        name=name,
        preset="AA",
        age_range_min=7,
        age_range_max=10,
        team_count=2,
        roster_size=2,
        mode=mode,
    )


def _make_team(division, position):
    return Team.objects.create(division=division, name=f"Team {position}", draft_position=position)


def _make_player(division, bib, score=10):
    return Player.objects.create(
        division=division,
        bib=bib,
        first_name="Kid",
        last_name=bib,
        name=f"Kid {bib}",
        little_league_age=9,
        birthday="2016-01-01",
        total_score=score,
    )


class CrossTenantTestBase(TestCase):
    def setUp(self):
        self.victim_org = Organization.objects.create(name="Acme", slug="acme")
        self.attacker_org = Organization.objects.create(name="Mallory LL", slug="mallory")

        self.victim_admin = User.objects.create_user("alice@example.com", "pw-alice-123!")
        self.viewer = User.objects.create_user("viewer@example.com", "pw-viewer-123!")
        self.attacker = User.objects.create_user("mallory@example.com", "pw-mallory-123!")
        OrganizationMembership.objects.create(
            user=self.victim_admin, organization=self.victim_org, role="admin"
        )
        OrganizationMembership.objects.create(
            user=self.viewer, organization=self.victim_org, role="viewer"
        )
        OrganizationMembership.objects.create(
            user=self.attacker, organization=self.attacker_org, role="admin"
        )

        self.victim_division = _make_division(self.victim_org, "Victim AA")
        self.victim_teams = [_make_team(self.victim_division, i) for i in (1, 2)]
        self.victim_players = [
            _make_player(self.victim_division, f"V{i}", score=i) for i in range(4)
        ]


class TeamBuilderAccessTests(CrossTenantTestBase):
    def _post(self, user, action, body):
        self.client.force_login(user)
        return self.client.post(
            f"/api/team-builder/{self.victim_division.id}/{action}/",
            data=json.dumps(body),
            content_type="application/json",
        )

    def test_other_org_user_cannot_use_team_builder(self):
        for action in ("run", "apply", "update-requests"):
            body = {"players": [{"id": str(self.victim_players[0].id), "school": "X"}]}
            response = self._post(self.attacker, action, body)
            self.assertEqual(response.status_code, 404, action)

        self.assertFalse(DraftState.objects.filter(division=self.victim_division).exists())
        self.victim_players[0].refresh_from_db()
        self.assertEqual(self.victim_players[0].school, "")

    def test_viewer_in_same_org_cannot_use_team_builder(self):
        for action in ("run", "apply", "update-requests"):
            body = {"players": [{"id": str(self.victim_players[0].id), "school": "X"}]}
            response = self._post(self.viewer, action, body)
            self.assertEqual(response.status_code, 403, action)

        self.assertFalse(DraftState.objects.filter(division=self.victim_division).exists())
        self.victim_players[0].refresh_from_db()
        self.assertEqual(self.victim_players[0].school, "")

    def test_org_admin_can_use_team_builder(self):
        self.assertEqual(self._post(self.victim_admin, "run", {}).status_code, 200)
        body = {"players": [{"id": str(self.victim_players[0].id), "school": "Lincoln"}]}
        response = self._post(self.victim_admin, "update-requests", body)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["updated"], 1)


class DraftCrossDivisionTests(CrossTenantTestBase):
    def setUp(self):
        super().setUp()
        self.attacker_division = _make_division(
            self.attacker_org, "Mallory Majors", mode="live-draft"
        )
        self.attacker_teams = [_make_team(self.attacker_division, i) for i in (1, 2)]
        self.attacker_players = [
            _make_player(self.attacker_division, f"M{i}", score=i) for i in range(4)
        ]
        self.draft_state = DraftService.start_draft(
            division_id=self.attacker_division.id,
            draft_format="snake",
            draft_order=[t.id for t in self.attacker_teams],
        )
        self.client.force_login(self.attacker)

    def _post(self, path, body):
        return self.client.post(path, data=json.dumps(body), content_type="application/json")

    def test_cannot_draft_player_from_another_division(self):
        victim_player = self.victim_players[0]
        response = self._post("/api/draft/pick/", {
            "draft_state_id": str(self.draft_state.id),
            "player_id": str(victim_player.id),
            "team_id": str(self.draft_state.current_team_id),
        })
        self.assertEqual(response.status_code, 400)
        victim_player.refresh_from_db()
        self.assertFalse(victim_player.is_drafted)
        self.assertIsNone(victim_player.drafted_by_team_id)

    def test_can_draft_own_player(self):
        response = self._post("/api/draft/pick/", {
            "draft_state_id": str(self.draft_state.id),
            "player_id": str(self.attacker_players[0].id),
            "team_id": str(self.draft_state.current_team_id),
        })
        self.assertEqual(response.status_code, 200)
        self.attacker_players[0].refresh_from_db()
        self.assertTrue(self.attacker_players[0].is_drafted)

    def test_cannot_start_draft_with_foreign_teams(self):
        with self.assertRaises(ValueError):
            DraftService.start_draft(
                division_id=self.attacker_division.id,
                draft_format="snake",
                draft_order=[self.victim_teams[0].id, self.attacker_teams[0].id],
                force_restart=True,
            )

    def test_cannot_skip_with_foreign_team(self):
        with self.assertRaises(ValueError):
            DraftService.skip_pick(self.draft_state.id, self.victim_teams[0].id)

    def test_cannot_trade_players_from_another_division(self):
        victim_team = self.victim_teams[0]
        victim_player = self.victim_players[0]
        victim_player.is_drafted = True
        victim_player.drafted_by_team = victim_team
        victim_player.save()

        own_player = self.attacker_players[0]
        own_team = self.attacker_teams[0]
        own_player.is_drafted = True
        own_player.drafted_by_team = own_team
        own_player.save()

        response = self._post("/api/draft/trade/", {
            "draft_state_id": str(self.draft_state.id),
            "team1_id": str(own_team.id),
            "team2_id": str(victim_team.id),
            "player1_id": str(own_player.id),
            "player2_id": str(victim_player.id),
            "reason": "steal",
        })
        self.assertEqual(response.status_code, 400)
        victim_player.refresh_from_db()
        self.assertEqual(victim_player.drafted_by_team_id, victim_team.id)
