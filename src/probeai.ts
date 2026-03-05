import { globSync } from "node:fs";
import { resolve } from "node:path";
import { loadScenarios, type ProbeResult, probe } from "probeai";

export interface ProbeVerification {
	passed: boolean;
	results: ProbeResult[];
	summary: string;
}

/** Run ProbeAI scenarios against a repo and return pass/fail */
export async function runProbeVerification(
	repoPath: string,
	scenarioDir: string,
): Promise<ProbeVerification> {
	const dir = resolve(repoPath, scenarioDir);
	const files = globSync(`${dir}/*.yaml`);

	if (!files.length) {
		return { passed: true, results: [], summary: "No scenarios found" };
	}

	const scenarios = loadScenarios(files);
	const results = await probe(scenarios, {
		outputDir: resolve(repoPath, "results"),
		markdown: false,
		verbose: false,
	});

	const failed = results.filter((r) => !r.evaluation.passed);

	return {
		passed: failed.length === 0,
		results,
		summary:
			failed.length === 0
				? `All ${results.length} scenario(s) passed`
				: `${failed.length}/${results.length} scenario(s) failed`,
	};
}

/** Format ProbeAI failures as feedback for Scout retry (matches gateFailureSummary pattern) */
export function formatProbeFailures(results: ProbeResult[]): string {
	return results
		.filter((r) => !r.evaluation.passed)
		.map((r) => {
			const details: string[] = [];
			if (r.evaluation.llmReasoning) {
				details.push(r.evaluation.llmReasoning.slice(0, 200));
			}
			if (r.evaluation.ruleDetails) {
				const failedRules = r.evaluation.ruleDetails
					.filter((d) => !d.passed)
					.map((d) => `${d.rule}: ${d.detail}`)
					.join(", ");
				if (failedRules) details.push(failedRules);
			}
			return `[${r.scenario.id}] score=${r.evaluation.score}/100${details.length ? ` — ${details.join("; ")}` : ""}`;
		})
		.join("\n");
}
