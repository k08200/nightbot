"""Docker sandbox for isolated code execution."""

from __future__ import annotations

import logging
import subprocess
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)


@dataclass
class ExecResult:
    exit_code: int
    stdout: str
    stderr: str
    
    @property
    def success(self) -> bool:
        return self.exit_code == 0
    
    @property
    def output(self) -> str:
        """Combined output for LLM consumption."""
        parts = []
        if self.stdout.strip():
            parts.append(f"STDOUT:\n{self.stdout.strip()}")
        if self.stderr.strip():
            parts.append(f"STDERR:\n{self.stderr.strip()}")
        if not parts:
            return "(no output)"
        return "\n\n".join(parts)


class Sandbox:
    """Docker-based sandbox for running untrusted code."""
    
    def __init__(
        self,
        image: str = "nightbot-sandbox:latest",
        memory: str = "8g",
        cpus: int = 4,
        network: str = "host",
        workdir: str = "/workspace",
    ):
        self.image = image
        self.memory = memory
        self.cpus = cpus
        self.network = network
        self.workdir = workdir
        self.container_id: Optional[str] = None
        self.name = f"nightbot-sandbox-{uuid.uuid4().hex[:8]}"
    
    def create(self, mount_project: Optional[str] = None) -> str:
        """Create and start a sandbox container."""
        cmd = [
            "docker", "run", "-d",
            "--name", self.name,
            "--memory", self.memory,
            f"--cpus={self.cpus}",
            f"--network={self.network}",
            "-w", self.workdir,
        ]
        
        if mount_project:
            # Mount project read-only for context
            cmd.extend(["-v", f"{mount_project}:{self.workdir}:ro"])
            # Writable sandbox area
            cmd.extend(["-v", f"/tmp/{self.name}:/sandbox:rw"])
        
        cmd.extend([self.image, "sleep", "infinity"])
        
        logger.info(f"Creating sandbox: {self.name}")
        result = subprocess.run(cmd, capture_output=True, text=True)
        
        if result.returncode != 0:
            raise RuntimeError(f"Failed to create sandbox: {result.stderr}")
        
        self.container_id = result.stdout.strip()
        logger.info(f"Sandbox created: {self.container_id[:12]}")
        return self.container_id
    
    def exec(self, command: str, timeout: int = 120) -> ExecResult:
        """Execute a command inside the sandbox."""
        if not self.container_id:
            raise RuntimeError("Sandbox not created. Call create() first.")
        
        cmd = [
            "docker", "exec",
            "-w", "/sandbox",
            self.container_id,
            "bash", "-c", command,
        ]
        
        logger.debug(f"Sandbox exec: {command[:100]}...")
        
        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=timeout,
            )
            return ExecResult(
                exit_code=result.returncode,
                stdout=result.stdout[-5000:],  # truncate to last 5k chars
                stderr=result.stderr[-5000:],
            )
        except subprocess.TimeoutExpired:
            return ExecResult(
                exit_code=-1,
                stdout="",
                stderr=f"Command timed out after {timeout}s",
            )
    
    def write_file(self, path: str, content: str) -> ExecResult:
        """Write a file inside the sandbox."""
        # Escape for bash
        escaped = content.replace("'", "'\\''")
        return self.exec(f"cat > /sandbox/{path} << 'NIGHTBOT_EOF'\n{content}\nNIGHTBOT_EOF")
    
    def destroy(self) -> None:
        """Stop and remove the sandbox container."""
        if not self.container_id:
            return
        
        logger.info(f"Destroying sandbox: {self.name}")
        subprocess.run(
            ["docker", "rm", "-f", self.container_id],
            capture_output=True,
        )
        self.container_id = None
    
    def __enter__(self):
        self.create()
        return self
    
    def __exit__(self, *args):
        self.destroy()


def build_sandbox_image():
    """Build the default sandbox Docker image."""
    dockerfile = """\
FROM node:20-slim

RUN apt-get update && apt-get install -y \\
    git curl python3 python3-pip build-essential \\
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g typescript ts-node vitest jest pnpm yarn

WORKDIR /sandbox
"""
    
    tmp = Path("/tmp/nightbot-sandbox-build")
    tmp.mkdir(exist_ok=True)
    (tmp / "Dockerfile").write_text(dockerfile)
    
    logger.info("Building sandbox image...")
    result = subprocess.run(
        ["docker", "build", "-t", "nightbot-sandbox:latest", str(tmp)],
        capture_output=True,
        text=True,
    )
    
    if result.returncode != 0:
        raise RuntimeError(f"Failed to build sandbox image: {result.stderr}")
    
    logger.info("Sandbox image built successfully")
