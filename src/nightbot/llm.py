"""Ollama LLM interface."""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from typing import Generator

import requests

logger = logging.getLogger(__name__)


@dataclass
class Message:
    role: str  # "system" | "user" | "assistant"
    content: str


@dataclass
class Conversation:
    messages: list[Message] = field(default_factory=list)
    
    def add(self, role: str, content: str) -> None:
        self.messages.append(Message(role=role, content=content))
    
    def to_list(self) -> list[dict]:
        return [{"role": m.role, "content": m.content} for m in self.messages]


class LLM:
    """Thin wrapper around ollama HTTP API."""
    
    def __init__(self, host: str = "http://localhost:11434"):
        self.host = host.rstrip("/")
    
    def chat(
        self,
        model: str,
        messages: list[dict] | Conversation,
        temperature: float = 0.7,
        stream: bool = False,
    ) -> str:
        """Send chat completion request. Returns assistant message content."""
        if isinstance(messages, Conversation):
            messages = messages.to_list()
        
        payload = {
            "model": model,
            "messages": messages,
            "stream": stream,
            "options": {
                "temperature": temperature,
            },
        }
        
        logger.debug(f"LLM request: model={model}, messages={len(messages)}")
        
        resp = requests.post(
            f"{self.host}/api/chat",
            json=payload,
            timeout=600,  # 10 min, local LLM can be slow
        )
        resp.raise_for_status()
        
        data = resp.json()
        content = data["message"]["content"]
        
        logger.debug(f"LLM response: {len(content)} chars")
        return content
    
    def chat_stream(
        self,
        model: str,
        messages: list[dict] | Conversation,
        temperature: float = 0.7,
    ) -> Generator[str, None, None]:
        """Stream chat completion. Yields content chunks."""
        if isinstance(messages, Conversation):
            messages = messages.to_list()
        
        payload = {
            "model": model,
            "messages": messages,
            "stream": True,
            "options": {
                "temperature": temperature,
            },
        }
        
        resp = requests.post(
            f"{self.host}/api/chat",
            json=payload,
            stream=True,
            timeout=600,
        )
        resp.raise_for_status()
        
        for line in resp.iter_lines():
            if line:
                data = json.loads(line)
                if "message" in data and "content" in data["message"]:
                    yield data["message"]["content"]
    
    def is_available(self) -> bool:
        """Check if ollama is reachable."""
        try:
            resp = requests.get(f"{self.host}/api/tags", timeout=5)
            return resp.status_code == 200
        except requests.ConnectionError:
            return False
    
    def list_models(self) -> list[str]:
        """List available models."""
        resp = requests.get(f"{self.host}/api/tags", timeout=10)
        resp.raise_for_status()
        return [m["name"] for m in resp.json().get("models", [])]
