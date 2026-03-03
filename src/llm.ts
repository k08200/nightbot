export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

export class LLM {
  constructor(private host: string = "http://localhost:11434") {
    this.host = host.replace(/\/$/, "");
  }

  async chat(model: string, messages: Message[], temperature = 0.7): Promise<string> {
    const resp = await fetch(`${this.host}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        options: { temperature },
      }),
    });

    if (!resp.ok) {
      throw new Error(`ollama error ${resp.status}: ${await resp.text()}`);
    }

    const data = await resp.json() as any;
    return data.message.content;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const resp = await fetch(`${this.host}/api/tags`, {
        signal: AbortSignal.timeout(5000),
      });
      return resp.ok;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<string[]> {
    const resp = await fetch(`${this.host}/api/tags`);
    const data = await resp.json() as any;
    return (data.models ?? []).map((m: any) => m.name);
  }
}
