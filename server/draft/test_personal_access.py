import json
from unittest import mock

from django.test import TestCase, override_settings

from .models import Division, Organization, OrganizationMembership, Player, Team, User
from .services import DraftService


class PersonalDivisionAccessTests(TestCase):
    def setUp(self):
        self.owner = User.objects.create_user("owner@example.com", "Passw0rd!x")
        self.other = User.objects.create_user("other@example.com", "Passw0rd!x")
        self.north = Organization.objects.create(name="North", slug="north")
        self.south = Organization.objects.create(name="South", slug="south")
        self.foreign = Organization.objects.create(name="Foreign", slug="foreign")
        OrganizationMembership.objects.create(user=self.owner, organization=self.north, role="admin")
        OrganizationMembership.objects.create(user=self.owner, organization=self.south, role="coach")
        OrganizationMembership.objects.create(user=self.other, organization=self.north, role="admin")
        self.division = Division.objects.create(
            owner=self.owner, name="Personal", preset="custom", team_count=2, roster_size=2,
            age_range_min=8, age_range_max=12,
        )
        self.teams = [Team.objects.create(division=self.division, name=f"Team {i}", draft_position=i) for i in (1, 2)]
        self.player_data = [{
            "bib": str(i), "first_name": "Player", "last_name": str(i),
            "little_league_age": 9, "birthday": "2016-01-01",
        } for i in range(4)]
        self.players = [Player.objects.create(division=self.division, name=f"Player {i}", **data)
                        for i, data in enumerate(self.player_data)]
        self.client.force_login(self.owner)

    def request(self, method, url, data=None, **headers):
        kwargs = dict(headers)
        if data is not None:
            kwargs.update(data=json.dumps(data), content_type="application/json")
        return getattr(self.client, method)(url, **kwargs)

    def assert_response(self, method, url, data=None, status=200, **headers):
        response = self.request(method, url, data, **headers)
        self.assertEqual(response.status_code, status, response.content)
        return response

    def start_body(self, division=None, teams=None):
        return {"division_id": str((division or self.division).id), "draft_format": "straight",
                "draft_order": [str(team.id) for team in (teams or self.teams)]}

    def test_owner_can_save_start_pick_undo_and_run_personal_draft_without_header(self):
        self.assertEqual(self.owner.role, "user")
        self.assertEqual(self.owner.memberships.count(), 2)
        self.assert_response("get", f"/api/divisions/{self.division.id}/?include=all")
        self.assertTrue(self.assert_response("get", f"/api/draft/readiness/{self.division.id}/").json()["ready"])
        self.assert_response("put", "/api/teams/bulk/", {
            "division_id": str(self.division.id), "teams": [{"id": str(self.teams[0].id), "name": "North Stars"}],
        })
        self.assert_response("delete", f"/api/players/delete_by_division/?division_id={self.division.id}")
        saved = self.assert_response("post", "/api/players/bulk/", {
            "division_id": str(self.division.id), "players": self.player_data,
        }, status=201).json()
        self.assertEqual(len(saved), 4)
        self.assertTrue(self.assert_response("get", f"/api/draft/readiness/{self.division.id}/").json()["ready"])
        started = self.assert_response("post", "/api/draft/start/", self.start_body(), status=201).json()
        state_id = started["draft_state"]["id"]
        self.assert_response("get", f"/api/draft/{self.division.id}/")
        pick = {"draft_state_id": state_id, "player_id": saved[0]["id"], "team_id": str(self.teams[0].id)}
        self.assert_response("post", "/api/draft/pick-check/", pick)
        self.assert_response("post", "/api/draft/pick/", pick)
        self.assertTrue(Player.objects.get(id=saved[0]["id"]).is_drafted)
        self.assert_response("post", "/api/draft/undo/", {"draft_state_id": state_id, "expected_pick": 1})
        self.assertFalse(Player.objects.get(id=saved[0]["id"]).is_drafted)
        self.assert_response("post", "/api/draft/skip/", {
            "draft_state_id": state_id, "team_id": str(self.teams[0].id),
        }, status=400)
        self.assert_response("post", "/api/draft/pick/", pick)
        self.assert_response("post", "/api/draft/pick/", {
            "draft_state_id": state_id, "player_id": saved[1]["id"], "team_id": str(self.teams[1].id),
        })
        self.assert_response("post", "/api/draft/trade/", {
            "draft_state_id": state_id, "team1_id": str(self.teams[0].id), "team2_id": str(self.teams[1].id),
            "player1_id": saved[0]["id"], "player2_id": saved[1]["id"], "reason": "Balance",
        })
        self.assert_response("post", f"/api/divisions/{self.division.id}/reset/")
        self.assert_response("get", f"/api/draft/{self.division.id}/", status=404)

    def test_personal_player_and_team_crud_and_lists(self):
        for headers in ({}, {"HTTP_X_ORGANIZATION_ID": str(self.south.id)}):
            for collection, objects in (("players", self.players), ("teams", self.teams)):
                with self.subTest(collection=collection, headers=headers):
                    data = self.assert_response("get", f"/api/{collection}/?division_id={self.division.id}", **headers).json()
                    self.assertEqual({item["id"] for item in data}, {str(item.id) for item in objects})
                    self.assert_response("get", f"/api/{collection}/{objects[0].id}/", **headers)
        created = self.assert_response("post", "/api/players/", {
            "division_id": str(self.division.id), **self.player_data[0], "bib": "extra",
        }, status=201).json()
        self.assert_response("patch", f"/api/players/{created['id']}/", {**self.player_data[0], "bib": "updated"})
        self.assert_response("delete", f"/api/players/{created['id']}/", status=204)
        team = self.assert_response("post", "/api/teams/", {
            "division_id": str(self.division.id), "name": "Extra", "draft_position": 3,
        }, status=201).json()
        self.assert_response("patch", f"/api/teams/{team['id']}/", {"name": "Renamed"})
        self.assert_response("post", f"/api/teams/{team['id']}/coach-kids/", {"player_id": str(self.players[0].id)})
        self.assert_response("delete", f"/api/teams/{team['id']}/coach-kids/{self.players[0].id}/", status=204)
        self.assert_response("patch", f"/api/divisions/{self.division.id}/", {"name": "Renamed Personal"})
        self.assert_response("post", f"/api/team-builder/{self.division.id}/update-requests/", {"players": []})

    def denied_requests(self, division, teams, players, state):
        div = str(division.id)
        pick = {"draft_state_id": str(state.id), "player_id": str(players[0].id), "team_id": str(teams[0].id)}
        return [
            ("get", f"/api/divisions/{div}/", None),
            ("patch", f"/api/divisions/{div}/", {"phase": "complete"}),
            ("delete", f"/api/divisions/{div}/", None),
            ("post", f"/api/divisions/{div}/reset/", None),
            ("get", f"/api/draft/readiness/{div}/", None),
            ("get", f"/api/draft/{div}/", None),
            ("post", "/api/draft/start/", self.start_body(division, teams)),
            ("post", "/api/draft/pick-check/", pick),
            ("post", "/api/draft/pick/", pick),
            ("post", "/api/draft/undo/", {"draft_state_id": str(state.id)}),
            ("post", "/api/draft/skip/", {"draft_state_id": str(state.id), "team_id": str(teams[0].id)}),
            ("post", "/api/draft/trade/", {
                "draft_state_id": str(state.id), "team1_id": str(teams[0].id), "team2_id": str(teams[1].id),
                "player1_id": str(players[0].id), "player2_id": str(players[1].id), "reason": "Forbidden",
            }),
            ("post", "/api/players/", {"division_id": div, **self.player_data[0]}),
            ("post", "/api/players/bulk/", {"division_id": div, "players": self.player_data}),
            ("delete", f"/api/players/delete_by_division/?division_id={div}", None),
            ("get", f"/api/players/{players[0].id}/", None),
            ("patch", f"/api/players/{players[0].id}/", self.player_data[0]),
            ("delete", f"/api/players/{players[0].id}/", None),
            ("post", "/api/teams/", {"division_id": div, "name": "Forbidden", "draft_position": 3}),
            ("put", "/api/teams/bulk/", {"division_id": div, "teams": []}),
            ("get", f"/api/teams/{teams[0].id}/", None),
            ("patch", f"/api/teams/{teams[0].id}/", {"name": "Forbidden"}),
            ("post", f"/api/teams/{teams[0].id}/coach-kids/", {"player_id": str(players[0].id)}),
            ("delete", f"/api/teams/{teams[0].id}/coach-kids/{players[0].id}/", None),
            ("post", f"/api/divisions/{div}/voice-copilot/token/", {}),
            ("post", f"/api/team-builder/{div}/run/", {}),
            ("post", f"/api/team-builder/{div}/apply/", {}),
            ("post", f"/api/team-builder/{div}/update-requests/", {"players": []}),
        ]

    def assert_denied(self, division, teams, players, collection_status=200, **headers):
        state = DraftService.start_draft(division.id, "straight", [team.id for team in teams])
        for method, url, body in self.denied_requests(division, teams, players, state):
            with self.subTest(method=method, url=url, headers=headers):
                response = self.request(method, url, body, **headers)
                self.assertIn(response.status_code, (403, 404), response.content)
        for collection in ("players", "teams"):
            response = self.assert_response("get", f"/api/{collection}/?division_id={division.id}", status=collection_status, **headers)
            if collection_status == 200:
                self.assertEqual(response.json(), [])
        state.refresh_from_db()
        self.assertEqual(state.picks.count(), 0)
        self.assertEqual(division.players.count(), 4)

    def test_another_league_admin_cannot_access_the_personal_division(self):
        self.client.force_login(self.other)
        self.assert_denied(self.division, self.teams, self.players)

    def test_foreign_league_is_inaccessible_even_with_a_forged_header_or_owner_field(self):
        division = Division.objects.create(
            organization=self.foreign, owner=self.owner, name="Foreign", team_count=2,
            age_range_min=8, age_range_max=12, roster_size=2,
        )
        teams = [Team.objects.create(division=division, name=f"Foreign {i}", draft_position=i) for i in (1, 2)]
        players = [Player.objects.create(division=division, **data) for data in self.player_data]
        self.assert_denied(division, teams, players, collection_status=403, HTTP_X_ORGANIZATION_ID=str(self.foreign.id))
        self.assertNotIn(str(division.id), [item["id"] for item in self.client.get("/api/divisions/").json()])

    @override_settings(ELEVENLABS_API_KEY="test-key")
    @mock.patch("draft.views.elevenlabs.get_elevenlabs_client", return_value=None)
    def test_personal_announcer_owner_does_not_need_any_league_admin_role(self, client):
        self.owner.memberships.update(role="coach")
        self.assertTrue(self.client.get("/api/elevenlabs/status/").json()["enabled"])
        self.assert_response("post", "/api/elevenlabs/speak/", {"text": "Next pick"}, status=503)
        client.assert_called_once()
        client.reset_mock()
        headers = {"HTTP_X_ORGANIZATION_ID": str(self.south.id)}
        self.assertFalse(self.client.get("/api/elevenlabs/status/", **headers).json()["enabled"])
        self.assert_response("post", "/api/elevenlabs/speak/", {"text": "Next pick"}, status=403, **headers)
        client.assert_not_called()
        self.division.delete()
        self.assertFalse(self.client.get("/api/elevenlabs/status/").json()["enabled"])

    @mock.patch("draft.views.voice_copilot.get_elevenlabs_client", return_value=None)
    def test_personal_voice_copilot_owner_reaches_provider_check(self, client):
        self.assert_response("post", f"/api/divisions/{self.division.id}/voice-copilot/token/", {}, status=503)
        client.assert_called_once()

    def test_empty_personal_division_lists_and_unauthenticated_access(self):
        self.division.players.all().delete()
        self.division.teams.all().delete()
        for collection in ("players", "teams"):
            self.assertEqual(self.assert_response("get", f"/api/{collection}/?division_id={self.division.id}").json(), [])
        self.client.logout()
        self.assert_response("get", f"/api/draft/readiness/{self.division.id}/", status=401)
        self.assert_response("post", "/api/players/bulk/", {
            "division_id": str(self.division.id), "players": self.player_data,
        }, status=401)
