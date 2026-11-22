# ElevenLabs backend integration

Set `ELEVENLABS_API_KEY` in the backend environment (or `server/.env`); it is
optional and must never be exposed through a `VITE_` variable. For Docker Compose,
export it in the shell or use `docker compose --env-file .env.local up -d`.
In Kubernetes, replace the empty environment entry with a Secret reference.

Organization/league admins and master admins can POST `/api/elevenlabs/token/` with the normal session
cookie and CSRF header (no body required). It returns `{"token": "..."}`, a
time-limited, single-use `realtime_scribe` credential, not the API key. Tokens are
not cached; issuance is limited to 10 requests/minute per client IP. This endpoint
is admin-only: coaches/viewers receive 403. Organization admins need an active
organization context (use `X-Organization-ID` when needed); master admins do not.
Missing configuration
returns 503; upstream failures return a generic 502 without provider details.

The draft board's voice copilot uses `POST /api/divisions/<id>/voice-copilot/token/`
instead. It returns the same kind of token, but only to users who can manage that
division (league admins, master admins, or the owner of a personal division).
Coaches and viewers get 403, and users outside the league get 404. The copilot is
read-only: it answers questions about the live draft from the board's state (who is
on the clock, the next eligible player, why a player is blocked, team rosters, and
draft progress). It never drafts, skips, undoes or trades, and it turns those
requests away. Answers are read aloud with the browser's speech synthesis.

# Little League Draft Application

A comprehensive draft management system for Little League baseball divisions. Streamlines the entire draft process from player evaluation import through final team roster generation, with advanced features for handling coach's kids, siblings, and multiple draft formats.

## Features

### Multi-Division Support
- Create divisions with presets: **Majors** (ages 10-12), **AAA** (8-10), **AA** (7-10), or **Custom**
- Support for 5-10 teams per division
- Configurable age limits and max players per age group
- Independent draft states with full persistence

### Three Import Methods

**CSV Import:**
- Flexible column mapping interface
- Support for raw and pre-weighted scoring modes
- Auto-detection of common column names

**Excel Evaluation Workbooks:**
- Import multi-tab evaluation spreadsheets (Fielding, Hitting, Pitching, Fly Balls, Baserunning)
- Field-level scoring weights with real-time recalculation
- Auto-detection of coach's kids and siblings
- Direct team name and assistant coach assignment

**Dual CSV with Registration Verification:**
- Upload evaluation CSV + registration CSV
- Automatically matches players by name (exact and fuzzy matching)
- Exclude evaluated players not in registration list (unpaid/unregistered)
- Add registered players without evaluations as DNE (Did Not Evaluate) with 0 scores
- Ensures only eligible players are included in draft

### Pre-Draft Player Review
- Unified spreadsheet-style table view for both CSV and Excel imports
- Sortable columns (rank, round, name, age, scores)
- Inline cell editing for scores
- Search/filter by name or BIB number
- Row highlighting for coach's kids (blue) and siblings (green)
- Collapsible Teams & Detection panel
- Visual indicators for All-Stars, coach's kids, siblings, and DNE players
- Manual score adjustments with official override field

### Draft Configuration
- **Three Draft Formats:**
  - **Straight**: Standard rotation (1-8, 1-8, 1-8...)
  - **Snake**: Alternating direction (1-8, 8-1, 1-8...)
  - **Recalculated**: Lowest roster score picks first each round
- Drag-and-drop draft order with randomize option
- Team name and assistant coach setup
- Coach's kid team assignments

### Live Draft Board

The draft board provides a comprehensive interface for conducting live drafts with two switchable drawer views.

#### Main Header
- **Compact gradient header** with pick counter (R# · Pick X/Y) and current/next team display
- **Age breakdown badges** showing player count per age for current team (with color-coded limit warnings)
- **Mandatory pick banner** (yellow) alerts when coach's kid or sibling must be drafted
- **Pending draft confirmation banner** (blue) for confirming player selections
- **Best Available by Age** quick-pick buttons grouped by age (top 2 per age)
- **Admin controls**: Skip pick (final round only, disabled when all remaining players must be drafted), Undo, Reset

#### Round Order Display
- Horizontal team cards showing pick order for current round
- Visual states: current pick (blue highlight, "NOW" badge), past picks (grayed, strikethrough), upcoming
- Shows draft format label (straight/snake/recalculated)

#### Drawer View Toggle
Switch between two views using the toggle bar:

**Available Players View** (`DraftBoardPlayerGrid.tsx`)
- Sortable table with columns: Proj. Rnd, Rank, BIB, Name, Age, F/H/P/C/R scores, Total, Flags, Action
- Search by name or BIB number with clear button
- Available player count display
- Sorting: click column headers (score columns default to descending)
- Round column shows effective round (lockedToRound or projectedRound) with asterisk for overrides
- **Flag badges**: Lock+team (coach's kid/sibling locked), SIB (sibling unlocked), AS (All-Star), DNE (Did Not Evaluate), age limit warning
- Restricted players (coach's kids/siblings for other teams) shown with reduced opacity and red lock badge
- Draft buttons with mandatory pick highlighting (yellow for mandatory)
- Legend bar with flag explanations and score abbreviations

**Team Rosters View** (`DraftBoardRosterView.tsx`)
- Round-by-round grid with teams as columns, rounds as rows
- Teams sorted by current round order with position numbers
- Team headers show draft position, name, and total score
- **Cell states**:
  - **Drafted** (green): Shows player name, score, and lock icon if was locked
  - **Pre-filled** (blue dashed border): Undrafted players locked to team/round (coach's kids, siblings)
  - **Current pick** (yellow ring): Active pick position with "PICKING" label
  - **Empty**: Future picks awaiting selection
- Sticky round column for horizontal scrolling
- Legend bar explaining cell colors

#### Round Interstitial Modal
- Appears automatically when advancing to a new round
- Shows completed round celebration and new round number
- Displays new draft order with team positions and scores
- Format-specific messaging (snake reversal, recalculated by score)
- "Continue to Round X" button to dismiss

#### Draft Complete Modal
- Appears when all picks are made
- Shows total pick count
- Options: "Go Back & Review" or "Finalize Draft"

#### View Modes
- **League admin**: Runs the draft (pick, undo, reset, skip, confirm).
- **Coach and viewer**: Follow the live draft without draft controls.
- **Presentation view**: Sign-in required; read-only with scores hidden (`?view=public`).

### Draft Simulation
- Preview draft outcomes before committing
- Compare all three formats side-by-side
- Statistics: highest/lowest scores, spread, average
- Toggle coach's kid and sibling enforcement
- Export simulation results

### Post-Draft Features
- **Team Balance Metrics**:
  - Toggle between "Top 8 Picks" and "Full Roster" views
  - Shows highest, lowest, spread, and average team scores
  - Visual team rankings with color-coded indicators (green=highest, red=lowest)
  - Top 8 metric excludes late-round players for better core team comparison
- **Trade System**: Execute player swaps with reason tracking
- **Multiple Export Formats (CSV)**:
  - Public rosters (alphabetical with BIB numbers, no scores)
  - Official draft record (pick-by-pick with BIB numbers and flags)
  - Simulation draft boards (grid + sequential views with scores)
- Print-ready formatting and clipboard copy

### League Management
- **Multi-league support**: Users can belong to multiple leagues
- **Role-based access**: League admin, coach, and viewer roles per league
- **Roster ownership**: Only league admins can edit shared teams or trade players after the draft.
- **Member management**: Members can view the directory; league admins manage invitations and membership.
- **Invite system**: Email invitations or shareable join links
- **Profile management**: Update name and password
- See the [league access and workflow model](docs/league-access.md).

### Security
- **Session-based authentication**: Secure Django sessions with CSRF protection
- **Rate limiting**: Brute-force protection on login, registration, and password reset
- **Session timeout**: Automatic 24-hour session expiration
- **Role-based authorization**: Admin-only operations for trades, resets, and member management
- **Multi-tenant isolation**: Users can only access their league's data

### Data Persistence
- **Division saved immediately**: Divisions persist as soon as "Create Division" is clicked
- Resume at any point: Close browser and return to continue where you left off
- Automatic save after each action
- Resume incomplete drafts
- Division state snapshots
- Completion timestamps for archives

### Team Builder (League Generated Teams)
For younger divisions that don't use live drafts, the Team Builder automatically creates balanced teams while honoring requests:

- **Division Mode Selection**: Choose "Live Draft" or "League Generated Teams" at division creation
- **Excel Import**: Registration Data tab with coach/teammate requests, plus evaluation tabs
- **Request Confirmation Step**:
  - Review auto-resolved requests with confidence scores
  - High-confidence matches (≥90%) auto-confirmed
  - Ambiguous matches highlighted for review
  - Edit any match with inline search
  - Two-way detection (both kids requested each other)
- **Algorithm Modes**:
  - **Requests-First (Recommended)**: Prioritizes honoring friend requests, then balances via suggested trades
  - **Balance-First**: Traditional approach prioritizing team balance over requests
- **Requests-First Algorithm**:
  - Places two-way request clusters together on same team
  - Honors one-way requests and coach preferences
  - Suggests trades to improve balance without breaking satisfied requests
- **Trade Suggestions**: After assignment, review and apply suggested trades that improve balance
- **Happiness Indicators**: Visual status showing which requests were honored (🟢 all, 🟡 some, 🔴 none, ⚪ no requests)
- **Force Even Teams**: Option to ensure all teams have equal roster sizes (±1 player)
- **Player Search**: Search by name on Results page to see request details
- **Manual Adjustments**: Swap players using the trade module
- **Export**: Happiness report CSV with request fulfillment details

## Getting Started

### Prerequisites

- Node.js 18+
- Docker and Docker Compose (for backend)

### Installation

```bash
npm install
```

### Backend Setup

The application uses a Django REST Framework backend with PostgreSQL.

```bash
# Start backend services (API + PostgreSQL)
docker compose up -d

# Run database migrations
docker compose exec api python manage.py migrate

# Create a superuser (optional)
docker compose exec api python manage.py createsuperuser
```

The API will be available at `http://localhost:3001`.

### Frontend Development

```bash
npm run dev
```

Visit `http://localhost:5173` in your browser.

### Build for Production

```bash
npm run build
```

### Preview Production Build

```bash
npm run preview
```

### Stop Backend Services

```bash
docker compose down
```

## Import Formats

### CSV Format

| Column | Required | Description |
|--------|----------|-------------|
| First Name | Yes | Player's first name |
| Last Name | Yes | Player's last name |
| Little League Age | Yes | Player's LL age (7-12) |
| FIELDING SUBTOTAL | Yes | Fielding score |
| HITTING SUBTOTAL | Yes | Hitting score |
| PITCHING SUBTOTAL | Yes | Pitching score |
| CATCH SCORE | Yes | Catching ability |
| RUNNING Score | Yes | Running speed |
| Official Adjust | No | Manual adjustment |
| Birthday | No | Player's birthday |
| All-Star | No | TRUE/FALSE |
| DNE | No | Did Not Evaluate flag |
| Coach Kid | No | TRUE/FALSE |
| Sibling | No | Sibling's full name |

### Excel Evaluation Workbook

Expected tabs: `Fielding`, `Pitching`, `Hitting`, `Fly Balls`, `Baserunning`

Each tab should include:
- `BIB#` column for player identification
- `First Name`, `Last Name` columns
- Skill-specific score columns (Form, Arm Strength, Time, etc.)

## Draft Rules

### Coach's Kids
- Must be drafted by their assigned team
- Must be drafted in their projected round (based on rank)
- System blocks other picks until fulfilled
- Round bumping available for conflicts

### Siblings
- If one sibling is drafted, the team must draft the other in that sibling's projected round
- Prevents siblings from being separated while respecting their skill-based draft position
- Automatic locking when first sibling is picked (but mandatory pick only triggers in the sibling's projected round)

### Age Limits (Optional)
- Enforce maximum players per age group
- Configurable per division type
- Prevents roster imbalances

## Workflow

```
1. CREATE DIVISION → Select preset and team count
2. IMPORT PLAYERS → Upload CSV or Excel workbook
3. REVIEW & ADJUST → Edit scores, detect relationships
4. CONFIGURE DRAFT → Set format, order, team names
5. CONDUCT DRAFT → Live picks with rule enforcement
6. COMPLETE → View results, execute trades, export
```

## Technical Stack

| Component | Technology |
|-----------|------------|
| Frontend | React 18.2 |
| Language | TypeScript 5.2 |
| Build Tool | Vite 5.0 |
| Styling | Tailwind CSS 3.3 |
| Icons | lucide-react |
| CSV Parsing | papaparse |
| Excel Parsing | xlsx |
| State | React Hooks + Context |
| Backend | Django 5.2 + Django REST Framework |
| Database | PostgreSQL 16 |
| Auth | Session-based (Django sessions) |
| Container | Docker + Docker Compose |

## Project Structure

```
src/
├── App.tsx                    # Main app with phase routing
├── api/
│   └── client.ts              # API client with transformations
├── components/
│   ├── DivisionSelector.tsx   # Division management
│   ├── DivisionCreator.tsx    # New division setup
│   ├── FileUpload.tsx         # CSV upload
│   ├── ColumnMapper.tsx       # CSV column mapping
│   ├── PlayerReview.tsx       # Player review orchestration
│   ├── PlayerReviewTable.tsx  # Spreadsheet-style player table
│   ├── DraftConfig.tsx        # Draft configuration
│   ├── DraftBoard.tsx         # Live draft interface
│   ├── draft/
│   │   ├── DraftBoardPlayerGrid.tsx  # Sortable player table
│   │   └── DraftBoardRosterView.tsx  # Round-by-round roster grid
│   ├── DraftComplete.tsx      # Results and exports
│   ├── SimulationModal.tsx    # Draft simulation
│   ├── TradeModal.tsx         # Post-draft trades
│   ├── CompleteRosters.tsx    # Roster display
│   ├── LoginPage.tsx          # User login
│   ├── RegisterPage.tsx       # User registration
│   ├── ForgotPasswordPage.tsx # Password reset request
│   ├── ResetPasswordPage.tsx  # Password reset form
│   ├── JoinPage.tsx           # League invitation acceptance
│   ├── profile/               # Profile & league management
│   │   ├── ProfilePage.tsx    # Main profile page with tabs
│   │   ├── MembersTab.tsx     # League member list
│   │   ├── InviteModal.tsx    # Email invite form
│   │   ├── JoinLinkSection.tsx# Shareable join link management
│   │   ├── ProfileTab.tsx     # Edit user profile
│   │   └── ChangePasswordModal.tsx
│   ├── evaluation/            # Import components (Excel, dual CSV)
│   │   ├── CSVImportFlow.tsx      # Dual CSV import orchestration
│   │   ├── DualCSVUpload.tsx      # Eval + registration CSV upload
│   │   └── CSVVerificationStep.tsx # Match/exclude/DNE verification
│   └── teamBuilder/           # Team Builder components
│       ├── TeamBuilderResults.tsx  # Results with happiness indicators
│       ├── NameMatchResolver.tsx   # Unmatched name resolution UI
│       ├── RequestConfirmation.tsx # Review/confirm request matches
│       └── TradeSuggestions.tsx    # Balance trade suggestions UI
├── hooks/
│   ├── useDivisions.ts        # Division state (API mode)
│   ├── useDraft.ts            # Draft logic (API mode)
│   ├── useEvaluationImport.ts # Excel processing
│   └── usePlayerScoring.ts    # Score calculations
├── contexts/
│   ├── AuthContext.tsx        # Authentication state
│   └── ViewContext.tsx        # Admin/Public mode
├── types/
│   └── index.ts               # TypeScript interfaces
├── utils/
│   ├── csvParser.ts           # CSV operations
│   ├── draftOrder.ts          # Order calculations
│   ├── draftLogic.ts          # Pick validation
│   ├── simulation.ts          # Simulation engine
│   ├── exports.ts             # Export formatting
│   ├── teamUtils.ts           # Team display helpers
│   ├── evaluationProcessor.ts # Excel processing
│   ├── teamBuilderAlgorithm.ts # Auto-assignment algorithm
│   └── teamBuilderParser.ts   # Request parsing & name matching
└── e2e/
    └── draft-flow.spec.ts     # Playwright E2E tests

server/
├── draft/
│   ├── models.py              # Django models (League, User, Division, Team, Player, etc.)
│   ├── views.py               # DRF ViewSets and auth views
│   ├── serializers.py         # DRF serializers
│   ├── services.py            # Draft business logic
│   ├── middleware.py          # Tenant middleware
│   ├── throttling.py          # Rate limiting classes
│   ├── validators.py          # Password validation
│   └── migrations/            # Database migrations
├── league_draft/
│   ├── settings.py            # Django settings
│   └── urls.py                # URL routing
├── Dockerfile                 # API container
└── docker-compose.yml         # Full stack setup
```

## Branching Strategy

| Branch | Purpose |
|--------|---------|
| `development` | Feature development and experimentation |
| `staging` | Graduated features ready for testing |
| `main` | Production-ready code |

## Browser Support

- Chrome/Edge (latest)
- Firefox (latest)
- Safari (latest)
- Mobile browsers (iOS Safari, Chrome Mobile)

## License

MIT
