import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import yaml from "js-yaml";

function loadDotEnv(): void {
  const envPath = resolve(process.cwd(), ".env");
  if (!existsSync(envPath)) return;
  const lines = readFileSync(envPath, "utf-8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
}

loadDotEnv();

export interface Config {
  llm: {
    apiKey: string;
    baseUrl: string;
    maxTokens: number;
  };
  models: {
    planner: string;
    scout: string;
    secretary: string;
    lightweight: string;
  };
  sandbox: {
    image: string;
    memory: string;
    cpus: number;
    network: string;
    autoDestroy: boolean;
  };
  escalation: {
    slackWebhook: string;
    slackChannel: string;
    cooldownMinutes: number;
  };
  circuitBreakers: {
    sameErrorLimit: number;
    iterationLimit: number;
    timeoutPerTaskHours: number;
    totalTimeoutHours: number;
  };
  contextCompression: {
    enabled: boolean;
    maxTokenEstimate: number;
    keepRecentMessages: number;
    compressAfterIteration: number;
  };
  gateRetry: {
    enabled: boolean;
    maxAttempts: number;
  };
  probeai: {
    enabled: boolean;
    scenarioDir: string;
  };
  scheduler: {
    checkIntervalSeconds: number;
  };
  paths: {
    plans: string;
    reports: string;
    decisions: string;
    queue: string;
    agents: string;
  };
}

const defaults: Config = {
  llm: {
    apiKey: process.env.OPENROUTER_API_KEY ?? "",
    baseUrl: "https://openrouter.ai/api/v1",
    maxTokens: 8192,
  },
  models: {
    planner: "anthropic/claude-sonnet-4-5",
    scout: "anthropic/claude-sonnet-4-5",
    secretary: "anthropic/claude-sonnet-4-5",
    lightweight: "anthropic/claude-haiku-4-5",
  },
  sandbox: {
    image: "nightbot-sandbox:latest",
    memory: "8g",
    cpus: 4,
    network: "host",
    autoDestroy: true,
  },
  escalation: {
    slackWebhook: "",
    slackChannel: "",
    cooldownMinutes: 30,
  },
  circuitBreakers: {
    sameErrorLimit: 3,
    iterationLimit: 20,
    timeoutPerTaskHours: 6,
    totalTimeoutHours: 10,
  },
  contextCompression: {
    enabled: true,
    maxTokenEstimate: 4000,
    keepRecentMessages: 4,
    compressAfterIteration: 3,
  },
  gateRetry: {
    enabled: true,
    maxAttempts: 2,
  },
  probeai: {
    enabled: false,
    scenarioDir: "./tests/probeai",
  },
  scheduler: {
    checkIntervalSeconds: 300,
  },
  paths: {
    plans: "./plans",
    reports: "./reports",
    decisions: "./decisions",
    queue: "./queue",
    agents: "./config/agents",
  },
};

export function loadConfig(path?: string): Config {
  const configPath = path ?? resolve("config/nightbot.yaml");
  if (!existsSync(configPath)) return defaults;

  const raw = yaml.load(readFileSync(configPath, "utf-8")) as Record<string, Record<string, unknown>> | null ?? {};
  return {
    llm: { ...defaults.llm, ...raw.llm },
    models: { ...defaults.models, ...raw.models },
    sandbox: { ...defaults.sandbox, ...raw.sandbox },
    escalation: { ...defaults.escalation, ...raw.escalation },
    circuitBreakers: { ...defaults.circuitBreakers, ...raw.circuit_breakers },
    contextCompression: { ...defaults.contextCompression, ...raw.context_compression },
    gateRetry: { ...defaults.gateRetry, ...raw.gate_retry },
    probeai: { ...defaults.probeai, ...raw.probeai },
    scheduler: { ...defaults.scheduler, ...raw.scheduler },
    paths: { ...defaults.paths, ...raw.paths },
  };
}

export function loadAgent(name: string, config: Config): Record<string, unknown> {
  const agentPath = resolve(config.paths.agents, `${name}.yaml`);
  if (!existsSync(agentPath)) throw new Error(`Agent not found: ${agentPath}`);
  return yaml.load(readFileSync(agentPath, "utf-8")) as Record<string, unknown>;
}
