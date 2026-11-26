from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("draft", "0010_draftpick_locked_sibling_ids_and_more"),
    ]

    operations = [
        migrations.AddField(
            model_name="draftpick",
            name="released_sibling_locks",
            field=models.JSONField(default=dict),
        ),
    ]
