# Architecture
```
Human (CLI / Slack / Phone)
        |
        v
Secretary (Orchestrator) -- main loop, always on
        |
        +-- Planner -- plan, replan, briefing
        |
        +-- Scout -- sandbox exec, report, destroy

Shared state: /plans, /queue, /reports, /decisions
```

## Components

### Secretary (`orchestrator.py`)
Main loop. Routes tasks between Planner and Scout. Handles escalation.

### Planner (`planner.py`)
Creates 24h task plans with dependencies. Replans on scout results. Generates briefings.

### Scout (`scout.py`)
LLM <-> Docker exec ping-pong. Generates report.md. Destroys sandbox (code disposal).

### Escalation (`escalation.py`)
L0: Silent (log) | L1: Report (file) | L2: Notify (Slack) | L3: Urgent (phone)

## Key Decisions

1. **Code Disposal** — Scout code is always thrown away. Reports are the only output.
2. **Human-as-Approver** — System plans and scouts, human decides.
3. **File-based State** — No database. All state in filesystem.
4. **Local-first** — ollama + Docker. Zero cloud cost.
