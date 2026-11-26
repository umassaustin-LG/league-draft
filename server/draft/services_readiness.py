from collections import Counter

ROSTER_BALANCE_RATIO = 1.15


def team_display_name(team):
    return team.name or team.head_coach or f"Team {team.draft_position}"


class RuleCheckError(ValueError):
    def __init__(self, warnings):
        self.warnings = warnings
        super().__init__("Rule check failed: " + "; ".join(w["message"] for w in warnings if w["level"] == "block"))


def sibling_group(player, players):
    group = {player.id}
    while True:
        expanded = group | {p.id for p in players if p.sibling_id in group} | {
            p.sibling_id for p in players if p.id in group and p.sibling_id in {x.id for x in players}
        }
        if expanded == group:
            return [p for p in players if p.id in group and p.id != player.id]
        group = expanded


def draft_readiness(division):
    players = list(division.players.all())
    teams = list(division.teams.all())
    team_ids = {t.id for t in teams}
    by_id = {p.id: p for p in players}
    checks = []

    def add(id, title, problems, level="error"):
        checks.append({"id": id, "title": title, "level": level if problems else "ok",
                       "detail": "; ".join(problems) if problems else "Check passed"})

    add("teams", "Teams", [] if len(teams) == division.team_count and len(teams) >= 2 else ["Team count must match division settings and be at least 2"])
    add("roster_size", "Roster size", [] if division.roster_size > 0 else ["Roster size must be positive"])
    difference = division.team_count * division.roster_size - len(players)
    add("player_pool", "Player pool", [f"{difference} spots will be skipped"] if difference > 0 else ([f"{-difference} players won't fit"] if difference < 0 else []), "warning" if difference > 0 else "error")
    outside = [p.name for p in players if not division.age_range_min <= p.little_league_age <= division.age_range_max]
    add("age_range", "Age range", [", ".join(outside[:5]) + (f" and {len(outside)-5} more" if len(outside) > 5 else "")] if outside else [], "warning")
    ages = Counter(p.little_league_age for p in players)
    add("age_cap", "Age cap feasibility", [f"Age {age}: {count} players exceed capacity" for age, count in sorted(ages.items()) if division.enforce_age_limit and division.max_per_age > 0 and count > division.team_count * division.max_per_age])
    coach_errors = [f"{p.name} has no coach team in this division" for p in players if p.is_coach_kid and p.coach_team_id not in team_ids]
    for team in teams:
        owed = set()
        for p in players:
            if p.is_coach_kid and p.coach_team_id == team.id:
                owed.update([p.id] + [s.id for s in sibling_group(p, players)])
        if len(owed) > division.roster_size:
            coach_errors.append(f"{team_display_name(team)} has more coach kids and siblings than roster spots")
    add("coach_kids", "Coach kids", coach_errors)
    sibling_errors, sibling_warnings = [], []
    for p in players:
        if not p.sibling_id:
            continue
        sibling = by_id.get(p.sibling_id)
        if sibling is None:
            sibling_errors.append(f"{p.name} links to a missing or other-division sibling")
        elif sibling.sibling_id != p.id:
            sibling_warnings.append(f"{p.name}'s sibling link is not reciprocal")
        coaches = {s.coach_team_id for s in [p] + sibling_group(p, players) if s.is_coach_kid and s.coach_team_id}
        if len(coaches) > 1:
            sibling_errors.append(f"{p.name}'s siblings have coach kids assigned to different teams")
    add("siblings", "Sibling assignments", sibling_errors)
    add("sibling_links", "Reciprocal sibling links", sibling_warnings, "warning")
    dne = sum(p.is_dne for p in players)
    add("dne", "DNE players", [f"{dne} DNE players"] if dne else [], "warning")
    return {"ready": not any(c["level"] == "error" for c in checks), "checks": checks}


def evaluate_pick(draft_state, player, team):
    division = draft_state.division
    team_name = team_display_name(team)
    players = list(division.players.all())
    roster = [p for p in players if p.is_drafted and p.drafted_by_team_id == team.id]
    warnings = []
    mandatory = draft_state.mandatory_player_id == player.id

    def add(code, level, message):
        warnings.append({"code": code, "level": "warn" if mandatory else level, "message": message})

    age_count = sum(p.little_league_age == player.little_league_age for p in roster)
    if division.enforce_age_limit and division.max_per_age > 0:
        if age_count >= division.max_per_age:
            add("age_cap", "block", f"{team_name} already has the maximum players of age {player.little_league_age}")
        elif age_count + 1 == division.max_per_age:
            add("age_cap", "warn", f"This pick reaches the age {player.little_league_age} cap")
    if not division.age_range_min <= player.little_league_age <= division.age_range_max:
        add("age_range", "warn", f"{player.name} is outside the division age range")
    group = sibling_group(player, players)
    for sibling in group:
        if sibling.is_coach_kid and sibling.coach_team_id and sibling.coach_team_id != team.id:
            coach_team_name = team_display_name(sibling.coach_team)
            warnings.append({"code": "sibling_coach_conflict", "level": "block", "message":
                f"{player.name.strip()}'s sibling {sibling.name.strip()} is {coach_team_name}'s coach kid — drafting splits them; {coach_team_name} should take {player.name.strip()}"})
    siblings = [p for p in group if not p.is_drafted and not p.locked_to_team_id
                and not (p.is_coach_kid and p.coach_team_id and p.coach_team_id != team.id)]
    owed = {p.id for p in players if not p.is_drafted and p.id != player.id and ((p.is_coach_kid and p.coach_team_id == team.id) or p.locked_to_team_id == team.id)} | {p.id for p in siblings}
    remaining = division.roster_size - draft_state.picks.filter(team_id=team.id).count() - 1
    if siblings and remaining < len(owed):
        add("sibling_capacity", "block", f"{team_name} lacks remaining picks for mandatory players and siblings")
    for sibling in siblings:
        add("sibling_lock", "warn", f"Drafting {player.name} locks sibling {sibling.name} to {team_name} in round {sibling.locked_to_round or sibling.projected_round}")
    drafted = [p for p in players if p.is_drafted]
    if len(roster) + 1 >= 2 and len(drafted) + 1 >= division.team_count:
        league_average = (sum(p.total_score for p in drafted) + player.total_score) / (len(drafted) + 1)
        average = (sum(p.total_score for p in roster) + player.total_score) / (len(roster) + 1)
        if average > ROSTER_BALANCE_RATIO * league_average:
            add("roster_balance", "warn", f"{team_name}'s average score exceeds 115% of the league average")
    return warnings
