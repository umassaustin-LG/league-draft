from django.core import mail
from django.test import TestCase, override_settings
from django.urls import reverse

from .models import Organization, OrganizationInvitation, OrganizationMembership, User


@override_settings(EMAIL_BACKEND="django.core.mail.backends.locmem.EmailBackend")
class InvitationRoleTests(TestCase):
    def setUp(self):
        self.organization = Organization.objects.create(name="Invitation League", slug="invitations")
        self.admin = User.objects.create_user(email="admin@invitation.example")
        OrganizationMembership.objects.create(
            user=self.admin, organization=self.organization, role="admin"
        )
        self.client.force_login(self.admin)
        self.url = reverse("league-invitations", args=[self.organization.id])

    def invite(self, email, **data):
        return self.client.post(self.url, {"email": email, **data}, content_type="application/json")

    def test_supported_roles_can_be_invited_and_accepted(self):
        for role, _ in OrganizationMembership.ROLE_CHOICES:
            with self.subTest(role=role):
                self.client.force_login(self.admin)
                email = f"{role}@invitee.example"
                response = self.invite(email, role=role)
                self.assertEqual(response.status_code, 201)
                self.assertEqual(response.json()["role"], role)
                invitation = OrganizationInvitation.objects.get(email=email)
                self.assertEqual(invitation.role, role)
                self.assertEqual(mail.outbox[-1].to, [email])

                info = self.client.get(reverse("public-join-link", args=[invitation.token]))
                self.assertEqual(info.status_code, 200)
                self.assertEqual(info.json()["role"], role)
                self.assertEqual(info.json()["league_name"], self.organization.name)

                user = User.objects.create_user(email=email)
                self.client.force_login(user)
                response = self.client.post(
                    reverse("accept-invitation"), {"token": invitation.token},
                    content_type="application/json",
                )
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json()["league_id"], str(self.organization.id))
                membership = OrganizationMembership.objects.get(user=user, organization=self.organization)
                self.assertEqual(membership.role, role)
                invitation.refresh_from_db()
                self.assertIsNotNone(invitation.accepted_at)

    def test_omitted_role_defaults_to_viewer(self):
        response = self.invite("default@invitee.example")
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.json()["role"], "viewer")

    def test_invalid_roles_do_not_create_invitations(self):
        for role in ("member", "owner", "", None):
            with self.subTest(role=role):
                response = self.invite("invalid@invitee.example", role=role)
                self.assertEqual(response.status_code, 400)
                self.assertIn("role", response.json())
        self.assertFalse(OrganizationInvitation.objects.exists())

    def test_empty_email_does_not_create_invitation(self):
        response = self.invite("", role="coach")
        self.assertEqual(response.status_code, 400)
        self.assertIn("email", response.json())
        self.assertFalse(OrganizationInvitation.objects.exists())

    def test_membership_roles_match_invitation_roles(self):
        user = User.objects.create_user(email="member@invitee.example")
        membership = OrganizationMembership.objects.create(
            user=user, organization=self.organization, role="viewer"
        )
        url = reverse("league-member-update-role", args=[self.organization.id, user.id])
        for role, _ in OrganizationMembership.ROLE_CHOICES:
            with self.subTest(role=role):
                response = self.client.patch(url, {"role": role}, content_type="application/json")
                self.assertEqual(response.status_code, 200)
                membership.refresh_from_db()
                self.assertEqual(membership.role, role)
        for data in ({"role": "member"}, {"role": "owner"}, {}):
            response = self.client.patch(url, data, content_type="application/json")
            self.assertEqual(response.status_code, 400)

    def test_join_link_creates_viewer_membership(self):
        response = self.client.post(reverse("league-join-link", args=[self.organization.id]))
        self.assertEqual(response.status_code, 200)
        token = response.json()["token"]
        user = User.objects.create_user(email="join@invitee.example")
        self.client.force_login(user)
        response = self.client.post(
            reverse("accept-invitation"), {"token": token}, content_type="application/json"
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(OrganizationMembership.objects.get(user=user).role, "viewer")
        response = self.client.post(
            reverse("accept-invitation"), {"token": token}, content_type="application/json"
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(OrganizationMembership.objects.filter(user=user).count(), 1)

    def test_email_invitation_cannot_be_accepted_by_another_user(self):
        self.assertEqual(self.invite("invited@invitee.example", role="coach").status_code, 201)
        invitation = OrganizationInvitation.objects.get()
        other = User.objects.create_user(email="other@invitee.example")
        self.client.force_login(other)
        response = self.client.post(
            reverse("accept-invitation"), {"token": invitation.token}, content_type="application/json"
        )
        self.assertEqual(response.status_code, 400)
        self.assertFalse(OrganizationMembership.objects.filter(user=other).exists())

    def test_only_admin_can_invite(self):
        coach = User.objects.create_user(email="coach@invitation.example")
        OrganizationMembership.objects.create(
            user=coach, organization=self.organization, role="coach"
        )
        self.client.force_login(coach)
        self.assertEqual(self.invite("new@invitee.example", role="admin").status_code, 403)
        self.assertFalse(OrganizationInvitation.objects.exists())
