import { execSync } from "child_process";
import { randomUUID } from "crypto";

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export class Sandbox {
  private containerId: string | null = null;
  public readonly name: string;

  constructor(
    private image = "nightbot-sandbox:latest",
    private memory = "8g",
    private cpus = 4,
    private network = "host",
  ) {
    this.name = `nightbot-${randomUUID().slice(0, 8)}`;
  }

  create(mountProject?: string): string {
    const args = [
      "docker", "run", "-d",
      "--name", this.name,
      "--memory", this.memory,
      `--cpus=${this.cpus}`,
      `--network=${this.network}`,
      "-w", "/sandbox",
    ];

    if (mountProject) {
      args.push("-v", `${mountProject}:/workspace:ro`);
    }

    args.push(this.image, "sleep", "infinity");

    const id = execSync(args.join(" "), { encoding: "utf-8" }).trim();
    this.containerId = id;
    return id;
  }

  exec(command: string, timeout = 120): ExecResult {
    if (!this.containerId) throw new Error("Sandbox not created");

    try {
      const stdout = execSync(
        `docker exec -w /sandbox ${this.containerId} bash -c ${JSON.stringify(command)}`,
        {
          encoding: "utf-8",
          timeout: timeout * 1000,
          maxBuffer: 10 * 1024 * 1024,
        },
      );
      return { exitCode: 0, stdout: stdout.slice(-5000), stderr: "" };
    } catch (err: any) {
      return {
        exitCode: err.status ?? 1,
        stdout: (err.stdout ?? "").slice(-5000),
        stderr: (err.stderr ?? "").slice(-5000),
      };
    }
  }

  writeFile(path: string, content: string): ExecResult {
    const b64 = Buffer.from(content).toString("base64");
    return this.exec(`mkdir -p $(dirname /sandbox/${path}) && echo ${b64} | base64 -d > /sandbox/${path}`);
  }

  createWithRepo(repoPath: string): string {
    const id = this.create(repoPath);
    this.exec("cp -r /workspace /project");
    this.exec("cd /project && git add -A 2>/dev/null; git stash 2>/dev/null || true");
    return id;
  }

  extractDiff(): string {
    if (!this.containerId) throw new Error("Sandbox not created");
    const result = this.exec("cd /project && git diff HEAD");
    return result.stdout;
  }

  extractChangedFiles(): Array<{ path: string; content: string }> {
    if (!this.containerId) throw new Error("Sandbox not created");
    const result = this.exec("cd /project && git diff --name-only HEAD");
    const files = result.stdout.trim().split("\n").filter(Boolean);
    return files.map(f => {
      const content = this.exec(`cat /project/${f}`);
      return { path: f, content: content.stdout };
    });
  }

  destroy(): void {
    if (!this.containerId) return;
    try {
      execSync(`docker rm -f ${this.containerId}`, { encoding: "utf-8" });
    } catch {}
    this.containerId = null;
  }
}

export function buildSandboxImage(): void {
  const dockerfile = `FROM node:20-slim
RUN apt-get update && apt-get install -y git curl python3 build-essential && rm -rf /var/lib/apt/lists/*
RUN npm install -g typescript ts-node pnpm
WORKDIR /sandbox`;

  execSync(`echo '${dockerfile}' | docker build -t nightbot-sandbox:latest -`, {
    encoding: "utf-8",
    stdio: "inherit",
  });
}
