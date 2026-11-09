import json
import time
from unittest import mock

from django.contrib.auth import get_user_model
from django.core import mail
from django.test import RequestFactory, TestCase, override_settings
from django.urls import reverse

from .models import (
    Division,
    DraftState,
    EvaluationTemplate,
    Organization,
    OrganizationMembership,
    Player,
    RateLimitCounter,
    Team,
    User,
)
from .services import DraftService
from .views.helpers import RateLimiter, get_client_ip


class GetClientIpTests(TestCase):
    def setUp(self):
        self.factory = RequestFactory()

    def test_ignores_forwarded_for_without_trusted_proxies(self):
        request = self.factory.get("/", REMOTE_ADDR="10.0.0.5", HTTP_X_FORWARDED_FOR="1.2.3.4")
        self.assertEqual(get_client_ip(request), "10.0.0.5")

    @override_settings(NUM_TRUSTED_PROXIES=1)
    def test_uses_entry_added_by_trusted_proxy(self):
        request = self.factory.get(
            "/", REMOTE_ADDR="10.0.0.5", HTTP_X_FORWARDED_FOR="6.6.6.6, 203.0.113.9"
        )
        self.assertEqual(get_client_ip(request), "203.0.113.9")

    @override_settings(NUM_TRUSTED_PROXIES=2)
    def test_falls_back_when_too_few_hops(self):
        request = self.factory.get("/", REMOTE_ADDR="10.0.0.5", HTTP_X_FORWARDED_FOR="203.0.113.9")
        self.assertEqual(get_client_ip(request), "10.0.0.5")

    @override_settings(NUM_TRUSTED_PROXIES=1)
    def test_falls_back_on_invalid_ip(self):
        request = self.factory.get("/", REMOTE_ADDR="10.0.0.5", HTTP_X_FORWARDED_FOR="not-an-ip")
        self.assertEqual(get_client_ip(request), "10.0.0.5")


class FrozenWindowMixin:
    """Pin rate limiter time so tests never straddle a window boundary."""

    def setUp(self):
        super().setUp()
        frozen = mock.Mock()
        frozen.time.return_value = (time.time() // 3600) * 3600 + 1
        patcher = mock.patch("draft.views.helpers.time", frozen)
        patcher.start()
        self.addCleanup(patcher.stop)


class RateLimiterTests(FrozenWindowMixin, TestCase):
    def test_counter_is_shared_and_enforced(self):
        limiter = RateLimiter("test", "2/minute")
        self.assertTrue(limiter.hit("a")[0])
        self.assertTrue(RateLimiter("test", "2/minute").hit("a")[0])
        allowed, retry_after = limiter.hit("a")
        self.assertFalse(allowed)
        self.assertGreater(retry_after, 0)
        self.assertTrue(limiter.hit("b")[0])
        self.assertEqual(RateLimitCounter.objects.count(), 2)

    def test_is_blocked_does_not_count(self):
        limiter = RateLimiter("test", "1/minute")
        self.assertFalse(limiter.is_blocked("a")[0])
        self.assertFalse(limiter.is_blocked("a")[0])
        limiter.hit("a")
        self.assertTrue(limiter.is_blocked("a")[0])


class AuthRateLimitTests(FrozenWindowMixin, TestCase):
    def setUp(self):
        super().setUp()
        self.user = get_user_model().objects.create_user(
            email="alice@example.com", password="Correct-Horse-9"
        )

    def _login(self, password, xff, email="alice@example.com"):
        return self.client.post(
            reverse("login"),
            data=json.dumps({"email": email, "password": password}),
            content_type="application/json",
            HTTP_X_FORWARDED_FOR=xff,
        )

    def test_forged_forwarded_for_does_not_bypass_ip_limit(self):
        statuses = [self._login("wrong", f"198.51.100.{i}").status_code for i in range(6)]
        self.assertEqual(statuses[:5], [401] * 5)
        self.assertEqual(statuses[5], 429)

    @override_settings(NUM_TRUSTED_PROXIES=1)
    def test_per_account_failure_limit_across_ips(self):
        for i in range(10):
            response = self._login("wrong", f"6.6.6.6, 198.51.100.{i}")
            self.assertEqual(response.status_code, 401)
        response = self._login("Correct-Horse-9", "198.51.100.200")
        self.assertEqual(response.status_code, 429)

        other = self._login("wrong", "198.51.100.201", email="bob@example.com")
        self.assertEqual(other.status_code, 401)

    @override_settings(NUM_TRUSTED_PROXIES=1)
    def test_password_reset_emails_limited_per_account(self):
        for i in range(5):
            response = self.client.post(
                reverse("password-reset-request"),
                data=json.dumps({"email": "alice@example.com"}),
                content_type="application/json",
                HTTP_X_FORWARDED_FOR=f"198.51.100.{i}",
            )
            self.assertEqual(response.status_code, 200)
        self.assertEqual(len(mail.outbox), 3)


class TeamCreateTenantIsolationTests(TestCase):
    def setUp(self):
        self.org_a = Organization.objects.create(name="Org A", slug="org-a")
        self.org_b = Organization.objects.create(name="Org B", slug="org-b")
        self.user = User.objects.create_user(email="a@example.com", password="Passw0rd!x")
        OrganizationMembership.objects.create(user=self.user, organization=self.org_a, role="admin")
        self.own_division = Division.objects.create(organization=self.org_a, name="Majors", preset="majors", age_range_min=10, age_range_max=12, team_count=4)
        self.foreign_division = Division.objects.create(organization=self.org_b, name="Majors", preset="majors", age_range_min=10, age_range_max=12, team_count=4)
        self.client.force_login(self.user)

    def _create_team(self, division_id, **headers):
        return self.client.post(
            "/api/teams/",
            data=json.dumps({"division_id": str(division_id), "name": "Sharks", "draft_position": 1}),
            content_type="application/json",
            **headers,
        )

    def test_create_team_in_own_division(self):
        response = self._create_team(self.own_division.id)
        self.assertEqual(response.status_code, 201)
        self.assertEqual(Team.objects.filter(division=self.own_division).count(), 1)

    def test_create_team_in_foreign_division_returns_404(self):
        response = self._create_team(self.foreign_division.id)
        self.assertEqual(response.status_code, 404)
        self.assertFalse(Team.objects.filter(division=self.foreign_division).exists())

    def test_create_team_without_organization_returns_404(self):
        outsider = User.objects.create_user(email="m@example.com", password="Passw0rd!x")
        self.client.force_login(outsider)
        response = self._create_team(self.own_division.id)
        self.assertEqual(response.status_code, 404)
        self.assertFalse(Team.objects.exists())

    def test_create_team_with_invalid_division_id_returns_404(self):
        response = self._create_team("not-a-uuid")
        self.assertEqual(response.status_code, 404)

    def test_master_admin_can_create_team_in_any_division(self):
        admin = User.objects.create_user(email="admin@example.com", password="Passw0rd!x", role="master_admin")
        self.client.force_login(admin)
        response = self._create_team(self.foreign_division.id)
        self.assertEqual(response.status_code, 201)

    def test_user_without_organization_can_create_team_in_personal_division(self):
        solo = User.objects.create_user(email="solo@example.com", password="Passw0rd!x")
        personal = Division.objects.create(owner=solo, name="Personal", preset="custom", age_range_min=8, age_range_max=12, team_count=4)
        self.client.force_login(solo)
        response = self._create_team(personal.id)
        self.assertEqual(response.status_code, 201)


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


class ProfileUpdateTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(
            email="alice@example.com", password="Str0ng!Passw0rd"
        )
        self.client.force_login(self.user)

    def patch_me(self, payload):
        return self.client.patch(
            "/api/auth/me/", data=json.dumps(payload), content_type="application/json"
        )

    def test_email_cannot_be_changed(self):
        response = self.patch_me({"email": "mallory@example.com"})

        self.assertEqual(response.status_code, 400)
        self.user.refresh_from_db()
        self.assertEqual(self.user.email, "alice@example.com")

    def test_email_with_name_update_is_rejected(self):
        response = self.patch_me({"first_name": "Al", "email": "mallory@example.com"})

        self.assertEqual(response.status_code, 400)
        self.user.refresh_from_db()
        self.assertEqual(self.user.email, "alice@example.com")
        self.assertEqual(self.user.first_name, "")

    def test_name_can_be_updated(self):
        response = self.patch_me({"first_name": "Alice", "last_name": "Smith"})

        self.assertEqual(response.status_code, 200)
        self.user.refresh_from_db()
        self.assertEqual(self.user.first_name, "Alice")
        self.assertEqual(self.user.last_name, "Smith")
        self.assertEqual(self.user.email, "alice@example.com")


class PlayerTeamScopingTests(TestCase):
    """Player team references must stay inside the player's division."""

    def setUp(self):
        self.org = Organization.objects.create(name="Mine", slug="mine")
        self.other_org = Organization.objects.create(name="Acme", slug="acme")
        self.user = User.objects.create_user(email="mallory@example.com", password="Str0ng!Passw0rd")
        OrganizationMembership.objects.create(user=self.user, organization=self.org, role="admin")

        division_fields = {"preset": "aaa", "age_range_min": 8, "age_range_max": 10, "team_count": 8}
        self.division = Division.objects.create(name="Mine AAA", organization=self.org, **division_fields)
        self.own_team = Team.objects.create(division=self.division, draft_position=1)
        other_division = Division.objects.create(name="Acme AAA", organization=self.other_org, **division_fields)
        self.foreign_team = Team.objects.create(division=other_division, draft_position=1)

        self.client.force_login(self.user)

    def _player(self, bib, **extra):
        return {
            "bib": bib,
            "first_name": "Test",
            "last_name": f"Player{bib}",
            "little_league_age": 10,
            "is_drafted": True,
            **extra,
        }

    def _post(self, url, payload):
        return self.client.post(url, data=json.dumps(payload), content_type="application/json")

    def test_bulk_create_ignores_teams_from_other_divisions(self):
        response = self._post("/api/players/bulk/", {
            "division_id": str(self.division.id),
            "players": [
                self._player(
                    "1",
                    drafted_by_team_id=str(self.foreign_team.id),
                    locked_to_team_id=str(self.foreign_team.id),
                ),
            ],
        })

        self.assertEqual(response.status_code, 201, response.content)
        player = Player.objects.get(division=self.division, bib="1")
        self.assertIsNone(player.drafted_by_team)
        self.assertIsNone(player.locked_to_team)
        self.assertFalse(self.foreign_team.roster.exists())

    def test_bulk_create_keeps_teams_from_same_division(self):
        response = self._post("/api/players/bulk/", {
            "division_id": str(self.division.id),
            "players": [
                self._player(
                    "2",
                    drafted_by_team_id=str(self.own_team.id),
                    locked_to_team_id=str(self.own_team.id),
                ),
            ],
        })

        self.assertEqual(response.status_code, 201, response.content)
        player = Player.objects.get(division=self.division, bib="2")
        self.assertEqual(player.drafted_by_team, self.own_team)
        self.assertEqual(player.locked_to_team, self.own_team)

    def test_create_ignores_teams_from_other_divisions(self):
        response = self._post("/api/players/", {
            "division_id": str(self.division.id),
            **self._player(
                "3",
                drafted_by_team_id=str(self.foreign_team.id),
                locked_to_team_id=str(self.foreign_team.id),
            ),
        })

        self.assertEqual(response.status_code, 201, response.content)
        player = Player.objects.get(division=self.division, bib="3")
        self.assertIsNone(player.drafted_by_team)
        self.assertIsNone(player.locked_to_team)

    def test_update_ignores_teams_from_other_divisions(self):
        player = Player.objects.create(
            division=self.division, bib="4", first_name="Test", last_name="Player4", name="Test Player4", little_league_age=10,
        )

        response = self.client.put(
            f"/api/players/{player.id}/",
            data=json.dumps(self._player(
                "4",
                drafted_by_team_id=str(self.foreign_team.id),
                locked_to_team_id=str(self.foreign_team.id),
            )),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200, response.content)
        player.refresh_from_db()
        self.assertIsNone(player.drafted_by_team)
        self.assertIsNone(player.locked_to_team)


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


class CoachKidCrossTenantTests(TestCase):
    def setUp(self):
        self.victim_org = Organization.objects.create(name="Acme", slug="acme")
        victim_division = Division.objects.create(
            organization=self.victim_org, name="Majors", preset="majors",
            age_range_min=10, age_range_max=12, team_count=2,
        )
        self.victim_team = Team.objects.create(division=victim_division, name="Acme Team", draft_position=1)
        self.victim_player = Player.objects.create(
            division=victim_division, bib="1", first_name="Vic", last_name="Tim",
            name="Vic Tim", little_league_age=11, birthday="2014-01-01",
            is_coach_kid=True, coach_team=self.victim_team,
        )

        attacker_org = Organization.objects.create(name="Mallory", slug="mallory")
        attacker_division = Division.objects.create(
            organization=attacker_org, name="Majors", preset="majors",
            age_range_min=10, age_range_max=12, team_count=1,
        )
        self.attacker_team = Team.objects.create(division=attacker_division, name="M Team", draft_position=1)
        self.own_player = Player.objects.create(
            division=attacker_division, bib="1", first_name="Own", last_name="Kid",
            name="Own Kid", little_league_age=11, birthday="2014-01-01",
        )
        attacker = User.objects.create_user(email="mallory@example.com", password="x")
        OrganizationMembership.objects.create(user=attacker, organization=attacker_org, role="admin")
        self.client.force_login(attacker)

    def test_assign_rejects_player_from_other_division(self):
        response = self.client.post(
            f"/api/teams/{self.attacker_team.id}/coach-kids/",
            {"player_id": str(self.victim_player.id)},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 404)
        self.victim_player.refresh_from_db()
        self.assertTrue(self.victim_player.is_coach_kid)
        self.assertEqual(self.victim_player.coach_team_id, self.victim_team.id)

    def test_remove_rejects_player_from_other_division(self):
        response = self.client.delete(
            f"/api/teams/{self.attacker_team.id}/coach-kids/{self.victim_player.id}/"
        )
        self.assertEqual(response.status_code, 404)
        self.victim_player.refresh_from_db()
        self.assertTrue(self.victim_player.is_coach_kid)
        self.assertEqual(self.victim_player.coach_team_id, self.victim_team.id)

    def test_assign_and_remove_player_in_same_division(self):
        response = self.client.post(
            f"/api/teams/{self.attacker_team.id}/coach-kids/",
            {"player_id": str(self.own_player.id)},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)
        self.own_player.refresh_from_db()
        self.assertTrue(self.own_player.is_coach_kid)
        self.assertEqual(self.own_player.coach_team_id, self.attacker_team.id)

        response = self.client.delete(
            f"/api/teams/{self.attacker_team.id}/coach-kids/{self.own_player.id}/"
        )
        self.assertEqual(response.status_code, 204)
        self.own_player.refresh_from_db()
        self.assertFalse(self.own_player.is_coach_kid)
        self.assertIsNone(self.own_player.coach_team_id)
