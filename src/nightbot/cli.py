"""Night Bot CLI."""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(
        prog="nightbot",
        description="Night Bot — 24/7 AI development crew",
    )
    parser.add_argument("-v", "--verbose", action="store_true", help="Debug logging")
    parser.add_argument("-c", "--config", default=None, help="Config file path")
    
    sub = parser.add_subparsers(dest="command")
    
    # nightbot start
    sub.add_parser("start", help="Start the daemon")
    
    # nightbot add "question"
    add_p = sub.add_parser("add", help="Add a task")
    add_p.add_argument("question", help="What to investigate")
    add_p.add_argument("--type", default="feasibility", 
                       choices=["feasibility", "migration", "comparison", "reproduction", "exploration", "sweep"])
    add_p.add_argument("--context", default=None, help="Project path to mount in sandbox")
    
    # nightbot plan
    sub.add_parser("plan", help="Show or create plan")
    
    # nightbot briefing
    sub.add_parser("briefing", help="Generate morning briefing")
    
    # nightbot status
    sub.add_parser("status", help="Show current status")
    
    # nightbot queue
    sub.add_parser("queue", help="Show task queue")
    
    # nightbot reports
    sub.add_parser("reports", help="List reports")
    
    # nightbot setup
    sub.add_parser("setup", help="Build sandbox image and check dependencies")
    
    args = parser.parse_args()
    
    # Logging
    level = logging.DEBUG if args.verbose else logging.INFO
    logging.basicConfig(
        level=level,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )
    
    if not args.command:
        parser.print_help()
        return
    
    # Load config
    from .config import load_config
    config = load_config(args.config)
    
    if args.command == "start":
        _cmd_start(config)
    elif args.command == "add":
        _cmd_add(config, args.question, args.type, args.context)
    elif args.command == "plan":
        _cmd_plan(config)
    elif args.command == "briefing":
        _cmd_briefing(config)
    elif args.command == "status":
        _cmd_status(config)
    elif args.command == "queue":
        _cmd_queue(config)
    elif args.command == "reports":
        _cmd_reports(config)
    elif args.command == "setup":
        _cmd_setup(config)


def _cmd_start(config):
    from .orchestrator import Orchestrator
    orch = Orchestrator(config)
    orch.start()


def _cmd_add(config, question: str, task_type: str, context: str | None):
    from .task import TaskType, create_task
    
    task = create_task(
        question=question,
        type=TaskType(task_type),
        context=context,
    )
    path = task.save(config.paths.queue)
    print(f"✓ Task added: {task.id}")
    print(f"  Question: {question}")
    print(f"  Type: {task_type}")
    print(f"  Saved: {path}")


def _cmd_plan(config):
    plan_path = Path(config.paths.plans) / "current.json"
    if not plan_path.exists():
        print("No plan yet. Run 'nightbot start' to create one.")
        return
    
    import json
    with open(plan_path) as f:
        plan = json.load(f)
    
    print(f"Current Plan ({len(plan.get('tasks', []))} tasks)")
    print(f"Reasoning: {plan.get('reasoning', 'n/a')}")
    print()
    
    for i, tid in enumerate(plan.get("execution_order", []), 1):
        task = next((t for t in plan.get("tasks", []) if t["id"] == tid), None)
        if task:
            status = task.get("status", "?")
            icon = {"ready": "⏳", "done": "✅", "failed": "❌", "running": "🔄"}.get(status, "?")
            deps = task.get("depends_on", [])
            dep_str = f" (after {', '.join(deps)})" if deps else ""
            print(f"  {i}. {icon} [{task['id']}] {task['name']}{dep_str}")


def _cmd_briefing(config):
    from .llm import LLM
    from .planner import generate_briefing
    
    llm = LLM(host=config.ollama.host)
    if not llm.is_available():
        print("❌ ollama not reachable. Start it: ollama serve")
        return
    
    print("Generating briefing...\n")
    briefing = generate_briefing(
        config=config,
        llm=llm,
        plans_dir=config.paths.plans,
        reports_dir=config.paths.reports,
        decisions_dir=config.paths.decisions,
    )
    print(briefing)


def _cmd_status(config):
    from .llm import LLM
    from .task import TaskStatus, load_tasks
    
    llm = LLM(host=config.ollama.host)
    
    print("Night Bot Status")
    print(f"  ollama: {'✅ connected' if llm.is_available() else '❌ not reachable'}")
    
    for status in TaskStatus:
        tasks = load_tasks(config.paths.queue, status)
        if tasks:
            print(f"  {status.value}: {len(tasks)} tasks")
    
    reports = list(Path(config.paths.reports).glob("*.md")) if Path(config.paths.reports).exists() else []
    print(f"  reports: {len(reports)}")
    
    plan_path = Path(config.paths.plans) / "current.json"
    print(f"  plan: {'exists' if plan_path.exists() else 'none'}")


def _cmd_queue(config):
    from .task import TaskStatus, load_tasks
    
    for status in TaskStatus:
        tasks = load_tasks(config.paths.queue, status)
        if tasks:
            print(f"\n{status.value.upper()} ({len(tasks)})")
            for t in tasks:
                print(f"  [{t.id}] {t.question}")


def _cmd_reports(config):
    reports_dir = Path(config.paths.reports)
    if not reports_dir.exists():
        print("No reports yet.")
        return
    
    reports = sorted(reports_dir.glob("*.md"), reverse=True)
    for r in reports[:10]:
        # Show first line of report
        first_line = r.read_text().split("\n")[0]
        print(f"  {r.name}: {first_line}")


def _cmd_setup(config):
    from .llm import LLM
    from .sandbox import build_sandbox_image
    
    print("Night Bot Setup")
    print("=" * 40)
    
    # Check ollama
    llm = LLM(host=config.ollama.host)
    if llm.is_available():
        models = llm.list_models()
        print(f"✅ ollama: {len(models)} models available")
        for m in models:
            print(f"   - {m}")
    else:
        print("❌ ollama: not reachable (run: ollama serve)")
    
    # Check Docker
    import subprocess
    result = subprocess.run(["docker", "info"], capture_output=True)
    if result.returncode == 0:
        print("✅ Docker: running")
    else:
        print("❌ Docker: not running")
        return
    
    # Build sandbox
    print("\nBuilding sandbox image...")
    try:
        build_sandbox_image()
        print("✅ Sandbox image built")
    except Exception as e:
        print(f"❌ Sandbox build failed: {e}")
    
    # Create directories
    for d in [config.paths.plans, config.paths.reports, config.paths.decisions, config.paths.queue]:
        Path(d).mkdir(parents=True, exist_ok=True)
    print("✅ Directories created")
    
    # Copy example config
    example = Path("config/nightbot.example.yaml")
    target = Path("config/nightbot.yaml")
    if example.exists() and not target.exists():
        import shutil
        shutil.copy(example, target)
        print("✅ Config copied (edit config/nightbot.yaml)")
    
    print("\nSetup complete! Next: nightbot add 'your first task'")


if __name__ == "__main__":
    main()
