"""Scout — writes code, runs it in sandbox, generates report, throws away code."""

from __future__ import annotations

import logging
import re
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from .config import NightBotConfig
from .llm import LLM, Conversation
from .sandbox import Sandbox
from .task import Task

logger = logging.getLogger(__name__)

REPORT_PROMPT = """Based on our entire conversation, write a concise report in Markdown.

Structure:
# Report: {task_question}

## Conclusion
(one line: works / partially works / doesn't work)

## What Works
- ...

## What Doesn't Work
- ...

## Key Discoveries
(things that aren't obvious from docs, gotchas, surprises)

## Recommended Next Steps
(what should the human do tomorrow based on this?)

Be concise. No filler. Only facts discovered through actual execution."""


@dataclass
class ScoutResult:
    task: Task
    report: str
    iterations: int
    duration_seconds: float
    escalated: bool = False
    escalation_reason: str = ""


def extract_code_blocks(text: str) -> list[tuple[str, str]]:
    """Extract code blocks from LLM response. Returns [(language, code), ...]."""
    pattern = r"```(\w*)\n(.*?)```"
    matches = re.findall(pattern, text, re.DOTALL)
    return [(lang or "bash", code.strip()) for lang, code in matches]


def run_scout(
    task: Task,
    config: NightBotConfig,
    llm: LLM,
) -> ScoutResult:
    """Execute a scout mission: code → run → iterate → report → destroy."""
    
    model = config.models.scout
    cb = config.circuit_breakers
    start_time = time.time()
    
    logger.info(f"Scout starting: {task.id} — {task.question}")
    
    # Conversation with the LLM
    conv = Conversation()
    conv.add("system", _load_scout_prompt())
    conv.add("user", f"Task: {task.question}\n\nType: {task.type.value}\n\nValidate this by writing and running code.")
    
    sandbox = Sandbox(
        image=config.sandbox.image,
        memory=config.sandbox.memory,
        cpus=config.sandbox.cpus,
        network=config.sandbox.network,
    )
    
    iterations = 0
    last_errors: list[str] = []
    escalated = False
    escalation_reason = ""
    
    try:
        sandbox.create(mount_project=task.context)
        
        for i in range(cb.iteration_limit):
            iterations = i + 1
            elapsed = time.time() - start_time
            
            # Timeout check
            if elapsed > cb.timeout_per_task_hours * 3600:
                logger.warning(f"Scout timeout after {elapsed:.0f}s")
                conv.add("user", "TIME'S UP. Summarize what you've learned so far.")
                break
            
            # Ask LLM
            logger.info(f"Scout iteration {iterations}/{cb.iteration_limit}")
            response = llm.chat(model=model, messages=conv)
            conv.add("assistant", response)
            
            # Check for completion
            if "DONE" in response.upper() and i > 0:
                logger.info("Scout reports DONE")
                break
            
            # Check for escalation request
            if "ESCALATE" in response.upper():
                escalated = True
                escalation_reason = response
                logger.info("Scout requests escalation")
                break
            
            # Extract and run code blocks
            code_blocks = extract_code_blocks(response)
            if not code_blocks:
                conv.add("user", "No code found. Write actual code to test this. Use ```bash or ```typescript blocks.")
                continue
            
            # Execute each code block
            exec_results = []
            for lang, code in code_blocks:
                if lang in ("bash", "sh", "shell", ""):
                    result = sandbox.exec(code, timeout=120)
                elif lang in ("typescript", "ts"):
                    sandbox.write_file("test.ts", code)
                    result = sandbox.exec("npx ts-node /sandbox/test.ts", timeout=120)
                elif lang in ("javascript", "js"):
                    sandbox.write_file("test.js", code)
                    result = sandbox.exec("node /sandbox/test.js", timeout=120)
                elif lang == "python":
                    sandbox.write_file("test.py", code)
                    result = sandbox.exec("python3 /sandbox/test.py", timeout=120)
                else:
                    # Default: try as bash
                    result = sandbox.exec(code, timeout=120)
                
                exec_results.append(f"[{lang}] exit={result.exit_code}\n{result.output}")
            
            # Feed results back
            all_output = "\n---\n".join(exec_results)
            conv.add("user", f"Execution results:\n\n{all_output}\n\nAnalyze the results and continue. If done, say DONE. If you need human input, say ESCALATE.")
            
            # Circuit breaker: same error repeated
            current_error = all_output if any("STDERR" in r for r in exec_results) else ""
            if current_error:
                last_errors.append(current_error[:200])
                if len(last_errors) >= cb.same_error_limit:
                    recent = last_errors[-cb.same_error_limit:]
                    if len(set(recent)) == 1:
                        logger.warning(f"Same error {cb.same_error_limit} times, giving up")
                        conv.add("user", f"You've hit the same error {cb.same_error_limit} times. Stop and report what you've learned.")
                        response = llm.chat(model=model, messages=conv)
                        conv.add("assistant", response)
                        break
        
        # Generate report
        conv.add("user", REPORT_PROMPT.format(task_question=task.question))
        report = llm.chat(model=model, messages=conv)
        
        # Add metadata
        duration = time.time() - start_time
        report += f"\n\n---\n## Meta\n- Model: {model}\n- Iterations: {iterations}/{cb.iteration_limit}\n- Duration: {duration:.0f}s\n- Sandbox: destroyed\n"
        
    finally:
        sandbox.destroy()
    
    return ScoutResult(
        task=task,
        report=report,
        iterations=iterations,
        duration_seconds=time.time() - start_time,
        escalated=escalated,
        escalation_reason=escalation_reason,
    )


def save_report(result: ScoutResult, reports_dir: str | Path) -> Path:
    """Save scout report to file."""
    reports_dir = Path(reports_dir)
    reports_dir.mkdir(parents=True, exist_ok=True)
    
    date = datetime.now().strftime("%Y-%m-%d")
    filename = f"{date}-{result.task.id}.md"
    path = reports_dir / filename
    
    path.write_text(result.report)
    logger.info(f"Report saved: {path}")
    return path


def _load_scout_prompt() -> str:
    """Load scout system prompt from agent config or use default."""
    default = Path(__file__).parent.parent.parent / "config" / "agents" / "scout.yaml"
    if default.exists():
        import yaml
        with open(default) as f:
            data = yaml.safe_load(f)
        return data.get("system_prompt", "")
    
    return (
        "You are a code scout. Write code, run it, report findings. "
        "Your code will be thrown away. Focus on what works and what doesn't."
    )
