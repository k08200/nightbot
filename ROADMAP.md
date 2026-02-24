# Night Bot — Roadmap

## Phase 0: Repo Cleanup ✅
- [x] Convert all content to English
- [x] Add LICENSE
- [x] Add Dockerfile.sandbox
- [ ] Verify `pip install -e .` works
- [ ] Verify `nightbot --help` works

## Phase 1: Scout MVP (This Week)
The only phase that matters. If Scout can't produce useful reports, nothing else matters.

### 1.1 LLM wrapper
- [ ] Test ollama chat roundtrip
- [ ] Connection error handling
- [ ] Timeout retry logic

### 1.2 Sandbox
- [ ] create() → exec() → destroy() lifecycle
- [ ] Build sandbox image via `nightbot setup`
- [ ] File write + code run + output capture
- [ ] Timeout and cleanup on error

### 1.3 Scout loop
- [ ] Full LLM ↔ sandbox ping-pong
- [ ] Code block extraction from LLM responses
- [ ] Multi-language exec (bash, typescript, python)
- [ ] Circuit breaker: same error 3x → give up
- [ ] Circuit breaker: iteration limit
- [ ] Circuit breaker: timeout
- [ ] Report generation prompt tuning
- [ ] Test 3 task types: feasibility, comparison, migration

### 1.4 CLI
- [ ] `nightbot setup` — build sandbox, check ollama
- [ ] `nightbot add "question"` — create task in queue
- [ ] `nightbot start` — run scout loop
- [ ] `nightbot status` — show queue state
- [ ] `nightbot reports` — list reports

### 1.5 Quality validation
- [ ] Run 5 real tasks overnight
- [ ] Evaluate: are reports actually useful?
- [ ] Tune scout prompt and report prompt
- [ ] Document best model for scout role

**Done when:** Sleep, wake up, reports are useful.

## Phase 2: Planner (Next Week)
Prerequisite: Phase 1 reports are reliably useful.

- [ ] Plan JSON generation from task list
- [ ] Dependency graph and priority ordering
- [ ] Replan on scout results
- [ ] Orchestrator: planner ↔ scout coordination
- [ ] `nightbot briefing` — morning summary

**Done when:** 10 tasks auto-ordered, replanned after results.

## Phase 3: Escalation
Prerequisite: Phase 2 orchestrator runs overnight.

- [ ] Slack webhook notifications
- [ ] L0-L3 escalation levels
- [ ] Decision file workflow (pending → decided)
- [ ] Cooldown to prevent spam

**Done when:** Slack pings only when it matters.

## Phase 4: Persona System
- [ ] `nightbot agents` — list agents
- [ ] `nightbot hire` — create agent interactively
- [ ] `nightbot talk {name}` — chat with specific agent
- [ ] Model-per-agent optimization

## Phase 5: Voice (Optional)
- [ ] Chatterbox TTS (Korean + English)
- [ ] faster-whisper STT
- [ ] Phone call escalation via Twilio

## Priority
```
Phase 1 ████████████████████  ← THIS IS EVERYTHING
Phase 2 ████████████░░░░░░░░  high value
Phase 3 ██████░░░░░░░░░░░░░░  quality of life
Phase 4 ████░░░░░░░░░░░░░░░░  nice to have
Phase 5 ██░░░░░░░░░░░░░░░░░░  bonus
```

Rule: Don't start Phase N+1 until Phase N is validated with real usage.
