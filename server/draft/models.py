import uuid
from django.db import models
from django.contrib.auth.models import AbstractBaseUser, BaseUserManager, PermissionsMixin


# -----------------------------------------------------------------------------
# Tenant (Organization) Model
# -----------------------------------------------------------------------------


class Organization(models.Model):
    """Tenant model - represents a Little League organization."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=255)
    slug = models.SlugField(max_length=100, unique=True)
    created_at = models.DateTimeField(auto_now_add=True)

    # Join link fields
    join_link_token = models.CharField(max_length=64, null=True, blank=True, unique=True)
    join_link_enabled = models.BooleanField(default=False)

    class Meta:
        db_table = "organizations"
        ordering = ["-created_at"]

    def __str__(self):
        return self.name


# Alias for backwards compatibility during migration
League = Organization


# -----------------------------------------------------------------------------
# Custom User Model
# -----------------------------------------------------------------------------


class UserManager(BaseUserManager):
    """Custom user manager for email-based authentication."""

    def create_user(self, email, password=None, **extra_fields):
        if not email:
            raise ValueError("Email is required")
        email = self.normalize_email(email)
        user = self.model(email=email, **extra_fields)
        user.set_password(password)
        user.save(using=self._db)
        return user

    def create_superuser(self, email, password=None, **extra_fields):
        extra_fields.setdefault("is_staff", True)
        extra_fields.setdefault("is_superuser", True)
        extra_fields.setdefault("role", "master_admin")
        return self.create_user(email, password, **extra_fields)


class User(AbstractBaseUser, PermissionsMixin):
    """Custom user model with email authentication."""

    ROLE_CHOICES = [
        ("master_admin", "Master Admin"),
        ("user", "User"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    email = models.EmailField(unique=True)
    first_name = models.CharField(max_length=150, blank=True)
    last_name = models.CharField(max_length=150, blank=True)
    role = models.CharField(max_length=20, choices=ROLE_CHOICES, default="user")
    is_active = models.BooleanField(default=True)
    is_staff = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)

    objects = UserManager()
    USERNAME_FIELD = "email"
    REQUIRED_FIELDS = []

    class Meta:
        db_table = "users"
        ordering = ["-created_at"]

    def __str__(self):
        return self.email

    def get_organizations(self):
        """Get all organizations the user is a member of."""
        return Organization.objects.filter(memberships__user=self)

    # Alias for backwards compatibility
    def get_leagues(self):
        return self.get_organizations()

    def get_membership(self, organization):
        """Get membership for a specific organization."""
        return self.memberships.filter(organization=organization).first()

    def is_org_admin(self, organization):
        """Check if user is admin of a specific organization."""
        membership = self.get_membership(organization)
        return membership and membership.role == "admin"

    # Alias for backwards compatibility
    def is_league_admin(self, organization):
        return self.is_org_admin(organization)

    def get_org_role(self, organization):
        """Get user's role in an organization."""
        membership = self.get_membership(organization)
        return membership.role if membership else None


# -----------------------------------------------------------------------------
# Organization Membership Model
# -----------------------------------------------------------------------------


class OrganizationMembership(models.Model):
    """Membership linking users to organizations with roles."""

    ROLE_CHOICES = [
        ("admin", "Admin"),
        ("coach", "Coach"),
        ("viewer", "Viewer"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(
        User,
        on_delete=models.CASCADE,
        related_name="memberships",
    )
    organization = models.ForeignKey(
        Organization,
        on_delete=models.CASCADE,
        related_name="memberships",
    )
    role = models.CharField(max_length=20, choices=ROLE_CHOICES, default="viewer")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "organization_memberships"
        ordering = ["-created_at"]
        constraints = [
            models.UniqueConstraint(fields=['user', 'organization'], name='unique_org_membership'),
        ]

    def __str__(self):
        return f"{self.user.email} - {self.organization.name} ({self.role})"


# Alias for backwards compatibility during migration
LeagueMembership = OrganizationMembership


# -----------------------------------------------------------------------------
# Organization Invitation Model
# -----------------------------------------------------------------------------


class OrganizationInvitation(models.Model):
    """Invitation to join an organization (email or link-based)."""

    ROLE_CHOICES = [
        ("admin", "Admin"),
        ("coach", "Coach"),
        ("viewer", "Viewer"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    organization = models.ForeignKey(
        Organization,
        on_delete=models.CASCADE,
        related_name="invitations",
    )
    email = models.EmailField(null=True, blank=True)  # Null for link-based invites
    token = models.CharField(max_length=64, unique=True)
    invited_by = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        null=True,
        related_name="sent_invitations",
    )
    role = models.CharField(max_length=20, choices=ROLE_CHOICES, default="viewer")
    is_link_invite = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)
    expires_at = models.DateTimeField()
    accepted_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "organization_invitations"
        ordering = ["-created_at"]

    def __str__(self):
        if self.email:
            return f"Invitation to {self.email} for {self.organization.name}"
        return f"Link invitation for {self.organization.name}"

    @property
    def is_expired(self):
        from django.utils import timezone
        return timezone.now() > self.expires_at

    @property
    def is_pending(self):
        return self.accepted_at is None and not self.is_expired


# Alias for backwards compatibility during migration
LeagueInvitation = OrganizationInvitation


# -----------------------------------------------------------------------------
# Tenant-aware QuerySet and Manager
# -----------------------------------------------------------------------------


class TenantQuerySet(models.QuerySet):
    """QuerySet that supports tenant filtering."""

    def for_organization(self, organization):
        if organization is None:
            return self.none()
        return self.filter(organization=organization)

    # Alias for backwards compatibility
    def for_league(self, organization):
        return self.for_organization(organization)


class TenantManager(models.Manager):
    """Manager that supports tenant filtering."""

    def get_queryset(self):
        return TenantQuerySet(self.model, using=self._db)

    def for_organization(self, organization):
        return self.get_queryset().for_organization(organization)

    # Alias for backwards compatibility
    def for_league(self, organization):
        return self.for_organization(organization)


# -----------------------------------------------------------------------------
# Division Model
# -----------------------------------------------------------------------------


class Division(models.Model):
    """Top-level container for a draft."""

    PRESET_CHOICES = [
        ("majors", "Majors"),
        ("aaa", "AAA"),
        ("aa", "AA"),
        ("custom", "Custom"),
    ]

    PHASE_CHOICES = [
        ("upload", "Upload"),
        ("mapping", "Mapping"),
        ("review", "Review"),
        ("config", "Config"),
        ("draft", "Draft"),
        ("complete", "Complete"),
    ]

    SCORING_MODE_CHOICES = [
        ("raw", "Raw"),
        ("pre-weighted", "Pre-weighted"),
    ]

    MODE_CHOICES = [
        ("live-draft", "Live Draft"),
        ("league-generated", "League Generated Teams"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    # Organization (null for personal workspaces)
    organization = models.ForeignKey(
        Organization,
        on_delete=models.CASCADE,
        related_name="divisions",
        null=True,
        blank=True,
    )

    # Owner for personal workspaces (when organization is null)
    owner = models.ForeignKey(
        User,
        on_delete=models.CASCADE,
        related_name="personal_divisions",
        null=True,
        blank=True,
    )

    name = models.CharField(max_length=100)
    preset = models.CharField(max_length=20, choices=PRESET_CHOICES)
    age_range_min = models.IntegerField()
    age_range_max = models.IntegerField()
    enforce_age_limit = models.BooleanField(default=True)
    max_per_age = models.IntegerField(default=0)
    team_count = models.IntegerField()
    roster_size = models.IntegerField(default=0)
    phase = models.CharField(max_length=20, choices=PHASE_CHOICES, default="upload")

    # Scoring configuration stored as JSON
    scoring_weights = models.JSONField(default=dict)
    scoring_mode = models.CharField(
        max_length=20, choices=SCORING_MODE_CHOICES, default="pre-weighted"
    )

    # Team formation mode (immutable after creation)
    # live-draft: Traditional draft where teams take turns picking
    # league-generated: Auto-assignment algorithm creates balanced teams
    mode = models.CharField(
        max_length=20, choices=MODE_CHOICES, default="live-draft"
    )

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    completed_at = models.DateTimeField(null=True, blank=True)

    # Use tenant-aware manager
    objects = TenantManager()

    class Meta:
        db_table = "divisions"
        ordering = ["-created_at"]

    def __str__(self):
        return self.name

    # Backwards compatibility alias
    @property
    def league(self):
        return self.organization

    @league.setter
    def league(self, value):
        self.organization = value


# -----------------------------------------------------------------------------
# Team Model
# -----------------------------------------------------------------------------


class Team(models.Model):
    """Team within a division."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    division = models.ForeignKey(
        Division, on_delete=models.CASCADE, related_name="teams"
    )
    name = models.CharField(max_length=100, blank=True)  # Display/sponsor name
    draft_position = models.IntegerField()
    total_score = models.FloatField(default=0)

    # Coach assignments - persist with division
    head_coach = models.CharField(max_length=100, blank=True)  # Manager's name
    assistant_coach = models.CharField(max_length=100, blank=True)  # Single assistant

    # Age breakdown stored as JSON: {"10": 3, "11": 4, "12": 2}
    age_breakdown = models.JSONField(default=dict)

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "teams"
        ordering = ["draft_position"]

    def __str__(self):
        return self.name or f"Team {self.draft_position}"


class Player(models.Model):
    """Player in a division."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    division = models.ForeignKey(
        Division, on_delete=models.CASCADE, related_name="players"
    )
    bib = models.CharField(max_length=20)  # Unique ID from evaluation day
    first_name = models.CharField(max_length=100)
    last_name = models.CharField(max_length=100)
    name = models.CharField(max_length=200)  # Full name

    # Raw Component Scores
    field_score = models.FloatField(default=0)
    throw_score = models.FloatField(default=0)
    hit_power = models.FloatField(default=0)
    hit_form = models.FloatField(default=0)
    hit_contact = models.FloatField(default=0)
    pitching_strength = models.FloatField(default=0)
    pitching_form = models.FloatField(default=0)
    catch_score = models.FloatField(default=0)
    running_score = models.FloatField(default=0)

    # Calculated Subtotals
    fielding_subtotal = models.FloatField(default=0)
    hitting_subtotal = models.FloatField(default=0)
    pitching_subtotal = models.FloatField(default=0)
    subjective_total = models.FloatField(default=0)
    objective_total = models.FloatField(default=0)
    official_adjust = models.FloatField(default=0)

    # Totals and ranking
    total_score = models.FloatField(default=0)
    rank = models.IntegerField(default=0)
    projected_round = models.IntegerField(default=1)

    # Player Info
    little_league_age = models.IntegerField()
    birthday = models.CharField(max_length=20)
    is_all_star = models.BooleanField(default=False)
    is_dne = models.BooleanField(default=False)  # Did Not Evaluate

    # Draft Rules
    is_coach_kid = models.BooleanField(default=False)
    coach_team = models.ForeignKey(
        Team,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="coach_kids",
    )
    sibling = models.CharField(max_length=200, blank=True)  # Display name of sibling
    sibling_id = models.UUIDField(null=True, blank=True)  # ID of linked sibling

    # Locked assignments
    locked_to_round = models.IntegerField(null=True, blank=True)
    locked_to_team = models.ForeignKey(
        Team,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="locked_players",
    )

    # Team Builder fields (for league-generated mode)
    # These are only used during auto-assignment, not for live drafts
    coach_request = models.CharField(max_length=200, blank=True)  # Raw coach name request
    teammate_requests = models.JSONField(default=list, blank=True)  # Raw teammate name requests
    school = models.CharField(max_length=200, blank=True)
    grade = models.IntegerField(null=True, blank=True)

    # Draft Status
    is_drafted = models.BooleanField(default=False)
    drafted_by_team = models.ForeignKey(
        Team,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="roster",
    )
    drafted_in_round = models.IntegerField(null=True, blank=True)
    drafted_at_pick = models.IntegerField(null=True, blank=True)

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "players"
        ordering = ["rank"]
        constraints = [
            models.UniqueConstraint(
                fields=["division", "bib"], name="unique_player_bib_per_division"
            )
        ]

    def __str__(self):
        return self.name

    def save(self, *args, **kwargs):
        # Auto-generate full name
        self.name = f"{self.first_name} {self.last_name}"
        super().save(*args, **kwargs)


class DraftState(models.Model):
    """Draft state for a division."""

    DRAFT_FORMAT_CHOICES = [
        ("straight", "Straight"),
        ("snake", "Snake"),
        ("recalculated", "Recalculated"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    division = models.OneToOneField(
        Division, on_delete=models.CASCADE, related_name="draft_state"
    )

    draft_format = models.CharField(max_length=20, choices=DRAFT_FORMAT_CHOICES)

    # Draft order stored as JSON arrays of team IDs
    draft_order = models.JSONField(default=list)
    current_round_order = models.JSONField(default=list)

    current_round = models.IntegerField(default=1)
    current_pick_in_round = models.IntegerField(default=1)
    current_team = models.ForeignKey(
        Team,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="current_for_draft",
    )
    is_draft_complete = models.BooleanField(default=False)

    # Mandatory pick info
    mandatory_player = models.ForeignKey(
        Player,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="mandatory_for_draft",
    )
    mandatory_reason = models.CharField(max_length=20, blank=True)
    mandatory_sibling_name = models.CharField(max_length=200, blank=True)

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "draft_states"

    def __str__(self):
        return f"Draft for {self.division.name}"


class DraftPick(models.Model):
    """Individual draft picks."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    draft_state = models.ForeignKey(
        DraftState, on_delete=models.CASCADE, related_name="picks"
    )

    round = models.IntegerField()
    pick = models.IntegerField()  # Overall pick number
    team_id = models.UUIDField()
    player_id = models.UUIDField(null=True, blank=True)
    was_skipped = models.BooleanField(default=False)

    timestamp = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "draft_picks"
        ordering = ["pick"]
        constraints = [
            models.UniqueConstraint(
                fields=["draft_state", "round", "pick"],
                name="unique_pick_per_draft_round",
            )
        ]

    def __str__(self):
        return f"Round {self.round}, Pick {self.pick}"


# -----------------------------------------------------------------------------
# Evaluation Template Model
# -----------------------------------------------------------------------------


class EvaluationTemplate(models.Model):
    """Configurable evaluation template with stations, coach categories, and blend weights.

    Supports versioning via copy-on-write: when a locked template is edited,
    a new version (new row) is created with parent_template pointing to the
    original.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    organization = models.ForeignKey(
        Organization,
        on_delete=models.CASCADE,
        related_name="evaluation_templates",
    )
    name = models.CharField(max_length=200)
    description = models.TextField(blank=True, default="")
    version = models.IntegerField(default=1)
    parent_template = models.ForeignKey(
        "self",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="child_versions",
    )

    # Template content stored as JSON
    stations = models.JSONField(default=list)
    coach_categories = models.JSONField(default=list)
    blend_weights = models.JSONField(default=dict)

    is_active = models.BooleanField(default=True)
    is_locked = models.BooleanField(default=False)

    created_by = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "evaluation_templates"
        ordering = ["-updated_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["organization", "name", "version"],
                name="unique_template_version",
            )
        ]

    def __str__(self):
        return f"{self.name} v{self.version}"


# -----------------------------------------------------------------------------
# Season Model
# -----------------------------------------------------------------------------


class Season(models.Model):
    """Season linked to an evaluation template."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    organization = models.ForeignKey(
        Organization,
        on_delete=models.CASCADE,
        related_name="seasons",
    )
    name = models.CharField(max_length=100)
    year = models.IntegerField()
    template = models.ForeignKey(
        EvaluationTemplate,
        on_delete=models.PROTECT,
        related_name="seasons",
    )
    is_active = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "seasons"
        ordering = ["-year", "-created_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["organization", "name"],
                name="unique_season_name_per_org",
            )
        ]

    def __str__(self):
        return self.name


# -----------------------------------------------------------------------------
# Coach Rating Model
# -----------------------------------------------------------------------------


class CoachRating(models.Model):
    """A coach's rating of a player for a season.

    Scores stored as JSONField keyed by coach category ID from the season's template.
    Supports draft (partial scores) and submitted (all scores complete) statuses.
    """

    STATUS_CHOICES = [
        ("draft", "Draft"),
        ("submitted", "Submitted"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    season = models.ForeignKey(
        Season,
        on_delete=models.CASCADE,
        related_name="coach_ratings",
    )
    coach = models.ForeignKey(
        User,
        on_delete=models.CASCADE,
        related_name="coach_ratings",
    )
    # Player identity (name-based, since ratings happen pre-draft before Player model is populated)
    player_first_name = models.CharField(max_length=100)
    player_last_name = models.CharField(max_length=100)
    # Optional link to Player model (for later cross-referencing in Phase 5)
    player_id = models.UUIDField(null=True, blank=True)

    # Scores keyed by coach category ID from template
    # e.g. {"uuid-fielding": 4, "uuid-baseball-iq": 3, "uuid-hustle": 5}
    scores = models.JSONField(default=dict)

    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default="draft")

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    submitted_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "coach_ratings"
        ordering = ["player_last_name", "player_first_name"]
        constraints = [
            models.UniqueConstraint(
                fields=["season", "coach", "player_first_name", "player_last_name"],
                name="unique_coach_rating_per_player_season",
            )
        ]

    def __str__(self):
        return f"{self.coach.email} -> {self.player_first_name} {self.player_last_name}"


class Trade(models.Model):
    """Post-draft trades."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    draft_state = models.ForeignKey(
        DraftState, on_delete=models.CASCADE, related_name="trades"
    )

    team1_id = models.UUIDField()
    team2_id = models.UUIDField()
    player1_id = models.UUIDField()  # Moving FROM team1 TO team2
    player2_id = models.UUIDField()  # Moving FROM team2 TO team1
    reason = models.TextField()

    timestamp = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "trades"
        ordering = ["timestamp"]

    def __str__(self):
        return f"Trade at {self.timestamp}"


class RateLimitCounter(models.Model):
    """Fixed-window request counter shared by all API processes for rate limiting."""

    key = models.CharField(max_length=64, primary_key=True)
    count = models.PositiveIntegerField(default=0)
    expires_at = models.DateTimeField(db_index=True)

    class Meta:
        db_table = "rate_limit_counters"

    def __str__(self):
        return f"{self.key}: {self.count}"
