"""Escalation — notify humans when decisions are needed."""

from __future__ import annotations

import logging
from datetime import datetime
from enum import IntEnum
from pathlib import Path

import requests

from .config import NightBotConfig

logger = logging.getLogger(__name__)


class Level(IntEnum):
    SILENT = 0   # log only
    REPORT = 1   # file only
    NOTIFY = 2   # slack DM
    URGENT = 3   # phone call


def escalate(
    message: str,
    level: Level,
    config: NightBotConfig,
    context: str = "",
) -> bool:
    """Send escalation through appropriate channel."""
    
    logger.info(f"Escalation L{level.value}: {message[:100]}")
    
    if level == Level.SILENT:
        return True
    
    if level == Level.REPORT:
        _save_decision_request(message, context, config)
        return True
    
    if level == Level.NOTIFY:
        _save_decision_request(message, context, config)
        return _slack_notify(message, config)
    
    if level == Level.URGENT:
        _save_decision_request(message, context, config)
        success = _slack_notify(f"🚨 URGENT: {message}", config)
        # Phone call would go here (Twilio/Chatterbox TTS)
        # For now, just double-notify on Slack
        return success
    
    return False


def classify_escalation(scout_report: str, escalation_reason: str = "") -> Level:
    """Decide escalation level based on scout result."""
    
    lower = (scout_report + escalation_reason).lower()
    
    # Urgent: everything is blocked
    if "all tasks blocked" in lower or "pipeline halt" in lower:
        return Level.URGENT
    
    # Notify: decision needed
    if any(kw in lower for kw in ["escalate", "decision needed", "trade-off", "tradeoff", "which approach"]):
        return Level.NOTIFY
    
    # Report: normal completion
    if any(kw in lower for kw in ["done", "completed", "conclusion"]):
        return Level.REPORT
    
    return Level.SILENT


def _slack_notify(message: str, config: NightBotConfig) -> bool:
    """Send a Slack notification."""
    webhook = config.escalation.slack.webhook
    if not webhook:
        logger.warning("Slack webhook not configured, skipping notification")
        return False
    
    try:
        resp = requests.post(
            webhook,
            json={"text": message},
            timeout=10,
        )
        return resp.status_code == 200
    except Exception as e:
        logger.error(f"Slack notification failed: {e}")
        return False


def _save_decision_request(message: str, context: str, config: NightBotConfig) -> Path:
    """Save a decision request for the human to review."""
    decisions_dir = Path(config.paths.decisions)
    decisions_dir.mkdir(parents=True, exist_ok=True)
    
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    path = decisions_dir / f"{timestamp}-pending.md"
    
    content = f"""# Decision Needed — {datetime.now().strftime("%Y-%m-%d %H:%M")}

## Question
{message}

## Context
{context or "(no additional context)"}

## How to Respond
Edit this file: change the filename from `-pending.md` to `-decided.md` and add your decision below.

## Decision
(write your decision here)
"""
    
    path.write_text(content)
    return path
