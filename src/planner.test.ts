import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getNextTask, type Plan } from "./planner.js";

describe("getNextTask", () => {
  const plan: Plan = {
    tasks: [
      { id: "t1", name: "First", type: "feasibility", dependsOn: [], estimatedHours: 1, status: "ready" },
      { id: "t2", name: "Second", type: "feasibility", dependsOn: ["t1"], estimatedHours: 1, status: "ready" },
      { id: "t3", name: "Third", type: "feasibility", dependsOn: [], estimatedHours: 1, status: "ready" },
    ],
    executionOrder: ["t1", "t2", "t3"],
    reasoning: "test plan",
  };

  it("returns the first task with no deps", () => {
    const next = getNextTask(plan, new Set());
    assert.equal(next, "t1");
  });

  it("returns next task when dependencies are met", () => {
    const planWithT1Done: Plan = {
      ...plan,
      tasks: plan.tasks.map(t => t.id === "t1" ? { ...t, status: "done" } : t),
    };
    const next = getNextTask(planWithT1Done, new Set(["t1"]));
    assert.equal(next, "t2");
  });

  it("skips completed tasks", () => {
    const planWithDone: Plan = {
      ...plan,
      tasks: plan.tasks.map(t => t.id === "t1" ? { ...t, status: "done" } : t),
    };
    const next = getNextTask(planWithDone, new Set(["t1"]));
    assert.equal(next, "t2");
  });

  it("returns null when all tasks are done", () => {
    const allDone: Plan = {
      ...plan,
      tasks: plan.tasks.map(t => ({ ...t, status: "done" })),
    };
    const next = getNextTask(allDone, new Set());
    assert.equal(next, null);
  });

  it("blocks task when deps are unmet", () => {
    const planCopy: Plan = {
      ...plan,
      tasks: plan.tasks.map(t => t.id === "t1" ? { ...t, status: "done" } : t),
      executionOrder: ["t2"],
    };
    // t2 depends on t1, t1 not in completed set
    const next = getNextTask(planCopy, new Set());
    assert.equal(next, null);
  });
});
