"""Orchestrator (Secretary) — main loop coordinating Planner and Scout."""

from __future__ import annotations

import logging
import signal
import time
from pathlib import Path

from .config import NightBotConfig, load_config
from .escalation import Level, classify_escalation, escalate
from .llm import LLM
from .planner import create_plan, get_next_task, replan, save_plan
from .scout import run_scout, save_report
from .task import Task, TaskStatus, create_task, load_tasks, move_task

logger = logging.getLogger(__name__)


class Orchestrator:
    """Main secretary loop. Coordinates Planner and Scout."""
    
    def __init__(self, config: NightBotConfig | None = None):
        self.config = config or load_config()
        self.llm = LLM(host=self.config.ollama.host)
        self.running = False
        self.completed_ids: set[str] = set()
    
    def start(self) -> None:
        """Start the main loop (blocking)."""
        self.running = True
        
        # Graceful shutdown
        signal.signal(signal.SIGINT, self._shutdown)
        signal.signal(signal.SIGTERM, self._shutdown)
        
        logger.info("Night Bot starting...")
        
        # Check ollama
        if not self.llm.is_available():
            logger.error("ollama is not reachable. Start it first: ollama serve")
            return
        
        logger.info(f"ollama connected: {self.config.ollama.host}")
        logger.info(f"Models — planner: {self.config.models.planner}, scout: {self.config.models.scout}")
        
        # Load or create plan
        plan = self._load_or_create_plan()
        
        while self.running:
            try:
                self._tick(plan)
            except KeyboardInterrupt:
                break
            except Exception as e:
                logger.error(f"Tick error: {e}", exc_info=True)
            
            if self.running:
                interval = self.config.scheduler.check_interval_seconds
                logger.info(f"Sleeping {interval}s...")
                time.sleep(interval)
        
        logger.info("Night Bot stopped.")
    
    def _tick(self, plan: dict) -> None:
        """One iteration of the main loop."""
        
        # 1. Get next task from plan
        next_id = get_next_task(plan, self.completed_ids)
        
        if next_id is None:
            logger.info("No more tasks to execute. Waiting for new tasks...")
            
            # Check if new tasks appeared in queue
            pending = load_tasks(self.config.paths.queue, TaskStatus.PENDING)
            if pending:
                logger.info(f"Found {len(pending)} new pending tasks, replanning...")
                plan = self._replan_with_new_tasks(plan, pending)
            return
        
        # 2. Find the task
        task = self._find_task(next_id, plan)
        if not task:
            logger.warning(f"Task {next_id} not found, skipping")
            self.completed_ids.add(next_id)
            return
        
        # 3. Run scout
        logger.info(f"Assigning to Scout: {task.id} — {task.question}")
        move_task(task, self.config.paths.queue, TaskStatus.RUNNING)
        
        result = run_scout(task, self.config, self.llm)
        
        # 4. Save report
        report_path = save_report(result, self.config.paths.reports)
        
        # 5. Handle result
        if result.escalated:
            level = classify_escalation(result.report, result.escalation_reason)
            escalate(
                message=f"Task '{task.question}' needs your input:\n{result.escalation_reason[:500]}",
                level=max(level, Level.NOTIFY),
                config=self.config,
                context=result.report[:1000],
            )
            move_task(task, self.config.paths.queue, TaskStatus.ESCALATED)
        else:
            move_task(task, self.config.paths.queue, TaskStatus.DONE)
            self.completed_ids.add(next_id)
        
        # 6. Replan
        logger.info("Replanning based on scout result...")
        plan = replan(plan, result.report, self.config, self.llm)
        save_plan(plan, self.config.paths.plans)
        
        logger.info(f"Scout done: {task.id} ({result.iterations} iterations, {result.duration_seconds:.0f}s)")
    
    def _load_or_create_plan(self) -> dict:
        """Load existing plan or create new one."""
        plan_path = Path(self.config.paths.plans) / "current.json"
        
        if plan_path.exists():
            import json
            with open(plan_path) as f:
                plan = json.load(f)
            logger.info(f"Loaded existing plan: {len(plan.get('tasks', []))} tasks")
            return plan
        
        # Create from queue
        tasks = load_tasks(self.config.paths.queue, TaskStatus.PENDING)
        if not tasks:
            logger.info("No tasks in queue. Add tasks with: nightbot add 'your task'")
            return {"tasks": [], "execution_order": [], "reasoning": "empty"}
        
        logger.info(f"Creating plan from {len(tasks)} pending tasks...")
        plan = create_plan(
            tasks,
            self.config,
            self.llm,
            reports_dir=self.config.paths.reports,
            decisions_dir=self.config.paths.decisions,
        )
        save_plan(plan, self.config.paths.plans)
        return plan
    
    def _replan_with_new_tasks(self, current_plan: dict, new_tasks: list[Task]) -> dict:
        """Incorporate new tasks into existing plan."""
        # Add new tasks to plan
        for task in new_tasks:
            current_plan.setdefault("tasks", []).append({
                "id": task.id,
                "name": task.question,
                "type": task.type.value,
                "depends_on": task.depends_on,
                "estimated_hours": 2,
                "status": "ready",
            })
        
        # Let planner reorder
        plan = create_plan(
            new_tasks + load_tasks(self.config.paths.queue),
            self.config,
            self.llm,
        )
        save_plan(plan, self.config.paths.plans)
        return plan
    
    def _find_task(self, task_id: str, plan: dict) -> Task | None:
        """Find a task by ID from plan or queue."""
        # Check queue first
        all_tasks = load_tasks(self.config.paths.queue)
        for t in all_tasks:
            if t.id == task_id:
                return t
        
        # Create from plan
        for t in plan.get("tasks", []):
            if t.get("id") == task_id:
                return create_task(
                    question=t.get("name", ""),
                    type=t.get("type", "feasibility"),
                )
        
        return None
    
    def _shutdown(self, signum, frame):
        logger.info("Shutdown signal received...")
        self.running = False
