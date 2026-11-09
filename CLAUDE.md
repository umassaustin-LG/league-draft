# CLAUDE.md - AI Assistant Context

This file provides context for AI assistants working on this codebase.

## Project Overview

**Little League Draft Application** - A React/TypeScript web app for managing Little League baseball drafts. Handles player imports, scoring, draft execution with rule enforcement, and result exports.

## Key Concepts

### Division
Top-level container. Presets: Majors (10-12), AAA (8-10), AA (7-10), Custom. Each division has its own teams, players, and draft state.

### Player
Imported from CSV, Excel, or dual CSV flow. Has skill scores, total score, rank, and flags (isCoachKid, siblingId, isAllStar, isDNE). Draft status tracked via isDrafted, draftedByTeamId, draftedInRound, draftedAtPick.

- `sibling`: Text field from CSV (display name of sibling - raw import data)
- `siblingId`: Actual link to another player (set when siblings are confirmed/linked)

### Team
Has name, roster (drafted players), totalScore, draftPosition, coachKids array, assistantCoaches, and ageBreakdown.

### Draft Formats
- **Straight**: 1-8, 1-8, 1-8...
- **Snake**: 1-8, 8-1, 1-8, 8-1...
- **Recalculated**: Lowest roster score picks first each round

### Mandatory Picks
- **Coach's kids**: Must be drafted by assigned team in their projected round (or lockedToRound if bumped due to conflicts)
- **Siblings**: When one is drafted, team must draft the other in the sibling's projected round (locked via lockedToTeamId, respects projectedRound/lockedToRound)

## Architecture

### App Phases
`upload` → `mapping` → `review` → `config` → `draft` → `complete`

### Backend (Django Core)
- **Function-based views**: Plain Django views with `@require_http_methods` decorators (not DRF)
- **Multi-tenant architecture**: League is the tenant model
- **LeagueMembership**: Users can belong to multiple leagues with roles (admin/member)
- **TenantMiddleware**: Injects `request.league` based on user's membership or X-League-ID header
- **Session-based auth**: Django sessions with CSRF protection
- **Rate limiting**: `RateLimiter` in `server/draft/views/helpers.py`, with counters in a shared DB table (`RateLimitCounter`) keyed by client IP (`get_client_ip`, which honors `NUM_TRUSTED_PROXIES`) and, for login failures and reset emails, by account
- **Session timeout**: 24-hour expiration (SESSION_COOKIE_AGE)

### State Management
- `useDivisions` hook: Division CRUD via API. `updateActiveDivision` persists teams via `saveTeamsToApi` and players via `savePlayersToApi`
- `useDraft` hook: Draft state, pick logic, undo, mandatory pick checks via API
- `useEvaluationImport` hook: Excel workbook processing
- `AuthContext`: User authentication state

### Key Files

| File | Purpose |
|------|---------|
| `src/App.tsx` | Main orchestration, phase routing, state coordination |
| `src/api/client.ts` | API client with snake_case/camelCase transformations |
| `src/contexts/AuthContext.tsx` | Authentication state, login/logout/register |
| `src/hooks/useDraft.ts` | Draft state machine, pick validation, startDraft, draftPlayer, undoLastPick |
| `src/hooks/useDivisions.ts` | Division CRUD via API |
| `src/utils/draftLogic.ts` | getMandatoryPick, lockSiblingToTeam, getBestAvailable |
| `src/utils/simulation.ts` | runSimulation, getSimulationStats |
| `src/utils/exports.ts` | generatePublicRosters, generateOfficialRecord, generateSimulationDraftBoard |
| `src/utils/draftOrder.ts` | calculateDraftOrder for all three formats |
| `src/utils/evaluationProcessor.ts` | Excel to Player conversion, score normalization |
| `src/utils/teamUtils.ts` | Team display name helpers |
| `src/types/index.ts` | All TypeScript interfaces (Player, Team, Division, DraftState, etc.) |
| `src/components/PlayerReviewTable.tsx` | Spreadsheet-style table for CSV player review |
| `src/components/DraftBoard.tsx` | Main draft interface with header, round order, drawer toggle, modals |
| `src/components/draft/DraftBoardPlayerGrid.tsx` | Available players table view (sortable, searchable, with flags and draft buttons) |
| `src/components/draft/DraftBoardRosterView.tsx` | Round-by-round roster grid (teams as columns, shows drafted/pre-filled/current pick) |
| `src/contexts/ViewContext.tsx` | Admin/Public view mode context for draft board |
| `server/draft/models.py` | Django models: League, User, LeagueMembership, LeagueInvitation, Division, Team, Player, DraftState |
| `server/draft/views/` | Function-based Django views organized by domain (auth, divisions, players, teams, draft, leagues) |
| `server/draft/transformers.py` | Data transformers for snake_case/camelCase conversion between API and frontend |
| `server/draft/services.py` | Draft business logic (start, pick, undo, trade) |
| `server/draft/middleware.py` | TenantMiddleware for multi-tenancy |
| `server/draft/views/helpers.py` | View helpers, `get_client_ip`, `RateLimiter` and `rate_limit` decorator |
| `server/draft/validators.py` | Custom password validators (StrongPasswordValidator) |
| `src/utils/passwordValidation.ts` | Client-side password validation matching Django validators |
| `src/components/profile/*.tsx` | Profile page, member management, invitations |
| `src/components/JoinPage.tsx` | League invitation acceptance flow |
| `src/components/evaluation/CSVImportFlow.tsx` | Dual CSV import orchestration (upload → verify → mapping) |
| `src/components/evaluation/DualCSVUpload.tsx` | Two-step CSV upload for eval + registration |
| `src/components/evaluation/CSVVerificationStep.tsx` | Match/exclude/DNE player verification UI |

### Component Hierarchy
```
App
├── LoginPage / RegisterPage (if not authenticated)
├── ForgotPasswordPage / ResetPasswordPage (password reset flow)
├── JoinPage (league invitation acceptance)
├── ProfilePage (settings mode)
│   ├── MembersTab (league member management)
│   ├── InviteModal / JoinLinkSection (invitations)
│   ├── ProfileTab (edit profile)
│   └── ChangePasswordModal
├── DivisionSelector / DivisionCreator
├── FileUpload → ColumnMapper (CSV flow)
├── EvaluationImport (Excel flow)
│   └── PlayerSummaryTable, DetectionModal
├── CSVImportFlow (Dual CSV flow with registration verification)
│   ├── DualCSVUpload (upload eval + registration CSVs)
│   └── CSVVerificationStep (match players, exclude/DNE)
├── PlayerReview (CSV flow)
│   └── PlayerReviewTable (spreadsheet-style table)
├── DraftConfig
│   └── SimulationModal
├── DraftBoard (main draft interface)
│   ├── Header: pick counter, current/next team, age breakdown, mandatory pick alert
│   ├── Round Order Display: horizontal team cards with pick states
│   ├── Drawer Toggle: switch between players/rosters views
│   ├── DraftBoardPlayerGrid (available players - sortable table with search, flags, draft buttons)
│   ├── DraftBoardRosterView (team rosters - round×team grid with drafted/pre-filled/current states)
│   ├── Round Interstitial Modal (between-round order display)
│   └── Draft Complete Modal (finalization prompt)
└── DraftComplete
    ├── Team Balance metrics (Top 8 / Full Roster toggle)
    ├── Export options (Public Rosters CSV, Official Record CSV)
    └── TradeModal
```

## Data Flow

### Import → Draft
1. CSV/Excel/Dual CSV uploaded and parsed
2. For dual CSV: Registration verification (match players, exclude unregistered, add DNE)
3. Column mapping (for CSV flows) - maps all columns to Player fields
4. Players created with scores calculated
5. Coach's kids and siblings detected/confirmed
6. Teams configured with names and draft order
7. Draft started with resolvedPlayers (lockedToRound set for conflicts)
8. Each pick updates player.isDrafted, team.roster, checks for mandatory picks

### Dual CSV Import Flow
1. Upload evaluation CSV (BIB, First, Last, scores) + registration CSV (First, Last)
2. CSVVerificationStep matches players by name (exact + fuzzy Levenshtein matching)
3. User can exclude evaluated players not in registration (default: excluded)
4. User can add registered players without evaluations as DNE (score 0)
5. After verification, goes to normal column mapping flow
6. handleMappingComplete filters excluded rows and adds DNE players

### Simulation
Uses same logic as real draft but on cloned data. Returns SimulationResult with teams and players.

## Coding Patterns

### React Patterns
- Functional components with hooks
- useCallback for stable function references
- useMemo for computed values
- useEffect for side effects and sync

### TypeScript
- Strict typing throughout
- Interfaces in `types/index.ts`
- Type guards where needed

### State Updates
Draft state uses functional updates: `setDraftState(prev => ({ ...prev, ... }))`

## Common Tasks

### Adding a new export format
1. Add function to `src/utils/exports.ts`
2. Call from appropriate component (SimulationModal, DraftComplete)
3. Use `downloadCSV()` or `downloadTextFile()` helper

### Adding a draft rule
1. Update `getMandatoryPick()` in `draftLogic.ts`
2. Handle in `useDraft.ts` draftPlayer callback
3. Display warning in `DraftBoard.tsx`

### Modifying simulation
1. Update `runSimulation()` in `simulation.ts`
2. Simulation uses same `getMandatoryPick`, `lockSiblingToTeam`, `getBestAvailable`

### Adding player fields
1. Add to `Player` interface in `types/index.ts`
2. Update CSV parsing in `csvParser.ts`
3. Update Excel processing in `evaluationProcessor.ts`
4. Display in PlayerReview and DraftBoard

## Backend Development

### Running the Backend
```bash
docker compose up -d          # Start API + PostgreSQL
docker compose logs -f api    # View API logs
docker compose exec api python manage.py shell  # Django shell
docker compose down           # Stop services
```

### Database Migrations
```bash
docker compose exec api python manage.py makemigrations
docker compose exec api python manage.py migrate
```

### Key Backend Concepts

**Multi-tenancy:**
- League is the tenant model
- LeagueMembership links users to leagues with roles (admin/member)
- TenantMiddleware sets `request.league` from user's membership
- Division views filter by `request.league`

**Auth Flow:**
- GET `/api/auth/csrf/` - Initialize CSRF token cookie (call on app load)
- POST `/api/auth/register/` - Creates user + optional league + membership
- POST `/api/auth/login/` - Session login
- POST `/api/auth/logout/` - End session
- GET `/api/auth/me/` - Current user with leagues array
- PATCH `/api/auth/me/` - Update profile (name only; email is read-only)
- POST `/api/auth/change-password/` - Change password
- POST `/api/auth/password-reset/` - Request password reset email (rate limited: 3/hr)
- POST `/api/auth/password-reset/confirm/` - Confirm password reset

**Security Features:**
- Rate limiting on auth endpoints (5/min per IP for login/register, 3/hr per IP and per email for password reset, 10 failed logins/hr per account)
- Client IP comes from `REMOTE_ADDR` unless `NUM_TRUSTED_PROXIES` is set (k8s sets 1 for ingress-nginx); then the X-Forwarded-For entry added by the outermost trusted proxy is used
- Session timeout after 24 hours (SESSION_COOKIE_AGE = 86400)
- CSRF protection with cookie-based tokens
- Password validation: min 8 chars, not entirely numeric, not common passwords
- Email changes disabled (read-only field) to prevent account takeover

**League Member Management:**
- GET `/api/leagues/{id}/members/` - List league members
- DELETE `/api/leagues/{id}/members/{user_id}/` - Remove member
- PATCH `/api/leagues/{id}/members/{user_id}/role/` - Change member role

**Invitations:**
- GET/POST `/api/leagues/{id}/invitations/` - List/create email invitations
- DELETE `/api/leagues/{id}/invitations/{id}/` - Cancel invitation
- POST `/api/invitations/accept/` - Accept email invitation
- GET/POST/DELETE `/api/leagues/{id}/join-link/` - Manage join link
- GET `/api/leagues/join/{token}/` - Get league info from join token (public)
- POST `/api/leagues/join/{token}/` - Join via link

## Testing Approach

### E2E Tests (Playwright)
Located in `e2e/draft-flow.spec.ts`. Run with:
```bash
npx playwright test
```

Tests cover:
- Complete draft workflow from CSV import through completion
- DNE player handling
- Sibling rule enforcement

### Manual Verification
1. `npm run build` - Must pass without errors
2. `docker compose up -d` - Start backend
3. `npm run dev` - Test in browser
4. Test all phases: import → review → config → draft → complete
5. Verify coach's kid and sibling rules work
6. Test simulation and exports

## Important Implementation Notes

### API Mode vs localStorage Mode
- Controlled by `VITE_USE_API` env var
- API mode: All data persisted to PostgreSQL via Django API
- localStorage mode: Data stored in browser (legacy, for offline use)
- `useDraft.ts` and `useDivisions.ts` handle both modes

### Draft State ID
- `DraftState.id` must be captured from API responses
- Stored in `draftStateId.current` ref in `useDraft.ts`
- Required for all draft operations (pick, undo, trade)
- Without it, draft falls back to localStorage mode

### Player Data Persistence
- Players must be saved to API when exiting Review phase
- `savePlayersToApi()` called in `handleReviewComplete`
- Includes coach kid assignments (`coachTeamId`) and sibling links (`siblingId`)
- Sibling IDs remapped during bulk create (old frontend IDs → new DB UUIDs)

### Browser History
- Back button handled via popstate listener
- Re-pushes state to prevent navigation (keeps user in app)
- Prevents data loss from accidental back navigation

## Team Builder Feature (In Development)

The Team Builder is an alternative to live drafts for younger divisions (AA, etc.) where teams are auto-assigned rather than drafted.

### Team Builder Flow
`setup` → `import` → `resolution` → `confirm-requests` → `configure` → `generate` → `results`

### Key Files

| File | Purpose |
|------|---------|
| `src/components/TeamBuilderFlow.tsx` | Main orchestration for Team Builder steps |
| `src/components/teamBuilder/TeamBuilderResults.tsx` | Results display with happiness indicators and search |
| `src/components/teamBuilder/NameMatchResolver.tsx` | UI for resolving unmatched player names |
| `src/components/teamBuilder/RequestConfirmation.tsx` | UI for reviewing/confirming request matches with confidence scores |
| `src/components/teamBuilder/TradeSuggestions.tsx` | UI for applying suggested balance trades |
| `src/utils/teamBuilderAlgorithm.ts` | Assignment algorithms (balance-first and requests-first) |
| `src/utils/teamBuilderParser.ts` | Request parsing, name matching, normalization, cluster building |

### Division Mode
- `mode: 'live-draft' | 'league-generated'` on Division (set at creation, immutable)
- Live Draft → existing draft flow
- League Generated Teams → Team Builder flow

### Algorithm Modes

**Requests-First (Recommended)**
Prioritizes request satisfaction over balance:
1. **Locked Placements**: Coach kids, assistant coach kids, siblings
2. **Cluster Placement**: Two-way request clusters placed together on same team
3. **Request-Based Placement**: Remaining players placed to maximize request satisfaction
4. **Balance via Trading**: Suggested trades to improve balance without breaking satisfied requests

**Balance-First (Original)**
1. **Locked Placements**: Coach kids, assistant coach kids, siblings
2. **Top Talent Distribution**: Spread top N players by score for balance
3. **Request-Based Placement**: Honor two-way friends > one-way friends > coach requests > school clustering
4. **Balance-Based**: Remaining players assigned to lowest-scoring teams

### Request Resolution & Confirmation
- **Coach requests**: Match to coach names (exact or fuzzy)
- **Teammate requests**: Parse comma/space-delimited names, resolve to players
- **Two-way detection**: Both players requested each other (higher priority)
- **Confidence scoring**: Auto-confirm (≥90%), needs-review (50-90%), unresolvable (<50%)
- **Request status**: `auto-confirmed` | `needs-review` | `user-confirmed` | `unresolvable`

### Request Clusters (Union-Find)
- Two-way requests form clusters (A↔B + B↔C = cluster {A,B,C})
- Clusters placed together on same team when possible
- Oversized clusters auto-split at weakest connection

### Trade Suggestions
- After requests-first assignment, system suggests trades to improve balance
- Only "tradeable" players eligible: those with no requests OR all requests satisfied
- Trades shown with balance improvement score
- Apply individually or all at once

### Player Happiness Scores
- 🟢 All requests honored
- 🟡 Some requests honored
- 🔴 No requests honored
- ⚪ No requests made

### Key Types
- `ResolvedRequest`: Request with confidence score and resolution status
- `RequestsFirstConfig`: Configuration for requests-first algorithm
- `RequestCluster`: Group of two-way connected players
- `TradeCandidate`: Suggested trade with balance improvement

### Key State
- `registrationPlayers`: Parsed from Registration Data tab (has requests, school, grade)
- `evalPlayers`: Parsed from eval tabs (has scores, bib numbers)
- `resolvedRequests`: Requests prepared for confirmation UI
- `normalizationResult`: Request resolution results with stats and warnings
- `algorithmResult`: Team assignments with happiness calculations
- `requestsFirstResult`: Extended result with clusters and suggested trades

### Data Flow
1. Registration Data + Eval tabs parsed from Excel
2. Players linked by First Name + Last Name matching
3. Requests parsed and resolved to actual players/coaches
4. **Request Confirmation**: User reviews/edits auto-resolved requests
5. Algorithm assigns players to teams (requests-first or balance-first)
6. **Trade Suggestions**: User can apply suggested trades for balance
7. Results show happiness indicators and allow manual swaps via TradeModal

## Branching

- `development` - Feature work
- `staging` - Testing
- `main` - Production
- `feature/team-builder` - Team Builder feature development
