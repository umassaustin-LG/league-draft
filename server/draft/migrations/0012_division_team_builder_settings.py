from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("draft", "0011_draftpick_released_sibling_locks")]

    operations = [
        migrations.AddField(
            model_name="division",
            name="team_builder_settings",
            field=models.JSONField(blank=True, default=None, null=True),
        ),
    ]
