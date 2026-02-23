"""Configuration loader."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import yaml


@dataclass
class OllamaConfig:
    host: str = "http://localhost:11434"


@dataclass
class ModelsConfig:
    planner: str = "qwen2.5:32b"
    scout: str = "deepseek-coder-v2:33b"
    secretary: str = "qwen2.5:32b"
    lightweight: str = "llama3.1:8b"


@dataclass
class SandboxConfig:
    image: str = "nightbot-sandbox:latest"
    memory: str = "8g"
    cpus: int = 4
    network: str = "host"
    auto_destroy: bool = True


@dataclass
class SlackConfig:
    webhook: str = ""
    channel: str = ""


@dataclass
class TwilioConfig:
    enabled: bool = False
    account_sid: str = ""
    auth_token: str = ""
    from_number: str = ""
    to_number: str = ""


@dataclass
class EscalationConfig:
    slack: SlackConfig = field(default_factory=SlackConfig)
    twilio: TwilioConfig = field(default_factory=TwilioConfig)
    cooldown_minutes: int = 30


@dataclass
class CircuitBreakerConfig:
    same_error_limit: int = 3
    iteration_limit: int = 20
    timeout_per_task_hours: int = 6
    total_timeout_hours: int = 10
    replan_limit: int = 5


@dataclass
class SchedulerConfig:
    check_interval_seconds: int = 300
    active_start: Optional[str] = None  # "22:00"
    active_end: Optional[str] = None  # "08:00"


@dataclass
class PathsConfig:
    plans: str = "./plans"
    reports: str = "./reports"
    decisions: str = "./decisions"
    queue: str = "./queue"
    agents: str = "./config/agents"


@dataclass
class NightBotConfig:
    ollama: OllamaConfig = field(default_factory=OllamaConfig)
    models: ModelsConfig = field(default_factory=ModelsConfig)
    sandbox: SandboxConfig = field(default_factory=SandboxConfig)
    escalation: EscalationConfig = field(default_factory=EscalationConfig)
    circuit_breakers: CircuitBreakerConfig = field(default_factory=CircuitBreakerConfig)
    scheduler: SchedulerConfig = field(default_factory=SchedulerConfig)
    paths: PathsConfig = field(default_factory=PathsConfig)


def load_config(path: str | Path | None = None) -> NightBotConfig:
    """Load config from yaml file. Falls back to defaults."""
    if path is None:
        path = Path(os.environ.get("NIGHTBOT_CONFIG", "config/nightbot.yaml"))
    
    path = Path(path)
    if not path.exists():
        return NightBotConfig()
    
    with open(path) as f:
        raw = yaml.safe_load(f) or {}
    
    config = NightBotConfig()
    
    if "ollama" in raw:
        config.ollama = OllamaConfig(**raw["ollama"])
    if "models" in raw:
        config.models = ModelsConfig(**raw["models"])
    if "sandbox" in raw:
        config.sandbox = SandboxConfig(**raw["sandbox"])
    if "circuit_breakers" in raw:
        config.circuit_breakers = CircuitBreakerConfig(**raw["circuit_breakers"])
    if "paths" in raw:
        config.paths = PathsConfig(**raw["paths"])
    if "escalation" in raw:
        esc = raw["escalation"]
        config.escalation = EscalationConfig(
            slack=SlackConfig(
                webhook=esc.get("slack_webhook", ""),
                channel=esc.get("slack_channel", ""),
            ),
            twilio=TwilioConfig(**esc.get("twilio", {})) if "twilio" in esc else TwilioConfig(),
            cooldown_minutes=esc.get("cooldown_minutes", 30),
        )
    
    return config


def load_agent(name: str, config: NightBotConfig) -> dict:
    """Load an agent definition from yaml."""
    path = Path(config.paths.agents) / f"{name}.yaml"
    if not path.exists():
        raise FileNotFoundError(f"Agent not found: {path}")
    
    with open(path) as f:
        return yaml.safe_load(f)
