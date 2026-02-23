# Architecture

```
주인장 (CLI / Slack / Phone)
        │
        ▼
메인 비서 (Orchestrator) ── main loop
        │
        ├── Planner (알랙스) ── plan, replan, briefing
        │
        └── Scout (정찰병) ── sandbox exec, report, destroy
        
공유: /plans, /queue, /reports, /decisions
```

## Components

### Orchestrator (`orchestrator.py`)
- Runs the main `while True` loop
- Asks Planner for next task
- Assigns tasks to Scout
- Feeds results back to Planner for replanning
- Handles escalation routing

### Planner (`planner.py`)
- Creates 24h task plans with dependencies
- Replans when scout results come in
- Generates morning briefings
- Model: optimized for reasoning (qwen2.5)

### Scout (`scout.py`)
- Runs code in Docker sandbox
- LLM ↔ exec ping-pong loop
- Generates report.md
- Destroys sandbox (code disposal)
- Model: optimized for coding (deepseek-coder-v2)

### Escalation (`escalation.py`)
- L0: Silent (log only)
- L1: Report (file)
- L2: Notify (Slack DM)
- L3: Urgent (phone, optional)

## Data Flow

```
human adds task → /queue/pending/
        │
orchestrator picks up → planner creates plan → /plans/current.json
        │
orchestrator assigns → scout runs in sandbox → /reports/*.md
        │
orchestrator feeds back → planner replans → updated plan
        │
if decision needed → /decisions/ + slack notification
```

## Key Design Decisions

1. **Code Disposal**: Scout code is always thrown away. Reports are the only output.
2. **Human-as-Approver**: System plans and scouts, human decides.
3. **File-based State**: All state is in the filesystem. No database needed.
4. **Local-first**: Everything runs on local hardware. Zero cloud cost.
