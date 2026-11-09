import json
import time
from unittest import mock

from django.contrib.auth import get_user_model
from django.core import mail
from django.test import RequestFactory, TestCase, override_settings
from django.urls import reverse

from .models import Division, Organization, OrganizationMembership, RateLimitCounter, Team, User
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
