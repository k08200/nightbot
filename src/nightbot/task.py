"""Task definitions and queue management."""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from pathlib import Path
from typing import Optional

import yaml


class TaskType(str, Enum):
    FEASIBILITY = "feasibility"
    MIGRATION = "migration"
    COMPARISON = "comparison"
    REPRODUCTION = "reproduction"
    EXPLORATION = "exploration"
    SWEEP = "sweep"


class TaskStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    DONE = "done"
    FAILED = "failed"
    ESCALATED = "escalated"


@dataclass
class Task:
    id: str
    question: str
    type: TaskType = TaskType.FEASIBILITY
    context: Optional[str] = None  # path to project to mount
    depends_on: list[str] = field(default_factory=list)
    max_iterations: int = 20
    timeout_hours: int = 6
    status: TaskStatus = TaskStatus.PENDING
    created_at: str = field(default_factory=lambda: datetime.now().isoformat())
    
    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "question": self.question,
            "type": self.type.value,
            "context": self.context,
            "depends_on": self.depends_on,
            "max_iterations": self.max_iterations,
            "timeout_hours": self.timeout_hours,
            "status": self.status.value,
            "created_at": self.created_at,
        }
    
    @classmethod
    def from_dict(cls, data: dict) -> Task:
        return cls(
            id=data["id"],
            question=data["question"],
            type=TaskType(data.get("type", "feasibility")),
            context=data.get("context"),
            depends_on=data.get("depends_on", []),
            max_iterations=data.get("max_iterations", 20),
            timeout_hours=data.get("timeout_hours", 6),
            status=TaskStatus(data.get("status", "pending")),
            created_at=data.get("created_at", datetime.now().isoformat()),
        )
    
    def save(self, queue_dir: str | Path) -> Path:
        """Save task to queue directory."""
        dir_path = Path(queue_dir) / self.status.value
        dir_path.mkdir(parents=True, exist_ok=True)
        path = dir_path / f"{self.id}.yaml"
        with open(path, "w") as f:
            yaml.dump(self.to_dict(), f, default_flow_style=False)
        return path


def create_task(question: str, **kwargs) -> Task:
    """Create a new task with auto-generated ID."""
    return Task(
        id=f"task-{uuid.uuid4().hex[:8]}",
        question=question,
        **kwargs,
    )


def load_tasks(queue_dir: str | Path, status: TaskStatus | None = None) -> list[Task]:
    """Load tasks from queue directory."""
    queue_dir = Path(queue_dir)
    tasks = []
    
    statuses = [status] if status else list(TaskStatus)
    for s in statuses:
        dir_path = queue_dir / s.value
        if not dir_path.exists():
            continue
        for file in dir_path.glob("*.yaml"):
            with open(file) as f:
                data = yaml.safe_load(f)
            if data:
                tasks.append(Task.from_dict(data))
    
    return tasks


def move_task(task: Task, queue_dir: str | Path, new_status: TaskStatus) -> None:
    """Move a task to a new status directory."""
    queue_dir = Path(queue_dir)
    
    # Remove from old location
    old_path = queue_dir / task.status.value / f"{task.id}.yaml"
    if old_path.exists():
        old_path.unlink()
    
    # Save to new location
    task.status = new_status
    task.save(queue_dir)
