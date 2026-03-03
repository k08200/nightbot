import { execSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Command } from "commander";
import { loadConfig } from "./config.js";
import { startDashboard } from "./dashboard.js";
import { LLM } from "./llm.js";
import { startOrchestrator } from "./orchestrator.js";
import { generateBriefing } from "./planner.js";
import { buildSandboxImage } from "./sandbox.js";
import { runScout, saveReport } from "./scout.js";
import { createTask, loadTasks, saveTask, type TaskType } from "./task.js";

const program = new Command();

program
  .name("nightbot")
  .description("Night Bot — 24/7 AI development crew")
  .version("0.1.0");

program
  .command("start")
  .description("Start the daemon")
  .action(async () => {
    const config = loadConfig();
    await startOrchestrator(config);
  });

program
  .command("add <question>")
  .description("Add a task to the queue")
  .option("-t, --type <type>", "Task type", "feasibility")
  .option("-c, --context <path>", "Project path to mount")
  .option("-m, --mode <mode>", "Task mode: research or implement", "research")
  .option("-r, --repo <path>", "Target repo path (implement mode)")
  .action((question, opts) => {
    const config = loadConfig();
    const mode = opts.mode === "implement" ? "implement" : "research";
    const task = createTask(question, opts.type as TaskType, opts.context, mode, opts.repo);
    const path = saveTask(task, config.paths.queue);
    console.log(`✓ Task added: ${task.id}`);
    console.log(`  Question: ${question}`);
    console.log(`  Type: ${opts.type}`);
    console.log(`  Mode: ${mode}`);
    if (mode === "implement") console.log(`  Repo: ${opts.repo ?? opts.context ?? "(none)"}`);
    console.log(`  Saved: ${path}`);
  });

program
  .command("status")
  .description("Show current status")
  .action(async () => {
    const config = loadConfig();
    const llm = new LLM(config.ollama.host);
    const available = await llm.isAvailable();

    console.log("Night Bot Status");
    console.log(`  ollama: ${available ? "✅ connected" : "❌ not reachable"}`);

    for (const status of ["pending", "running", "done", "failed", "escalated"] as const) {
      const tasks = loadTasks(config.paths.queue, status);
      if (tasks.length > 0) console.log(`  ${status}: ${tasks.length} tasks`);
    }

    const planPath = resolve(config.paths.plans, "current.json");
    console.log(`  plan: ${existsSync(planPath) ? "exists" : "none"}`);

    const reportsDir = config.paths.reports;
    if (existsSync(reportsDir)) {
      const count = readdirSync(reportsDir).filter(f => f.endsWith(".md")).length;
      console.log(`  reports: ${count}`);
    }
  });

program
  .command("queue")
  .description("Show task queue")
  .action(() => {
    const config = loadConfig();
    for (const status of ["pending", "running", "done", "failed", "escalated"] as const) {
      const tasks = loadTasks(config.paths.queue, status);
      if (tasks.length > 0) {
        console.log(`\n${status.toUpperCase()} (${tasks.length})`);
        for (const t of tasks) console.log(`  [${t.id}] ${t.question}`);
      }
    }
  });

program
  .command("reports")
  .description("List reports")
  .action(() => {
    const config = loadConfig();
    if (!existsSync(config.paths.reports)) {
      console.log("No reports yet."); return;
    }
    const files = readdirSync(config.paths.reports).filter(f => f.endsWith(".md")).sort().reverse();
    for (const f of files.slice(0, 10)) {
      const first = readFileSync(resolve(config.paths.reports, f), "utf-8").split("\n")[0];
      console.log(`  ${f}: ${first}`);
    }
  });

program
  .command("briefing")
  .description("Generate morning briefing")
  .action(async () => {
    const config = loadConfig();
    const llm = new LLM(config.ollama.host);
    if (!(await llm.isAvailable())) {
      console.error("❌ ollama not reachable"); return;
    }
    console.log("Generating briefing...\n");
    const briefing = await generateBriefing(config, llm);
    console.log(briefing);
  });

program
  .command("plan")
  .description("Show current plan")
  .action(() => {
    const config = loadConfig();
    const planPath = resolve(config.paths.plans, "current.json");
    if (!existsSync(planPath)) {
      console.log("No plan yet. Run: nightbot start"); return;
    }
    const plan = JSON.parse(readFileSync(planPath, "utf-8")) as {
      tasks?: Array<{ id: string; name: string; status: string }>;
      executionOrder?: string[];
      reasoning?: string;
    };
    console.log(`Plan (${plan.tasks?.length ?? 0} tasks)`);
    console.log(`Reasoning: ${plan.reasoning ?? "n/a"}\n`);
    const icons: Record<string, string> = { ready: "⏳", done: "✅", failed: "❌", running: "🔄" };
    const order = plan.executionOrder ?? [];
    for (let i = 0; i < order.length; i++) {
      const id = order[i];
      const t = plan.tasks?.find(x => x.id === id);
      if (t) console.log(`  ${i + 1}. ${icons[t.status] ?? "?"} [${t.id}] ${t.name}`);
    }
  });

program
  .command("setup")
  .description("Build sandbox image and check dependencies")
  .action(async () => {
    console.log("Night Bot Setup\n");

    const config = loadConfig();
    const llm = new LLM(config.ollama.host);
    if (await llm.isAvailable()) {
      const models = await llm.listModels();
      console.log(`✅ ollama: ${models.length} models`);
      for (const m of models) console.log(`   - ${m}`);
    } else {
      console.log("❌ ollama: not reachable (run: ollama serve)");
    }

    try {
      execSync("docker info", { stdio: "ignore" });
      console.log("✅ Docker: running");
    } catch {
      console.log("❌ Docker: not running"); return;
    }

    console.log("\nBuilding sandbox image...");
    try {
      buildSandboxImage();
      console.log("✅ Sandbox image built");
    } catch (e) {
      console.log(`❌ Sandbox build failed: ${e}`);
    }

    for (const d of [config.paths.plans, config.paths.reports, config.paths.decisions, config.paths.queue]) {
      mkdirSync(d, { recursive: true });
    }
    console.log("✅ Directories created");

    const example = "config/nightbot.example.yaml";
    const target = "config/nightbot.yaml";
    if (existsSync(example) && !existsSync(target)) {
      copyFileSync(example, target);
      console.log("✅ Config copied (edit config/nightbot.yaml)");
    }

    console.log("\nSetup complete! Next: nightbot add 'your first task'");
  });


program
  .command('run <question>')
  .description('Run a single scout task immediately (no queue, no planner)')
  .option('-t, --type <type>', 'Task type', 'feasibility')
  .option('-c, --context <path>', 'Project path to mount')
  .option('-m, --mode <mode>', 'Task mode: research or implement', 'research')
  .option('-r, --repo <path>', 'Target repo path (implement mode)')
  .action(async (question, opts) => {
    const config = loadConfig();
    const llm = new LLM(config.ollama.host);

    if (!(await llm.isAvailable())) {
      console.error('❌ ollama not reachable. Run: ollama serve');
      return;
    }

    const mode = opts.mode === "implement" ? "implement" as const : "research" as const;
    const task = createTask(question, opts.type, opts.context, mode, opts.repo);
    const modeLabel = mode === "implement" ? "🔧 Implement" : "🔍 Research";

    console.log('');
    console.log(`${modeLabel} starting: ${task.id}`);
    console.log(`   Question: ${question}`);
    if (mode === "implement") console.log(`   Repo: ${opts.repo ?? opts.context ?? "(none)"}`);
    console.log('');

    const result = await runScout(task, config, llm);
    const path = saveReport(result, config.paths.reports);

    console.log('');
    console.log(`✅ Done in ${(result.durationMs / 1000).toFixed(0)}s (${result.iterations} iterations)`);
    console.log(`📄 Report: ${path}`);

    if (mode === "implement" && result.changedFiles?.length) {
      console.log(`📝 Files changed: ${result.changedFiles.length}`);
      for (const f of result.changedFiles) {
        console.log(`   - ${f.path}`);
      }
    }

    console.log('');
    console.log(result.report);
  });

program
  .command("dashboard")
  .description("Open the EVE monitoring dashboard in your browser")
  .option("-p, --port <port>", "Port number", "3847")
  .action((opts) => {
    const config = loadConfig();
    const port = Number.parseInt(opts.port, 10);
    startDashboard(config, port);
  });

program.parse();
