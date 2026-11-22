# League access and workflows

**The league runs the draft; coaches and viewers follow it.** The league owns its
teams and rosters after the draft. Coaches do not edit teams, swap players,
undo picks, or reopen the draft.

## Before this change

- Django distinguishes league admin, coach, and viewer memberships. Shared
  draft, Team Builder, player, and team writes already require a league admin.
- The app previously sent all three roles through the same division setup,
  draft, and results screens. Coaches could see Start, Reset, Assign Team
  Names, and Make Trade even though the corresponding writes would be denied.
- The draft board's `?view=public` switch hid some controls on the board, but
  didn't make the division list or other screens read-only. Its refresh
  mechanism listened for changes to local storage, which the API-backed app
  no longer uses for draft state.

## Simplified model

| Task | League admin | Coach | Viewer |
| --- | --- | --- | --- |
| Find a shared division | Create, open, or delete | Open read-only | Open read-only |
| Prepare a division | Import and review players, configure teams and draft order, or generate teams | See setup status | See setup status |
| Live draft | Run picks, skip, undo, and manage completion | Follow the current pick, player list, and rosters | Same board as coach |
| Completed draft or generated teams | Review and export results; edit teams and trade where supported | View and download rosters | View and download rosters |
| League settings | Manage membership, invites, join links, and evaluation setup | View members and manage own profile | View members and manage own profile |
| Coach ratings API | Admin access as defined by season and rating endpoints | Create, edit, and submit own ratings as allowed | No rating access |

A coach or viewer sees **View Division**, **View Draft**, or **View Rosters**
instead of Start or Resume. The live board refreshes from the API every five
seconds in a visible tab, doesn't interrupt the viewer with operator dialogs,
and switches to team rosters at completion. The roster download is score-free.

## Boundaries

- The management decision uses the role in the division's league, not an
  admin role somewhere else. The API remains the authorization boundary.
- Presentation mode is a display preference for an authenticated user, not
  a guest role or a separate data-access boundary. It hides scores and
  management actions in the UI; it does not change the API payload.
- Personal divisions are separate from league divisions; the app does not
  offer a personal creation shortcut to coach-only or viewer-only members.
  This change does not grant new draft workflows to personal owners, change
  existing server permissions, or change the platform administrator role.
- No role migration or new per-team role is needed. Explicit multi-league
  switching and any change to which evaluation data members can read are
  separate product decisions.
