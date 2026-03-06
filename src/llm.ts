export interface Message {
	role: "system" | "user" | "assistant";
	content: string;
}

interface ChatResponse {
	choices: Array<{
		message: { role: string; content: string };
	}>;
}

export class LLM {
	private apiKey: string;
	private baseUrl: string;

	constructor(apiKey: string, baseUrl = "https://openrouter.ai/api/v1") {
		this.apiKey = apiKey;
		this.baseUrl = baseUrl.replace(/\/$/, "");
	}

	async chat(
		model: string,
		messages: Message[],
		temperature = 0.7,
		maxTokens = 8192,
	): Promise<string> {
		const resp = await fetch(`${this.baseUrl}/chat/completions`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${this.apiKey}`,
			},
			body: JSON.stringify({
				model,
				messages,
				temperature,
				max_tokens: maxTokens,
			}),
		});

		if (!resp.ok) {
			const body = await resp.text();
			throw new Error(`LLM API error ${resp.status}: ${body}`);
		}

		const data = (await resp.json()) as ChatResponse;
		return data.choices[0]?.message?.content ?? "";
	}

	async isAvailable(): Promise<boolean> {
		try {
			const resp = await fetch(`${this.baseUrl}/models`, {
				headers: { Authorization: `Bearer ${this.apiKey}` },
				signal: AbortSignal.timeout(5000),
			});
			return resp.ok;
		} catch {
			return false;
		}
	}

	async listModels(): Promise<string[]> {
		try {
			const resp = await fetch(`${this.baseUrl}/models`, {
				headers: { Authorization: `Bearer ${this.apiKey}` },
			});
			const data = (await resp.json()) as {
				data?: Array<{ id: string }>;
			};
			return (data.data ?? []).map((m) => m.id).slice(0, 20);
		} catch {
			return [];
		}
	}
}
