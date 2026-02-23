"""Planner (Alex) — 24h task planning, dependency management, replanning."""

from __future__ import annotations

import json
import logging
from datetime import datetime
from pathlib import Path
from typing import Optional

from .config import NightBotConfig
from .llm import LLM
from .task import Task, TaskStatus

logger = logging.getLogger(__name__)

PLAN_PROMPT = """You are Alex, the planner for Night Bot.

Given the current state, create or update the 24-hour plan.

Current tasks in queue:
{tasks}

Past reports (summaries):
{reports}

Human decisions:
{decisions}

Team philosophy:
- Fast things first
- Working over perfect
- If uncertain, validate first

Output a JSON plan:
{{
  "tasks": [
    {{"id": "...", "name": "...", "type": "feasibility", "depends_on": [], "estimated_hours": 2, "status": "ready"}},
    ...
  ],
  "execution_order": ["id1", "id2", ...],
  "reasoning": "brief explanation of why this order"
}}

Only output the JSON, nothing else."""

REPLAN_PROMPT = """A scout just finished a task. Here's the report:

{report}

Current plan:
{current_plan}

Update the plan based on this result:
- Mark completed tasks
- If something failed, decide: retry differently, skip, or flag for human
- Update dependencies
- Drop tasks that are no longer relevant
- Add new tasks if the report suggests them

Output the updated JSON plan (same format as before).
Only output the JSON, nothing else."""

BRIEFING_PROMPT = """Generate a morning briefing in Markdown based on:

Current plan:
{plan}

Reports from last session:
{reports}

Pending decisions:
{decisions}

Format:
# Morning Briefing — {date}

## Status
(what's done, what's in progress, any blockers)

## Key Findings
(most important things from scout reports)

## Decisions Needed
(things that need human input, with brief context)

## Today's Recommended Actions
(what the human should do first)

Be concise. Respect the human's time."""


def create_plan(
    tasks: list[Task],
    config: NightBotConfig,
    llm: LLM,
    reports_dir: Optional[str | Path] = None,
    decisions_dir: Optional[str | Path] = None,
) -> dict:
    """Create a new 24h plan from current tasks."""
    
    # Gather context
    tasks_str = "\n".join(
        f"- [{t.id}] ({t.type.value}) {t.question} [status: {t.status.value}]"
        for t in tasks
    )
    
    reports_str = _read_recent_files(reports_dir, limit=5) if reports_dir else "(none)"
    decisions_str = _read_recent_files(decisions_dir, limit=5) if decisions_dir else "(none)"
    
    prompt = PLAN_PROMPT.format(
        tasks=tasks_str or "(no tasks)",
        reports=reports_str,
        decisions=decisions_str,
    )
    
    response = llm.chat(
        model=config.models.planner,
        messages=[{"role": "user", "content": prompt}],
        temperature=0.3,  # more deterministic for planning
    )
    
    plan = _parse_json(response)
    return plan


def replan(
    current_plan: dict,
    report: str,
    config: NightBotConfig,
    llm: LLM,
) -> dict:
    """Update plan based on a scout report."""
    
    prompt = REPLAN_PROMPT.format(
        report=report[:3000],  # truncate long reports
        current_plan=json.dumps(current_plan, indent=2),
    )
    
    response = llm.chat(
        model=config.models.planner,
        messages=[{"role": "user", "content": prompt}],
        temperature=0.3,
    )
    
    return _parse_json(response)


def generate_briefing(
    config: NightBotConfig,
    llm: LLM,
    plans_dir: str | Path,
    reports_dir: str | Path,
    decisions_dir: str | Path,
) -> str:
    """Generate a morning briefing."""
    
    plan_str = _read_file(Path(plans_dir) / "current.json")
    reports_str = _read_recent_files(reports_dir, limit=10)
    decisions_str = _read_recent_files(decisions_dir, limit=5)
    
    prompt = BRIEFING_PROMPT.format(
        plan=plan_str or "(no plan)",
        reports=reports_str or "(no reports)",
        decisions=decisions_str or "(no pending decisions)",
        date=datetime.now().strftime("%Y-%m-%d (%A)"),
    )
    
    return llm.chat(
        model=config.models.planner,
        messages=[{"role": "user", "content": prompt}],
        temperature=0.5,
    )


def get_next_task(plan: dict, completed_ids: set[str] | None = None) -> Optional[str]:
    """Get the next task ID to execute from the plan."""
    completed_ids = completed_ids or set()
    
    order = plan.get("execution_order", [])
    tasks_map = {t["id"]: t for t in plan.get("tasks", [])}
    
    for task_id in order:
        task = tasks_map.get(task_id, {})
        if task.get("status") in ("done", "failed", "skipped"):
            continue
        
        # Check dependencies
        deps = task.get("depends_on", [])
        if all(d in completed_ids for d in deps):
            return task_id
    
    return None  # all done or blocked


def save_plan(plan: dict, plans_dir: str | Path) -> Path:
    """Save plan to file."""
    plans_dir = Path(plans_dir)
    plans_dir.mkdir(parents=True, exist_ok=True)
    
    path = plans_dir / "current.json"
    with open(path, "w") as f:
        json.dump(plan, f, indent=2, ensure_ascii=False)
    
    # Also archive
    archive_dir = plans_dir / "history"
    archive_dir.mkdir(exist_ok=True)
    archive_path = archive_dir / f"{datetime.now().strftime('%Y%m%d-%H%M%S')}.json"
    with open(archive_path, "w") as f:
        json.dump(plan, f, indent=2, ensure_ascii=False)
    
    return path


# --- helpers ---

def _parse_json(text: str) -> dict:
    """Extract JSON from LLM response (handles markdown fences)."""
    text = text.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1] if "\n" in text else text[3:]
    if text.endswith("```"):
        text = text[:-3]
    text = text.strip()
    
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        logger.error(f"Failed to parse plan JSON: {text[:200]}...")
        return {"tasks": [], "execution_order": [], "reasoning": "parse error"}


def _read_recent_files(dir_path: Optional[str | Path], limit: int = 5) -> str:
    """Read recent files from a directory."""
    if not dir_path:
        return ""
    
    dir_path = Path(dir_path)
    if not dir_path.exists():
        return ""
    
    files = sorted(dir_path.glob("*.md"), key=lambda f: f.stat().st_mtime, reverse=True)
    
    parts = []
    for f in files[:limit]:
        content = f.read_text()[:1000]  # truncate
        parts.append(f"### {f.name}\n{content}")
    
    return "\n\n".join(parts) if parts else "(none)"


def _read_file(path: Path) -> str:
    """Read a file, return empty string if not found."""
    if path.exists():
        return path.read_text()
    return ""
