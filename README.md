# Night Bot 🌙

**자는 동안 local LLM이 코드를 짜고, 돌려보고, 인사이트만 남기고, 코드는 버린다.**

Night Bot is a 24/7 AI development crew that runs on local LLMs. It explores, validates, and scouts — then throws away the code and keeps only the insights.

## Core Idea

- **Scout** — writes code, runs it in a sandbox, generates a report, deletes the code
- **Planner** — maintains a 24h task graph with dependencies, assigns work to Scout, replans on results
- **Secretary** — orchestrates everything, escalates to human only when needed

## Quick Start

```bash
# Install
pip install -e .

# Configure
cp config/nightbot.example.yaml config/nightbot.yaml
# Edit with your ollama model preferences

# Add a task
nightbot add "Can we migrate from Jest to Vitest without breaking our test suite?"

# Start the daemon
nightbot start

# Check in the morning
nightbot briefing
```

## Requirements

- Python 3.11+
- [ollama](https://ollama.ai) running locally
- Docker (for sandbox isolation)

## Architecture

```
주인장 (사람)
    │
    ▼
메인 비서 (Orchestrator) ── 항상 ON, 메인 루프
    │
    ├── Planner ── 24h 계획, 의존성, 재계획
    │
    └── Scout ── Docker sandbox, 코드 실행, report 생성, 코드 폐기
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for full details.

## License

MIT
