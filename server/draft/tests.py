import json
import time
from unittest import mock

from elevenlabs.core.api_error import ApiError
from httpx import ReadTimeout

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
    Season,
    Team,
    Trade,
    User,
)
from .services import DraftService
from .views.helpers import RateLimiter, get_client_ip
from league_draft.telemetry import before_send, scrub


class TelemetryScrubberTests(TestCase):
    def test_url_path_secrets(self):
        for path in ('/join/short', '/api/leagues/join/short', '/reset/uid/short',
                     '/reset-password/uid/short', '/invite/short', '/invitation/short',
                     '/accept/short', '/token/short', '/confirm/short'):
            clean = scrub({'url': 'https://example.com' + path + '?private=yes'})['url']
            self.assertNotIn('short', clean)
            self.assertNotIn('private=yes', clean)
        for secret in ('12345678-1234-1234-1234-123456789abc', 'abcdefghijklmnopqrst', '%61' * 20):
            self.assertEqual(scrub('/draft/' + secret), '/draft/[REDACTED]')
        self.assertEqual(scrub('/draft/players'), '/draft/players')
        self.assertEqual(scrub('/reset-password?uid=abc&token=secret'), '/reset-password')

    def test_nested_sensitive_properties(self):
        event = {'extra': {'firstName': 'Alice', 'players': ['Alice'], 'safe': 42}}
        self.assertEqual(scrub(event), {
            'extra': {'firstName': '[REDACTED]', 'players': '[REDACTED]', 'safe': 42},
        })
        self.assertEqual(event['extra']['firstName'], 'Alice')

    def test_error_strings_and_requests(self):
        event = {
            'exception': {'values': [{'value': 'Contact a@example.com or +1 (212) 555-1234'}]},
            'request': {'url': 'https://example.com/draft?secret=value#email',
                        'data': {'private': 'body'}, 'cookies': 'session',
                        'headers': {'Authorization': 'secret'}, 'query_string': 'private'},
            'user': {'id': 'opaque-id', 'email': 'a@example.com', 'ip_address': '1.2.3.4'},
        }
        clean = before_send(event, {})
        self.assertEqual(clean['exception']['values'][0]['value'], 'Contact [REDACTED] or [REDACTED]')
        self.assertEqual(clean['request'], {'url': 'https://example.com/draft'})
        self.assertEqual(clean['user'], {'id': 'opaque-id'})

    def test_empty_and_breadcrumb(self):
        self.assertEqual(scrub({}), {})
        self.assertIsNone(scrub(None))
        self.assertEqual(before_send({'message': 'private', 'data': {'body': 'secret'}}, {}),
                         {'message': 'private'})

    def test_word_boundaries_and_exception_messages(self):
        self.assertEqual(scrub({'message': 'x'}), {'message': 'x'})
        event = {'exception': {'values': [{'message': 'Contact a@example.com or 212-555-1234'}]},
                 'packages': 'x', 'language': 'en', 'filename': 'main.ts',
                 'player_name': 'Alice', 'firstName': 'Alice', 'roster': ['Alice'],
                 'coachEmail': 'a@example.com', 'teams': ['A'], 'scores': [10]}
        clean = scrub(event)
        self.assertEqual(clean['exception']['values'][0]['message'], 'Contact [REDACTED] or [REDACTED]')
        for key in ('packages', 'language', 'filename'):
            self.assertEqual(clean[key], event[key])
        for key in ('player_name', 'firstName', 'roster', 'coachEmail', 'teams', 'scores'):
            self.assertEqual(clean[key], '[REDACTED]')

    def test_posthog_system_properties(self):
        properties = {'token': 'phc_project', 'distinct_id': 'opaque', '$pathname': '/draft',
                      '$os_name': 'Linux', '$current_url': 'https://example.com/?private=yes',
                      '$email': 'a@example.com', 'coachEmail': 'a@example.com'}
        clean = scrub(properties, posthog=True)
        for key in ('token', 'distinct_id', '$pathname', '$os_name'):
            self.assertEqual(clean[key], properties[key])
        self.assertEqual(clean['$current_url'], 'https://example.com/')
        self.assertEqual(clean['$email'], '[REDACTED]')
        self.assertEqual(clean['coachEmail'], '[REDACTED]')
        self.assertEqual(scrub({'token': 'private'}), {'token': '[REDACTED]'})


@override_settings(ELEVENLABS_API_KEY="")
class ElevenLabsTokenTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(email="voice@example.com", password="test-password")
        self.organization = Organization.objects.create(name="Voice League", slug="voice-league")
        self.membership = OrganizationMembership.objects.create(
            user=self.user, organization=self.organization, role="admin"
        )
        self.client.force_login(self.user)
        self.client.defaults["HTTP_X_ORGANIZATION_ID"] = str(self.organization.id)
        self.url = reverse("elevenlabs-token")

    @mock.patch("draft.elevenlabs_client.ElevenLabs")
    def test_unconfigured_does_not_create_client(self, sdk):
        response = self.client.post(self.url)
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json(), {"error": "ElevenLabs is not configured"})
        sdk.assert_not_called()

    @override_settings(ELEVENLABS_API_KEY="test-key")
    @mock.patch("draft.elevenlabs_client.ElevenLabs")
    def test_configured_returns_single_use_token(self, sdk):
        sdk.return_value.tokens.single_use.create.return_value.token = "single-use-token"
        response = self.client.post(self.url)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"token": "single-use-token"})
        self.assertIn("no-store", response["Cache-Control"])
        sdk.assert_called_once_with(api_key="test-key", timeout=15)
        sdk.return_value.tokens.single_use.create.assert_called_once_with(
            token_type="realtime_scribe", request_options={"max_retries": 0}
        )

    @mock.patch("draft.views.elevenlabs.get_elevenlabs_client")
    def test_unauthenticated_rejected(self, get_client):
        self.client.logout()
        self.assertEqual(self.client.post(self.url).status_code, 401)
        get_client.assert_not_called()

    @override_settings(ELEVENLABS_API_KEY="test-key")
    @mock.patch("draft.elevenlabs_client.ElevenLabs")
    def test_non_admin_members_rejected_without_sdk_call(self, sdk):
        for role in ("coach", "viewer"):
            with self.subTest(role=role):
                self.membership.role = role
                self.membership.save(update_fields=["role"])
                response = self.client.post(self.url)
                self.assertEqual(response.status_code, 403)
                sdk.assert_not_called()

    @override_settings(ELEVENLABS_API_KEY="test-key")
    @mock.patch("draft.elevenlabs_client.ElevenLabs")
    def test_master_admin_succeeds_without_organization(self, sdk):
        self.user.role = "master_admin"
        self.user.save(update_fields=["role"])
        self.membership.delete()
        del self.client.defaults["HTTP_X_ORGANIZATION_ID"]
        sdk.return_value.tokens.single_use.create.return_value.token = "master-token"
        response = self.client.post(self.url)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"token": "master-token"})
        sdk.return_value.tokens.single_use.create.assert_called_once_with(
            token_type="realtime_scribe", request_options={"max_retries": 0}
        )

    @mock.patch("draft.elevenlabs_client.ElevenLabs")
    def test_missing_organization_rejected_without_sdk_call(self, sdk):
        self.membership.delete()
        del self.client.defaults["HTTP_X_ORGANIZATION_ID"]
        self.assertEqual(self.client.post(self.url).status_code, 400)
        sdk.assert_not_called()

    @override_settings(ELEVENLABS_API_KEY="test-key")
    @mock.patch("draft.elevenlabs_client.ElevenLabs")
    def test_upstream_error_is_sanitized(self, sdk):
        sdk.return_value.tokens.single_use.create.side_effect = ApiError(
            status_code=401, body="sensitive provider details"
        )
        response = self.client.post(self.url)
        self.assertEqual(response.status_code, 502)
        self.assertEqual(response.json(), {"error": "Unable to create ElevenLabs token"})

    @override_settings(ELEVENLABS_API_KEY="test-key")
    @mock.patch("draft.elevenlabs_client.ElevenLabs")
    def test_network_error_is_sanitized(self, sdk):
        sdk.return_value.tokens.single_use.create.side_effect = ReadTimeout("provider details")
        response = self.client.post(self.url)
        self.assertEqual(response.status_code, 502)
        self.assertEqual(response.json(), {"error": "Unable to create ElevenLabs token"})

    @mock.patch("draft.views.elevenlabs.token_limiter.hit", return_value=(False, 20))
    @mock.patch("draft.views.elevenlabs.get_elevenlabs_client")
    def test_rate_limited_without_sdk_call(self, get_client, hit):
        response = self.client.post(self.url)
        self.assertEqual(response.status_code, 429)
        self.assertEqual(response["Retry-After"], "20")
        get_client.assert_not_called()

    @mock.patch("draft.views.elevenlabs.get_elevenlabs_client")
    def test_get_not_allowed(self, get_client):
        self.assertEqual(self.client.get(self.url).status_code, 405)
        get_client.assert_not_called()


@override_settings(ELEVENLABS_API_KEY="test-key")
class AnnouncerTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user("announcer@example.com", "Passw0rd!x")
        organization = Organization.objects.create(name="League", slug="announcer")
        OrganizationMembership.objects.create(user=self.user, organization=organization, role="admin")
        self.client.force_login(self.user)

    def speak(self, data=None):
        return self.client.post("/api/elevenlabs/speak/", data=json.dumps(
            {"text": "With pick 12, the Tigers select Ava Garcia."} if data is None else data
        ), content_type="application/json")

    @override_settings(ELEVENLABS_API_KEY="")
    def test_not_configured(self):
        self.assertEqual(self.client.get("/api/elevenlabs/status/").json(), {"enabled": False})
        self.assertEqual(self.speak().status_code, 503)

    def test_auth_required(self):
        self.client.logout()
        self.assertEqual(self.client.get("/api/elevenlabs/status/").json(), {"enabled": False})
        self.assertEqual(self.speak().status_code, 401)

    @mock.patch("draft.elevenlabs_client.ElevenLabs")
    def test_non_admins_cannot_announce(self, sdk):
        for role in ("coach", "viewer"):
            self.user.memberships.update(role=role)
            self.assertEqual(self.client.get("/api/elevenlabs/status/").json(), {"enabled": False})
            self.assertEqual(self.speak().status_code, 403)
        sdk.assert_not_called()

    @mock.patch("draft.elevenlabs_client.ElevenLabs")
    def test_master_admin_without_membership_can_announce(self, sdk):
        self.user.memberships.all().delete()
        self.user.role = "master_admin"
        self.user.save()
        sdk.return_value.text_to_speech.convert.return_value = [b"audio"]
        self.assertEqual(self.client.get("/api/elevenlabs/status/").json(), {"enabled": True})
        self.assertEqual(self.speak().content, b"audio")
        sdk.return_value.text_to_speech.convert.assert_called_once()

    @mock.patch("draft.elevenlabs_client.ElevenLabs")
    def test_active_tenant_takes_precedence_over_other_admin_membership(self, sdk):
        other = Organization.objects.create(name="Other", slug="announcer-other")
        OrganizationMembership.objects.create(user=self.user, organization=other, role="coach")
        headers = {"HTTP_X_ORGANIZATION_ID": str(other.id)}
        self.assertEqual(self.client.get("/api/elevenlabs/status/", **headers).json(), {"enabled": False})
        self.assertEqual(self.client.post("/api/elevenlabs/speak/",
            {"text": "Announcement"}, content_type="application/json", **headers).status_code, 403)
        sdk.assert_not_called()
        sdk.return_value.text_to_speech.convert.return_value = [b"audio"]
        self.assertEqual(self.client.get("/api/elevenlabs/status/").json(), {"enabled": True})
        self.assertEqual(self.speak().status_code, 200)

    def test_membership_required(self):
        self.user.memberships.all().delete()
        self.assertEqual(self.speak().status_code, 403)

    @mock.patch("draft.elevenlabs_client.ElevenLabs")
    def test_success(self, upstream):
        upstream.return_value.text_to_speech.convert.return_value = iter([b"au", b"dio"])
        self.assertEqual(self.client.get("/api/elevenlabs/status/").json(), {"enabled": True})
        response = self.speak()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.content, b"audio")
        self.assertEqual(response["Content-Type"], "audio/mpeg")
        self.assertIn("no-store", response["Cache-Control"])
        self.assertEqual(upstream.return_value.text_to_speech.convert.call_args.kwargs["model_id"], "eleven_flash_v2_5")
        self.assertEqual(upstream.return_value.text_to_speech.convert.call_args.kwargs["request_options"], {"max_retries": 0})

    @mock.patch("draft.elevenlabs_client.ElevenLabs")
    def test_upstream_failure(self, upstream):
        for error in (ApiError(status_code=500, body="private upstream detail"), ReadTimeout("private detail")):
            upstream.return_value.text_to_speech.convert.side_effect = error
            response = self.speak()
            self.assertEqual(response.status_code, 502)
            self.assertEqual(response.json(), {"error": "Announcer unavailable"})

    @mock.patch("draft.elevenlabs_client.ElevenLabs")
    def test_invalid_text(self, upstream):
        for data in ({"text": "x" * 201}, {"text": ""}, {"text": " "}, {}, [], {"text": 123}):
            self.assertEqual(self.speak(data).status_code, 400)
        upstream.return_value.text_to_speech.convert.assert_not_called()

    def test_rate_limit(self):
        with mock.patch("draft.elevenlabs_client.ElevenLabs") as upstream:
            upstream.return_value.text_to_speech.convert.side_effect = ReadTimeout("upstream")
            for _ in range(30):
                self.speak()
        self.assertEqual(self.speak().status_code, 429)

    def test_csrf_required(self):
        from django.test import Client
        client = Client(enforce_csrf_checks=True)
        client.force_login(self.user)
        self.assertEqual(client.post("/api/elevenlabs/speak/", {}, content_type="application/json").status_code, 403)


@override_settings(ELEVENLABS_API_KEY="test-key")
class VoiceCopilotTokenTests(TestCase):
    def setUp(self):
        self.org = Organization.objects.create(name="Voice LL", slug="voice-ll")
        self.other_org = Organization.objects.create(name="Other LL", slug="other-ll")
        self.admin = User.objects.create_user(email="admin@voice.example", password="test-password")
        self.coach = User.objects.create_user(email="coach@voice.example", password="test-password")
        self.viewer = User.objects.create_user(email="viewer@voice.example", password="test-password")
        self.outsider = User.objects.create_user(email="outsider@voice.example", password="test-password")
        OrganizationMembership.objects.create(user=self.admin, organization=self.org, role="admin")
        OrganizationMembership.objects.create(user=self.coach, organization=self.org, role="coach")
        OrganizationMembership.objects.create(user=self.viewer, organization=self.org, role="viewer")
        OrganizationMembership.objects.create(user=self.outsider, organization=self.other_org, role="admin")
        fields = dict(preset="majors", age_range_min=10, age_range_max=12, team_count=4)
        self.division = Division.objects.create(organization=self.org, name="Majors", **fields)
        self.personal = Division.objects.create(owner=self.outsider, name="Personal", **fields)
        self.url = reverse("voice-copilot-token", args=[self.division.id])

    def post_as(self, user, url=None):
        self.client.force_login(user)
        return self.client.post(url or self.url)

    @mock.patch("draft.elevenlabs_client.ElevenLabs")
    def test_league_admin_gets_single_use_token(self, sdk):
        sdk.return_value.tokens.single_use.create.return_value.token = "scribe-token"
        response = self.post_as(self.admin)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"token": "scribe-token"})
        self.assertIn("no-store", response["Cache-Control"])
        sdk.return_value.tokens.single_use.create.assert_called_once_with(token_type="realtime_scribe")

    @mock.patch("draft.views.voice_copilot.get_elevenlabs_client")
    def test_coach_and_viewer_are_forbidden(self, get_client):
        for user in (self.coach, self.viewer):
            response = self.post_as(user)
            self.assertEqual(response.status_code, 403)
        get_client.assert_not_called()

    @mock.patch("draft.views.voice_copilot.get_elevenlabs_client")
    def test_admin_of_another_league_gets_not_found(self, get_client):
        self.assertEqual(self.post_as(self.outsider).status_code, 404)
        get_client.assert_not_called()

    @mock.patch("draft.elevenlabs_client.ElevenLabs")
    def test_personal_division_only_for_its_owner(self, sdk):
        sdk.return_value.tokens.single_use.create.return_value.token = "scribe-token"
        url = reverse("voice-copilot-token", args=[self.personal.id])
        self.assertEqual(self.post_as(self.admin, url).status_code, 404)
        self.assertEqual(self.post_as(self.outsider, url).status_code, 200)

    @mock.patch("draft.views.voice_copilot.get_elevenlabs_client")
    def test_unknown_division_and_anonymous(self, get_client):
        url = reverse("voice-copilot-token", args=["00000000-0000-0000-0000-000000000000"])
        self.assertEqual(self.post_as(self.admin, url).status_code, 404)
        self.client.logout()
        self.assertEqual(self.client.post(self.url).status_code, 401)
        get_client.assert_not_called()

    @override_settings(ELEVENLABS_API_KEY="")
    def test_unconfigured_returns_503(self):
        self.assertEqual(self.post_as(self.admin).status_code, 503)

    @mock.patch("draft.elevenlabs_client.ElevenLabs")
    def test_upstream_error_is_sanitized(self, sdk):
        sdk.return_value.tokens.single_use.create.side_effect = ApiError(status_code=401, body="provider details")
        response = self.post_as(self.admin)
        self.assertEqual(response.status_code, 502)
        self.assertEqual(response.json(), {"error": "Unable to create ElevenLabs token"})

    @mock.patch("draft.views.voice_copilot.get_elevenlabs_client")
    def test_get_not_allowed(self, get_client):
        self.client.force_login(self.admin)
        self.assertEqual(self.client.get(self.url).status_code, 405)
        get_client.assert_not_called()
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
        self.hour_start = (time.time() // 3600) * 3600
        frozen.time.return_value = self.hour_start + 1
        self.frozen_time = frozen
        patcher = mock.patch("draft.views.helpers.time", frozen)
        patcher.start()
        self.addCleanup(patcher.stop)

    def advance(self, seconds):
        self.frozen_time.time.return_value += seconds


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
    def test_failed_logins_from_one_ip_do_not_block_other_ip(self):
        for _ in range(5):
            response = self._login("wrong", "6.6.6.6, 198.51.100.1")
            self.assertEqual(response.status_code, 401)
        self.advance(61)

        for _ in range(5):
            response = self._login("wrong", "6.6.6.6, 198.51.100.1")
            self.assertEqual(response.status_code, 401)
        self.advance(61)

        response = self._login("Correct-Horse-9", "6.6.6.6, 198.51.100.1")
        self.assertEqual(response.status_code, 429)

        other = self._login("Correct-Horse-9", "6.6.6.6, 198.51.100.2")
        self.assertEqual(other.status_code, 200)

    @override_settings(NUM_TRUSTED_PROXIES=1)
    def test_password_reset_emails_limited_per_account_and_ip(self):
        for _ in range(3):
            response = self.client.post(
                reverse("password-reset-request"),
                data=json.dumps({"email": "alice@example.com"}),
                content_type="application/json",
                HTTP_X_FORWARDED_FOR="6.6.6.6, 198.51.100.1",
            )
            self.assertEqual(response.status_code, 200)
        self.assertEqual(len(mail.outbox), 3)

        blocked = self.client.post(
            reverse("password-reset-request"),
            data=json.dumps({"email": "alice@example.com"}),
            content_type="application/json",
            HTTP_X_FORWARDED_FOR="6.6.6.6, 198.51.100.1",
        )
        self.assertEqual(blocked.status_code, 429)
        self.assertEqual(len(mail.outbox), 3)

        other_ip = self.client.post(
            reverse("password-reset-request"),
            data=json.dumps({"email": "alice@example.com"}),
            content_type="application/json",
            HTTP_X_FORWARDED_FOR="6.6.6.6, 198.51.100.2",
        )
        self.assertEqual(other_ip.status_code, 200)
        self.assertEqual(len(mail.outbox), 4)


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
        self.season = Season.objects.create(
            organization=self.org, name="Spring", year=2026, template=self.template,
        )

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
            ("post", "/api/seasons/", {"name": "Fall", "year": 2026, "template_id": str(self.template.id)}),
            ("patch", f"/api/seasons/{self.season.id}/", {"name": "Hacked"}),
            ("delete", f"/api/seasons/{self.season.id}/", None),
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
        self.season.refresh_from_db()
        self.assertEqual(self.season.name, "Spring")
        self.assertEqual(Season.objects.filter(organization=self.org).count(), 1)

    def test_non_admin_member_can_still_read(self):
        div = str(self.division.id)
        for url in [
            f"/api/players/?division_id={div}",
            f"/api/players/{self.player.id}/",
            f"/api/teams/?division_id={div}",
            f"/api/teams/{self.team.id}/",
            "/api/evaluation-templates/",
            f"/api/evaluation-templates/{self.template.id}/",
            "/api/seasons/",
            f"/api/seasons/{self.season.id}/",
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
            self.admin, "post", "/api/seasons/",
            {"name": "Fall", "year": 2026, "template_id": str(self.template.id)},
        )
        self.assertEqual(response.status_code, 201, response.content)
        response = self._request(self.admin, "patch", f"/api/seasons/{self.season.id}/", {"name": "Summer"})
        self.assertEqual(response.status_code, 200, response.content)
        response = self._request(self.admin, "delete", f"/api/seasons/{self.season.id}/")
        self.assertEqual(response.status_code, 204, response.content)
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

    def test_bulk_create_preserves_team_builder_request_data(self):
        response = self._post("/api/players/bulk/", {
            "division_id": str(self.division.id),
            "players": [self._player("1", coach_request="Smith", teammate_requests=["Blake River"], school="Oak", grade=2)],
        })
        self.assertEqual(response.status_code, 201, response.content)
        player = Player.objects.get(division=self.division, bib="1")
        self.assertEqual(player.coach_request, "Smith")
        self.assertEqual(player.teammate_requests, ["Blake River"])
        self.assertEqual(player.school, "Oak")
        self.assertEqual(player.grade, 2)

    def test_bulk_create_rejects_invalid_request_data(self):
        for fields in ({"teammate_requests": "Blake"}, {"school": "x" * 201}, {"grade": -1}):
            response = self._post("/api/players/bulk/", {
                "division_id": str(self.division.id), "players": [self._player("1", **fields)],
            })
            self.assertEqual(response.status_code, 400, response.content)

    def test_bulk_create_preserves_temporary_excel_sibling_references(self):
        response = self._post("/api/players/bulk/", {
            "division_id": str(self.division.id),
            "players": [
                self._player("101", id="player-101", sibling_id="player-102"),
                self._player("102", id="player-102", sibling_id="player-101"),
            ],
        })
        self.assertEqual(response.status_code, 201, response.content)
        first = Player.objects.get(division=self.division, bib="101")
        second = Player.objects.get(division=self.division, bib="102")
        self.assertEqual(first.sibling_id, second.id)
        self.assertEqual(second.sibling_id, first.id)
        returned = {player["bib"]: player for player in response.json()}
        self.assertEqual(returned["101"]["sibling_id"], str(second.id))
        self.assertEqual(returned["102"]["sibling_id"], str(first.id))

    def test_bulk_create_drops_unresolved_sibling_references(self):
        response = self._post("/api/players/bulk/", {
            "division_id": str(self.division.id),
            "players": [self._player("101", id="player-101", sibling_id="missing-player")],
        })
        self.assertEqual(response.status_code, 201, response.content)
        self.assertIsNone(Player.objects.get(division=self.division, bib="101").sibling_id)

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


class DraftPickAuthorizationTests(CrossTenantTestBase):
    def setUp(self):
        super().setUp()
        self.draft_state = DraftService.start_draft(
            division_id=self.victim_division.id,
            draft_format="snake",
            draft_order=[t.id for t in self.victim_teams],
        )

    def _pick(self, user):
        self.client.force_login(user)
        return self.client.post(
            "/api/draft/pick/",
            data=json.dumps({
                "draft_state_id": str(self.draft_state.id),
                "player_id": str(self.victim_players[0].id),
                "team_id": str(self.draft_state.current_team_id),
            }),
            content_type="application/json",
        )

    def test_non_admin_member_cannot_make_pick(self):
        response = self._pick(self.viewer)
        self.assertEqual(response.status_code, 403)
        self.victim_players[0].refresh_from_db()
        self.assertFalse(self.victim_players[0].is_drafted)

    def test_admin_of_other_league_cannot_make_pick(self):
        response = self._pick(self.attacker)
        self.assertEqual(response.status_code, 403)
        self.victim_players[0].refresh_from_db()
        self.assertFalse(self.victim_players[0].is_drafted)

    def test_league_admin_can_make_pick(self):
        response = self._pick(self.victim_admin)
        self.assertEqual(response.status_code, 200)
        self.victim_players[0].refresh_from_db()
        self.assertTrue(self.victim_players[0].is_drafted)


class CompletedRosterAuthorizationTests(CrossTenantTestBase):
    def setUp(self):
        super().setUp()
        self.coach = User.objects.create_user("coach@example.com", "pw-Coach-123!")
        OrganizationMembership.objects.create(
            user=self.coach, organization=self.victim_org, role="coach"
        )
        self.victim_division.phase = "complete"
        self.victim_division.save(update_fields=["phase"])
        self.draft = DraftState.objects.create(
            division=self.victim_division, draft_format="snake", is_draft_complete=True
        )
        team1, team2 = self.victim_teams
        self.player1, self.player2 = self.victim_players[:2]
        for player, team in ((self.player1, team1), (self.player2, team2)):
            player.drafted_by_team = team
            player.is_drafted = True
            player.save(update_fields=["drafted_by_team", "is_drafted"])
        self.team_url = reverse("team-detail", args=[team1.id])
        self.trade_data = {
            "draft_state_id": str(self.draft.id),
            "team1_id": str(team1.id),
            "team2_id": str(team2.id),
            "player1_id": str(self.player1.id),
            "player2_id": str(self.player2.id),
            "reason": "Balance rosters",
        }

    def _trade(self):
        return self.client.post(reverse("draft-trade"), self.trade_data, content_type="application/json")

    def _rename_team(self):
        return self.client.patch(self.team_url, {"name": "Rockets"}, content_type="application/json")

    def test_coach_and_viewer_can_read_but_cannot_change_completed_rosters(self):
        for user in (self.coach, self.viewer):
            with self.subTest(user=user):
                self.client.force_login(user)
                division_url = reverse("division-detail", args=[self.victim_division.id])
                response = self.client.get(division_url, {"include": "all"})
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json()["phase"], "complete")
                self.assertEqual(self._rename_team().status_code, 403)
                self.assertEqual(self._trade().status_code, 403)

        self.victim_teams[0].refresh_from_db()
        self.player1.refresh_from_db()
        self.player2.refresh_from_db()
        self.assertNotEqual(self.victim_teams[0].name, "Rockets")
        self.assertEqual(self.player1.drafted_by_team_id, self.victim_teams[0].id)
        self.assertEqual(self.player2.drafted_by_team_id, self.victim_teams[1].id)
        self.assertFalse(Trade.objects.filter(draft_state=self.draft).exists())

    def test_league_admin_can_rename_teams_and_trade_after_the_draft(self):
        self.client.force_login(self.victim_admin)
        self.assertEqual(self._rename_team().status_code, 200)
        self.victim_teams[0].refresh_from_db()
        self.assertEqual(self.victim_teams[0].name, "Rockets")
        response = self._trade()
        self.assertEqual(response.status_code, 200, response.content)
        self.player1.refresh_from_db()
        self.player2.refresh_from_db()
        self.assertEqual(self.player1.drafted_by_team_id, self.victim_teams[1].id)
        self.assertEqual(self.player2.drafted_by_team_id, self.victim_teams[0].id)
        self.assertEqual(Trade.objects.filter(draft_state=self.draft).count(), 1)


class GeneratedRosterSummaryTests(CrossTenantTestBase):
    def test_assignments_make_generated_rosters_available_without_a_phase_change(self):
        division = self.victim_division
        division.mode = "league-generated"
        division.phase = "upload"
        division.save(update_fields=["mode", "phase"])
        self.client.force_login(self.viewer)
        url = reverse("divisions-list-create")

        def summary():
            response = self.client.get(url)
            self.assertEqual(response.status_code, 200)
            return next(row for row in response.json() if row["id"] == str(division.id))

        self.assertFalse(summary()["has_generated_rosters"])

        player = self.victim_players[0]
        player.drafted_by_team = self.victim_teams[0]
        player.save(update_fields=["drafted_by_team"])

        data = summary()
        self.assertEqual(data["phase"], "upload")
        self.assertTrue(data["has_generated_rosters"])
        self.assertEqual(data["player_count"], len(self.victim_players))
        response = self.client.get(reverse("division-detail", args=[division.id]), {"include": "all"})
        self.assertEqual(response.status_code, 200)
        team = next(row for row in response.json()["teams"] if row["id"] == str(self.victim_teams[0].id))
        self.assertEqual([row["id"] for row in team["roster"]], [str(player.id)])


class DraftSafetyTests(CrossTenantTestBase):
    def setUp(self):
        super().setUp()
        self.division = self.victim_division
        self.players = self.victim_players
        self.state = DraftService.start_draft(self.division.id, "snake", [t.id for t in self.victim_teams], actor=self.victim_admin)

    def pick(self, index):
        self.state = DraftService.draft_player(self.state.id, self.players[index].id, self.state.current_team_id, actor=self.victim_admin)

    def test_undo_round_order_and_audit(self):
        from .transformers import transform_draft_state
        original = list(self.state.current_round_order)
        self.pick(0)
        self.pick(1)
        self.assertNotEqual(self.state.current_round_order, original)
        self.state = DraftService.undo_last_pick(self.state.id, expected_pick=2, actor=self.victim_admin)
        self.assertEqual(self.state.current_round_order, original)
        log = transform_draft_state(self.state)["audit_log"]
        self.assertEqual([e["action"] for e in log], ["start", "pick", "pick", "undo"])
        self.assertTrue(all(e["actor_name"] for e in log))
        with self.assertRaisesMessage(ValueError, "Pick #2 was already undone or a newer pick exists"):
            DraftService.undo_last_pick(self.state.id, expected_pick=2)
        self.assertEqual(self.state.picks.count(), 1)

    def test_double_undo_and_completion(self):
        self.division.roster_size = 1
        self.division.save()
        self.pick(0)
        self.pick(1)
        self.assertTrue(self.state.is_draft_complete)
        self.state = DraftService.undo_last_pick(self.state.id, expected_pick=2)
        self.division.refresh_from_db()
        self.assertEqual(self.division.phase, "draft")
        self.assertIsNone(self.division.completed_at)
        self.state = DraftService.undo_last_pick(self.state.id, expected_pick=1)
        self.assertEqual(self.state.picks.count(), 0)
        with self.assertRaisesMessage(ValueError, "No pick to undo"):
            DraftService.undo_last_pick(self.state.id)

    def test_age_override_and_pick_check_permission(self):
        from .services_readiness import RuleCheckError
        self.division.max_per_age = 1
        self.division.save()
        self.pick(0)
        self.pick(1)
        with self.assertRaises(RuleCheckError):
            self.pick(2)
        self.state = DraftService.draft_player(self.state.id, self.players[2].id, self.state.current_team_id, acknowledge_warnings=True)
        self.assertTrue(self.state.audit_events.filter(action="pick").last().details["overridden_warnings"])
        self.client.force_login(self.viewer)
        response = self.client.post("/api/draft/pick-check/", data=json.dumps({"draft_state_id": str(self.state.id), "player_id": str(self.players[3].id), "team_id": str(self.state.current_team_id)}), content_type="application/json")
        self.assertEqual(response.status_code, 403)

    def test_acknowledged_warn_only_pick_is_not_an_override(self):
        from .services_readiness import evaluate_pick
        self.division.max_per_age = 1
        self.division.save()
        self.state.refresh_from_db()
        warnings = evaluate_pick(self.state, self.players[0], self.state.current_team)
        self.assertTrue(warnings)
        self.assertTrue(all(w["level"] == "warn" for w in warnings))
        self.state = DraftService.draft_player(
            self.state.id, self.players[0].id, self.state.current_team_id,
            acknowledge_warnings=True,
        )
        event = self.state.audit_events.filter(action="pick").last()
        self.assertNotIn("overridden_warnings", event.details)

    def test_sibling_warning_and_roster_balance(self):
        from .services_readiness import evaluate_pick
        self.players[0].sibling_id = self.players[1].id
        self.players[0].save()
        warnings = evaluate_pick(self.state, self.players[0], self.victim_teams[0])
        self.assertTrue(any(w["code"] == "sibling_lock" for w in warnings))
        self.players[0].sibling_id = None
        self.players[0].save()
        self.players[1].total_score = 100
        self.players[1].save()
        self.pick(0)
        self.pick(1)
        self.players[2].total_score = 100
        self.players[2].save()
        warnings = evaluate_pick(self.state, self.players[2], self.state.current_team)
        self.assertTrue(any(w["code"] == "roster_balance" for w in warnings))

    def test_readiness_checks(self):
        from .services_readiness import draft_readiness
        self.assertTrue(draft_readiness(self.division)["ready"])
        self.division.team_count = 3
        self.division.roster_size = 0
        self.division.max_per_age = 1
        self.division.save()
        self.players[0].is_coach_kid = True
        self.players[0].sibling_id = self.attacker.id
        self.players[0].save()
        result = draft_readiness(self.division)
        errors = {c["id"] for c in result["checks"] if c["level"] == "error"}
        self.assertTrue({"teams", "roster_size", "player_pool", "age_cap", "coach_kids", "siblings"} <= errors)
        self.assertFalse(result["ready"])

    def test_readiness_sibling_conflict_and_warnings(self):
        from .services_readiness import draft_readiness
        p, sibling = self.players[:2]
        p.is_coach_kid = sibling.is_coach_kid = True
        p.coach_team = self.victim_teams[0]
        sibling.coach_team = self.victim_teams[1]
        p.sibling_id = sibling.id
        p.little_league_age = 20
        p.is_dne = True
        p.save()
        sibling.save()
        checks = {c["id"]: c for c in draft_readiness(self.division)["checks"]}
        self.assertEqual(checks["siblings"]["level"], "error")
        for key in ("age_range", "dne", "sibling_links"):
            self.assertEqual(checks[key]["level"], "warning")
        sibling.coach_team = self.victim_teams[0]
        sibling.save()
        self.division.roster_size = 1
        self.division.save()
        checks = {c["id"]: c for c in draft_readiness(self.division)["checks"]}
        self.assertEqual(checks["coach_kids"]["level"], "error")

    def test_recalculated_undo_restores_snapshot(self):
        self.state.draft_format = "recalculated"
        self.state.save()
        self.players[0].total_score = 100
        self.players[0].save()
        original = list(self.state.current_round_order)
        self.pick(0)
        self.pick(1)
        self.assertNotEqual(self.state.current_round_order, original)
        self.state = DraftService.undo_last_pick(self.state.id)
        self.assertEqual(self.state.current_round_order, original)

    def test_pick_check_read_only_and_block_response(self):
        self.division.max_per_age = 1
        self.division.save()
        self.pick(0)
        self.pick(1)
        self.client.force_login(self.victim_admin)
        body = json.dumps({"draft_state_id": str(self.state.id), "player_id": str(self.players[2].id), "team_id": str(self.state.current_team_id)})
        checked = self.client.post("/api/draft/pick-check/", data=body, content_type="application/json")
        self.assertEqual(checked.status_code, 200)
        self.assertTrue(any(w["level"] == "block" for w in checked.json()["warnings"]))
        response = self.client.post("/api/draft/pick/", data=body, content_type="application/json")
        self.assertEqual(response.status_code, 409)
        self.assertTrue(response.json()["error"].startswith("Rule check failed:"))
        self.assertEqual(self.state.picks.count(), 2)
