import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";

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
      // Pipe command to bash stdin so heredocs and multi-line scripts work correctly
      const stdout = execSync(
        `docker exec -i ${this.containerId} bash`,
        {
          input: command,
          encoding: "utf-8",
          timeout: timeout * 1000,
          maxBuffer: 10 * 1024 * 1024,
        },
      );
      return { exitCode: 0, stdout: stdout.slice(-5000), stderr: "" };
    } catch (err: unknown) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return {
        exitCode: e.status ?? 1,
        stdout: (e.stdout ?? "").slice(-5000),
        stderr: (e.stderr ?? "").slice(-5000),
      };
    }
  }

  writeFile(path: string, content: string): ExecResult {
    const b64 = Buffer.from(content).toString("base64");
    return this.exec(`mkdir -p $(dirname /sandbox/${path}) && echo ${b64} | base64 -d > /sandbox/${path}`);
  }

  writeFileAt(absolutePath: string, content: string): ExecResult {
    const b64 = Buffer.from(content).toString("base64");
    return this.exec(`mkdir -p $(dirname ${absolutePath}) && echo ${b64} | base64 -d > ${absolutePath}`);
  }

  readFile(absolutePath: string): string {
    const result = this.exec(`cat ${absolutePath} 2>/dev/null`);
    return result.stdout;
  }

  listFiles(dir: string, pattern = "*"): string[] {
    const result = this.exec(`find ${dir} -name "${pattern}" -type f 2>/dev/null | head -50`);
    return result.stdout.trim().split("\n").filter(Boolean);
  }

  createWithRepo(repoPath: string): string {
    const id = this.create(repoPath);
    this.exec("cp -r /workspace /project");
    this.exec("cd /project && (grep -q node_modules .gitignore 2>/dev/null || echo -e 'node_modules/\\ndist/\\ncoverage/' >> .gitignore)");
    this.exec("cd /project && git add -A 2>/dev/null; git stash 2>/dev/null || true");
    return id;
  }

  extractDiff(): string {
    if (!this.containerId) throw new Error("Sandbox not created");
    this.exec("cd /project && git add -A 2>/dev/null");
    const result = this.exec("cd /project && git diff --cached HEAD -- . ':!node_modules' ':!package-lock.json' ':!pnpm-lock.yaml'");
    return result.stdout;
  }

  extractChangedFiles(): Array<{ path: string; content: string }> {
    if (!this.containerId) throw new Error("Sandbox not created");
    this.exec("cd /project && git add -A 2>/dev/null");
    const result = this.exec("cd /project && git diff --cached --name-only HEAD -- . ':!node_modules' ':!package-lock.json' ':!pnpm-lock.yaml'");
    const files = result.stdout.trim().split("\n").filter(Boolean);
    return files.filter(f => !f.startsWith("node_modules/")).map(f => {
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
RUN npm install -g typescript tsx pnpm
WORKDIR /sandbox`;

  execSync(`echo '${dockerfile}' | docker build -t nightbot-sandbox:latest -`, {
    encoding: "utf-8",
    stdio: "inherit",
  });
}
