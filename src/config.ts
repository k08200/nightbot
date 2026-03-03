import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import yaml from "js-yaml";

export interface Config {
  ollama: { host: string };
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
  ollama: { host: "http://localhost:11434" },
  models: {
    planner: "qwen2.5:32b",
    scout: "qwen2.5-coder:14b",
    secretary: "qwen2.5:32b",
    lightweight: "llama3.1:8b",
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
    ollama: { ...defaults.ollama, ...raw.ollama },
    models: { ...defaults.models, ...raw.models },
    sandbox: { ...defaults.sandbox, ...raw.sandbox },
    escalation: { ...defaults.escalation, ...raw.escalation },
    circuitBreakers: { ...defaults.circuitBreakers, ...raw.circuit_breakers },
    scheduler: { ...defaults.scheduler, ...raw.scheduler },
    paths: { ...defaults.paths, ...raw.paths },
  };
}

export function loadAgent(name: string, config: Config): Record<string, unknown> {
  const agentPath = resolve(config.paths.agents, `${name}.yaml`);
  if (!existsSync(agentPath)) throw new Error(`Agent not found: ${agentPath}`);
  return yaml.load(readFileSync(agentPath, "utf-8")) as Record<string, unknown>;
}
