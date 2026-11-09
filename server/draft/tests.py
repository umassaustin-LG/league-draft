import json

from django.test import Client, TestCase

from draft.models import User


class ProfileUpdateTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            email="alice@example.com", password="Str0ng!Passw0rd"
        )
        self.client = Client()
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
