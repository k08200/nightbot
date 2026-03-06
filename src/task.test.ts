import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createTask, loadTasks, moveTask, saveTask } from "./task.js";

describe("createTask", () => {
  it("creates a task with defaults", () => {
    const task = createTask("What is Node?");
    assert.match(task.id, /^task-[a-f0-9]{8}$/);
    assert.equal(task.question, "What is Node?");
    assert.equal(task.type, "feasibility");
    assert.equal(task.mode, "research");
    assert.equal(task.status, "pending");
    assert.deepEqual(task.dependsOn, []);
  });

  it("accepts custom type and mode", () => {
    const task = createTask("Migrate DB", "migration", "/proj", "implement", "/repo");
    assert.equal(task.type, "migration");
    assert.equal(task.mode, "implement");
    assert.equal(task.context, "/proj");
    assert.equal(task.targetRepo, "/repo");
  });
});

describe("saveTask / loadTasks", () => {
  let dir: string;

  beforeEach(() => {
    dir = resolve(tmpdir(), `nightbot-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("saves a task as YAML and loads it back", () => {
    const task = createTask("Test save");
    const path = saveTask(task, dir);
    assert.ok(existsSync(path));
    assert.ok(readFileSync(path, "utf-8").includes("Test save"));

    const loaded = loadTasks(dir, "pending");
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].id, task.id);
    assert.equal(loaded[0].question, "Test save");
  });

  it("returns empty array for missing status dir", () => {
    const loaded = loadTasks(dir, "running");
    assert.deepEqual(loaded, []);
  });
});

describe("moveTask", () => {
  let dir: string;

  beforeEach(() => {
    dir = resolve(tmpdir(), `nightbot-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("moves task from pending to done", () => {
    const task = createTask("Move me");
    saveTask(task, dir);
    assert.equal(loadTasks(dir, "pending").length, 1);

    moveTask(task, dir, "done");
    assert.equal(loadTasks(dir, "pending").length, 0);
    assert.equal(loadTasks(dir, "done").length, 1);
    assert.equal(task.status, "done");
  });
});
