# Night Bot 🌙

**While you sleep, a local LLM writes code, runs it, discovers what works and what doesn't, then throws the code away and keeps only the insights.**

Night Bot is a 24/7 AI development crew running entirely on local LLMs. Zero cloud cost.

## Core Loop
```
You (before bed):     "Can vitest resolve tsconfig path aliases in a monorepo?"
Night Bot (overnight): writes code → runs in sandbox → error → fix → retry → success
You (morning):         reads report.md with findings, gotchas, and next steps
```

## Components

- **Scout** — writes code, runs it in Docker sandbox, generates report, destroys code
- **Planner** — 24h task graph with dependencies, assigns work, replans on results
- **Secretary** — orchestrates everything, escalates to human only when needed

## Quick Start
```bash
pip install -e .
nightbot setup
nightbot add "Can we migrate from Jest to Vitest without breaking our test suite?"
nightbot start
nightbot briefing
```

## Requirements

- Python 3.11+
- [ollama](https://ollama.ai) with a coding model (e.g. `qwen2.5-coder:14b`)
- Docker

## Status

See [ROADMAP.md](ROADMAP.md) for the phase-by-phase plan.

## License

MIT
