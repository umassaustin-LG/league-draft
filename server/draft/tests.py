import json

from django.test import TestCase

from .models import (
    Division,
    EvaluationTemplate,
    Organization,
    OrganizationMembership,
    Player,
    Team,
    User,
)


class OrgAdminWriteAuthorizationTests(TestCase):
    def setUp(self):
        self.org = Organization.objects.create(name="Acme", slug="acme")
        self.other_org = Organization.objects.create(name="Other", slug="other")

        self.admin = User.objects.create_user(email="admin@example.com", password="pw-Admin-123!")
        self.member = User.objects.create_user(email="member@example.com", password="pw-Member-123!")
        OrganizationMembership.objects.create(user=self.admin, organization=self.org, role="admin")
        OrganizationMembership.objects.create(user=self.member, organization=self.org, role="viewer")
        OrganizationMembership.objects.create(user=self.member, organization=self.other_org, role="admin")

        self.division = Division.objects.create(
            organization=self.org, name="Majors", age_range_min=10, age_range_max=12, team_count=2,
        )
        self.team = Team.objects.create(division=self.division, name="Red", draft_position=1)
        self.player = Player.objects.create(
            division=self.division, bib="1", first_name="A", last_name="B", name="A B",
            little_league_age=11, birthday="2014-01-01",
        )
        self.template = EvaluationTemplate.objects.create(organization=self.org, name="Default")

    def _request(self, user, method, url, data=None, org=None):
        self.client.force_login(user)
        kwargs = {"HTTP_X_ORGANIZATION_ID": str(org or self.org.id)}
        if data is not None:
            kwargs["data"] = json.dumps(data)
            kwargs["content_type"] = "application/json"
        return getattr(self.client, method)(url, **kwargs)

    def _non_admin_write_requests(self):
        div = str(self.division.id)
        return [
            ("post", "/api/players/", {"division_id": div, "bib": "2", "first_name": "C", "last_name": "D", "little_league_age": 11, "birthday": "2014-01-01"}),
            ("patch", f"/api/players/{self.player.id}/", {"field_score": 99}),
            ("delete", f"/api/players/{self.player.id}/", None),
            ("post", "/api/players/bulk/", {"division_id": div, "players": [{"bib": "3", "first_name": "E", "last_name": "F", "little_league_age": 11, "birthday": "2014-01-01"}]}),
            ("delete", f"/api/players/delete_by_division/?division_id={div}", None),
            ("post", "/api/teams/", {"division_id": div, "name": "Blue", "draft_position": 2}),
            ("patch", f"/api/teams/{self.team.id}/", {"name": "Hacked"}),
            ("put", "/api/teams/bulk/", {"division_id": div, "teams": [{"id": str(self.team.id), "name": "Hacked"}]}),
            ("post", f"/api/teams/{self.team.id}/coach-kids/", {"player_id": str(self.player.id)}),
            ("delete", f"/api/teams/{self.team.id}/coach-kids/{self.player.id}/", None),
            ("post", "/api/evaluation-templates/", {"name": "Evil"}),
            ("patch", f"/api/evaluation-templates/{self.template.id}/", {"name": "Evil"}),
            ("delete", f"/api/evaluation-templates/{self.template.id}/", None),
        ]

    def test_non_admin_member_cannot_write(self):
        for method, url, data in self._non_admin_write_requests():
            with self.subTest(method=method, url=url):
                response = self._request(self.member, method, url, data)
                self.assertEqual(response.status_code, 403, response.content)

        self.player.refresh_from_db()
        self.team.refresh_from_db()
        self.template.refresh_from_db()
        self.assertEqual(Player.objects.filter(division=self.division).count(), 1)
        self.assertEqual(self.player.field_score, 0)
        self.assertFalse(self.player.is_coach_kid)
        self.assertEqual(self.team.name, "Red")
        self.assertEqual(Team.objects.filter(division=self.division).count(), 1)
        self.assertEqual(self.template.name, "Default")
        self.assertTrue(self.template.is_active)
        self.assertEqual(EvaluationTemplate.objects.filter(organization=self.org).count(), 1)

    def test_non_admin_member_can_still_read(self):
        div = str(self.division.id)
        for url in [
            f"/api/players/?division_id={div}",
            f"/api/players/{self.player.id}/",
            f"/api/teams/?division_id={div}",
            f"/api/teams/{self.team.id}/",
            "/api/evaluation-templates/",
            f"/api/evaluation-templates/{self.template.id}/",
        ]:
            with self.subTest(url=url):
                self.assertEqual(self._request(self.member, "get", url).status_code, 200)

    def test_admin_can_write(self):
        response = self._request(
            self.admin, "patch", f"/api/players/{self.player.id}/",
            {"bib": "1", "first_name": "A", "last_name": "B", "little_league_age": 11, "field_score": 5},
        )
        self.assertEqual(response.status_code, 200, response.content)
        response = self._request(self.admin, "patch", f"/api/teams/{self.team.id}/", {"name": "Blue"})
        self.assertEqual(response.status_code, 200, response.content)
        response = self._request(
            self.admin, "post", f"/api/teams/{self.team.id}/coach-kids/", {"player_id": str(self.player.id)}
        )
        self.assertEqual(response.status_code, 200, response.content)
        response = self._request(
            self.admin, "patch", f"/api/evaluation-templates/{self.template.id}/", {"name": "Renamed"}
        )
        self.assertEqual(response.status_code, 200, response.content)
        response = self._request(
            self.admin, "delete", f"/api/players/delete_by_division/?division_id={self.division.id}"
        )
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(Player.objects.filter(division=self.division).count(), 0)

    def test_admin_of_other_org_cannot_create_team_in_foreign_division(self):
        response = self._request(
            self.member, "post", "/api/teams/",
            {"division_id": str(self.division.id), "name": "Blue", "draft_position": 2},
            org=self.other_org.id,
        )
        self.assertEqual(response.status_code, 404)
        self.assertEqual(Team.objects.filter(division=self.division).count(), 1)

    def test_coach_kid_assignment_rejects_player_from_other_division(self):
        other_division = Division.objects.create(
            organization=self.other_org, name="AAA", age_range_min=8, age_range_max=10, team_count=2,
        )
        foreign_player = Player.objects.create(
            division=other_division, bib="9", first_name="X", last_name="Y", name="X Y",
            little_league_age=9, birthday="2016-01-01",
        )
        response = self._request(
            self.admin, "post", f"/api/teams/{self.team.id}/coach-kids/", {"player_id": str(foreign_player.id)}
        )
        self.assertEqual(response.status_code, 404)
        foreign_player.refresh_from_db()
        self.assertFalse(foreign_player.is_coach_kid)
