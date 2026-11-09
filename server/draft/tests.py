import json
import time
from unittest import mock

from django.contrib.auth import get_user_model
from django.core import mail
from django.test import RequestFactory, TestCase, override_settings
from django.urls import reverse

from .models import Division, DraftState, Organization, Player, RateLimitCounter, Team
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
