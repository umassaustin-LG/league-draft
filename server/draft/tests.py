import json
import time
from unittest import mock

from django.contrib.auth import get_user_model
from django.core import mail
from django.test import RequestFactory, TestCase, override_settings
from django.urls import reverse

from .models import Division, Organization, OrganizationMembership, Player, RateLimitCounter, Team, User
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
