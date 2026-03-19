import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  advanceTodo,
  buildMarkdownTodoTree,
  buildTodoTreeResult,
  createPlan,
  editTodos,
  getCurrentTask,
  loadTodoForest,
  parseTodoForest,
  resetTodoStoreForTesting,
  serializeTodoForest,
  storeTodoForest,
  type TodoNode,
} from "../../src/todo-tree.ts";
import { ImprovedTodowritePlugin } from "../../src/index.ts";
import { IMPROVED_TODO_DIR_ENV } from "../../src/todo-tree.ts";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

// A realistic tree: phase-1 is in_progress, task-1 done, task-2/subtask-1 pending.
// The current task is subtask-1 (first incomplete leaf in DFS).
const TODO_TREE: TodoNode[] = [
  {
    id: "ship-persistence-layer",
    content: "Ship persistence layer",
    status: "in_progress",
    priority: "high",
    children: [
      {
        id: "design-schema",
        content: "Design schema",
        status: "completed",
        priority: "high",
        children: [],
      },
      {
        id: "implement-writes",
        content: "Implement writes",
        status: "pending",
        priority: "high",
        children: [
          {
            id: "add-transaction-wrapper",
            content: "Add transaction wrapper",
            status: "pending",
            priority: "medium",
            children: [],
          },
        ],
      },
    ],
  },
  {
    id: "add-mcp-coverage",
    content: "Add MCP coverage",
    status: "pending",
    priority: "medium",
    children: [],
  },
];

// ─── Test setup ───────────────────────────────────────────────────────────────

function withVerificationPassphrase<T>(
  passphrase: string | undefined,
  callback: () => T,
): T {
  const previous = process.env.IMPROVED_TODO_VERIFICATION_PASSPHRASE;
  if (passphrase === undefined) {
    delete process.env.IMPROVED_TODO_VERIFICATION_PASSPHRASE;
  } else {
    process.env.IMPROVED_TODO_VERIFICATION_PASSPHRASE = passphrase;
  }
  try {
    return callback();
  } finally {
    if (previous === undefined) {
      delete process.env.IMPROVED_TODO_VERIFICATION_PASSPHRASE;
    } else {
      process.env.IMPROVED_TODO_VERIFICATION_PASSPHRASE = previous;
    }
  }
}

async function createPlugin() {
  const promptCalls: unknown[] = [];
  return ImprovedTodowritePlugin({
    client: {
      app: { log() {} },
      session: {
        async prompt(input: unknown) {
          promptCalls.push(input);
        },
      },
    } as never,
    project: {} as never,
    directory: "/tmp",
    worktree: "/tmp",
    serverUrl: new URL("http://127.0.0.1:4096"),
    $: {} as never,
  }).then((plugin) => ({ plugin, promptCalls }));
}

let tempDir = "";

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "improved-todo-test-"));
  process.env[IMPROVED_TODO_DIR_ENV] = tempDir;
  resetTodoStoreForTesting();
});

afterEach(async () => {
  resetTodoStoreForTesting();
  delete process.env[IMPROVED_TODO_DIR_ENV];
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
  tempDir = "";
});

// ─── Serialization round-trip ─────────────────────────────────────────────────

describe("markdown serialization", () => {
  it("round-trips a nested tree through serialize → parse", () => {
    const serialized = serializeTodoForest(TODO_TREE);
    expect(parseTodoForest(serialized)).toEqual(TODO_TREE);
  });

  it("preserves cancel reasons through a round-trip", () => {
    const tree: TodoNode[] = [
      {
        id: "do-thing",
        content: "Do the thing",
        status: "cancelled",
        priority: "high",
        cancelReason: "No longer needed; replaced by do-better-thing",
        children: [],
      },
    ];
    expect(parseTodoForest(serializeTodoForest(tree))).toEqual(tree);
  });

  it("omits priority suffix for medium-priority nodes", () => {
    const serialized = serializeTodoForest([
      {
        id: "a",
        content: "A task",
        status: "pending",
        priority: "medium",
        children: [],
      },
    ]);
    expect(serialized).not.toContain("(medium)");
    expect(parseTodoForest(serialized)[0].priority).toBe("medium");
  });

  it("encodes all four statuses with distinct markers", () => {
    const tree: TodoNode[] = [
      { id: "p", content: "Pending", status: "pending", priority: "medium", children: [] },
      { id: "i", content: "In progress", status: "in_progress", priority: "medium", children: [] },
      { id: "c", content: "Completed", status: "completed", priority: "medium", children: [] },
      { id: "x", content: "Cancelled", status: "cancelled", priority: "medium", cancelReason: "reason", children: [] },
    ];
    const text = serializeTodoForest(tree);
    expect(text).toContain("- [ ] Pending");
    expect(text).toContain("- [-] In progress");
    expect(text).toContain("- [x] Completed");
    expect(text).toContain("- [~] Cancelled");
  });
});

// ─── File persistence ─────────────────────────────────────────────────────────

describe("file persistence", () => {
  it("persists sessions independently", () => {
    storeTodoForest("ses_a", TODO_TREE);
    storeTodoForest("ses_b", [
      {
        id: "solo",
        content: "Unrelated task",
        status: "pending",
        priority: "low",
        children: [],
      },
    ]);

    expect(loadTodoForest("ses_a")).toEqual(TODO_TREE);
    expect(loadTodoForest("ses_b")).toEqual([
      {
        id: "solo",
        content: "Unrelated task",
        status: "pending",
        priority: "low",
        children: [],
      },
    ]);
  });

  it("returns an empty array when no file exists", () => {
    expect(loadTodoForest("ses_nonexistent")).toEqual([]);
  });
});

// ─── getCurrentTask linearity ─────────────────────────────────────────────────

describe("getCurrentTask", () => {
  it("returns the first incomplete leaf in DFS order", () => {
    // subtask-1 is the first incomplete leaf (task-1 is complete, then we
    // enter task-2 and find its child subtask-1)
    const current = getCurrentTask(TODO_TREE);
    expect(current?.id).toBe("add-transaction-wrapper");
  });

  it("returns a parent node when all its children are terminal", () => {
    const tree: TodoNode[] = [
      {
        id: "phase",
        content: "Phase",
        status: "pending",
        priority: "medium",
        children: [
          { id: "c1", content: "C1", status: "completed", priority: "medium", children: [] },
          { id: "c2", content: "C2", status: "cancelled", priority: "medium", cancelReason: "dropped", children: [] },
        ],
      },
    ];
    expect(getCurrentTask(tree)?.id).toBe("phase");
  });

  it("returns null when all tasks are terminal", () => {
    const tree: TodoNode[] = [
      { id: "a", content: "A", status: "completed", priority: "medium", children: [] },
      { id: "b", content: "B", status: "cancelled", priority: "medium", cancelReason: "dropped", children: [] },
    ];
    expect(getCurrentTask(tree)).toBeNull();
  });

  it("skips completed siblings before descending into a pending node", () => {
    const tree: TodoNode[] = [
      { id: "a", content: "A", status: "completed", priority: "medium", children: [] },
      { id: "b", content: "B", status: "pending", priority: "medium", children: [] },
      { id: "c", content: "C", status: "pending", priority: "medium", children: [] },
    ];
    expect(getCurrentTask(tree)?.id).toBe("b");
  });
});

// ─── createPlan ───────────────────────────────────────────────────────────────

describe("createPlan", () => {
  it("assigns slug IDs from content and stores the tree", () => {
    const nodes = createPlan("ses_plan", [
      { content: "Design the API", priority: "high" },
      { content: "Implement the API", children: [{ content: "Write handlers" }] },
    ]);

    expect(nodes[0].id).toBe("design-the-api");
    expect(nodes[1].id).toBe("implement-the-api");
    expect(nodes[1].children[0].id).toBe("write-handlers");
    expect(nodes.every((n) => n.status === "pending")).toBe(true);
    expect(loadTodoForest("ses_plan")).toEqual(nodes);
  });

  it("deduplicates slug IDs when content collides", () => {
    const nodes = createPlan("ses_dupe", [
      { content: "Fix bug" },
      { content: "Fix bug" },
      { content: "Fix bug" },
    ]);
    expect(nodes.map((n) => n.id)).toEqual(["fix-bug", "fix-bug-2", "fix-bug-3"]);
  });

  it("throws if a plan already exists", () => {
    storeTodoForest("ses_exists", TODO_TREE);
    expect(() => createPlan("ses_exists", [{ content: "New plan" }])).toThrow(
      "A plan already exists",
    );
  });
});

// ─── advanceTodo ──────────────────────────────────────────────────────────────

describe("advanceTodo", () => {
  it("completes the current task and returns the next", () => {
    storeTodoForest("ses_adv", TODO_TREE);
    const { updated, next } = advanceTodo(
      "ses_adv",
      "add-transaction-wrapper",
      "complete",
    );
    const completed = updated[0].children[1].children[0];
    expect(completed.status).toBe("completed");
    // Next current task should now be implement-writes (all its children done)
    expect(next?.id).toBe("implement-writes");
  });

  it("rejects advancing a non-current task", () => {
    storeTodoForest("ses_adv2", TODO_TREE);
    expect(() =>
      advanceTodo("ses_adv2", "add-mcp-coverage", "complete"),
    ).toThrow("The current task is");
  });

  it("cancels the current task and records the reason", () => {
    storeTodoForest("ses_cancel", TODO_TREE);
    const { updated } = advanceTodo(
      "ses_cancel",
      "add-transaction-wrapper",
      "cancel",
      "Superseded by a new approach",
    );
    const node = updated[0].children[1].children[0];
    expect(node.status).toBe("cancelled");
    expect(node.cancelReason).toBe("Superseded by a new approach");
  });

  it("requires a reason when cancelling", () => {
    storeTodoForest("ses_noreason", TODO_TREE);
    expect(() =>
      advanceTodo("ses_noreason", "add-transaction-wrapper", "cancel"),
    ).toThrow("reason is required");
  });

  it("throws when no tasks remain", () => {
    const allDone: TodoNode[] = [
      { id: "a", content: "A", status: "completed", priority: "medium", children: [] },
    ];
    storeTodoForest("ses_done", allDone);
    expect(() => advanceTodo("ses_done", "a", "complete")).toThrow(
      "No current task",
    );
  });
});

// ─── editTodos ────────────────────────────────────────────────────────────────

describe("editTodos", () => {
  it("adds a new task at the top level", () => {
    storeTodoForest("ses_edit", TODO_TREE);
    const updated = editTodos("ses_edit", [
      { type: "add", content: "Write release notes", priority: "low" },
    ]);
    const last = updated[updated.length - 1];
    expect(last.content).toBe("Write release notes");
    expect(last.status).toBe("pending");
    expect(last.priority).toBe("low");
  });

  it("adds a child task under an existing node", () => {
    storeTodoForest("ses_child", TODO_TREE);
    const updated = editTodos("ses_child", [
      {
        type: "add",
        parent_id: "implement-writes",
        content: "Add error handling",
      },
    ]);
    const parent = updated[0].children[1];
    expect(parent.children).toHaveLength(2);
    expect(parent.children[1].content).toBe("Add error handling");
  });

  it("updates content and priority of a pending node", () => {
    storeTodoForest("ses_upd", TODO_TREE);
    const updated = editTodos("ses_upd", [
      {
        type: "update",
        id: "add-transaction-wrapper",
        content: "Add retry logic",
        priority: "high",
      },
    ]);
    const node = updated[0].children[1].children[0];
    expect(node.content).toBe("Add retry logic");
    expect(node.priority).toBe("high");
  });

  it("refuses to update a completed node", () => {
    storeTodoForest("ses_noupd", TODO_TREE);
    expect(() =>
      editTodos("ses_noupd", [
        { type: "update", id: "design-schema", content: "Changed" },
      ]),
    ).toThrow("Cannot update a completed node");
  });

  it("cancels a pending (non-current) node with a reason", () => {
    storeTodoForest("ses_editcancel", TODO_TREE);
    const updated = editTodos("ses_editcancel", [
      {
        type: "cancel",
        id: "add-mcp-coverage",
        reason: "Deprioritised for this release",
      },
    ]);
    const node = updated[1];
    expect(node.status).toBe("cancelled");
    expect(node.cancelReason).toBe("Deprioritised for this release");
  });

  it("refuses to cancel a completed node", () => {
    storeTodoForest("ses_nocancel", TODO_TREE);
    expect(() =>
      editTodos("ses_nocancel", [
        { type: "cancel", id: "design-schema", reason: "oops" },
      ]),
    ).toThrow("Cannot cancel a completed node");
  });

  it("throws for an unknown ID", () => {
    storeTodoForest("ses_noid", TODO_TREE);
    expect(() =>
      editTodos("ses_noid", [{ type: "update", id: "ghost-node", content: "x" }]),
    ).toThrow('No node with id "ghost-node"');
  });
});

// ─── Display helpers ──────────────────────────────────────────────────────────

describe("display helpers", () => {
  it("builds a human-readable summary with current task marked", () => {
    const current = getCurrentTask(TODO_TREE);
    withVerificationPassphrase(undefined, () => {
      const result = buildTodoTreeResult(TODO_TREE, current);
      expect(result.title).toBe("2 top-level todos");
      expect(result.metadata).toEqual({
        topLevelCount: 2,
        totalCount: 5,
        currentTaskId: "add-transaction-wrapper",
      });
      expect(result.output).toContain("Current task: add-transaction-wrapper");
    });
  });

  it("appends a verification passphrase when set", () => {
    const current = getCurrentTask(TODO_TREE);
    withVerificationPassphrase("SWORDFISH-TODO-TREE", () => {
      expect(buildTodoTreeResult(TODO_TREE, current).output).toContain(
        "Verification passphrase: SWORDFISH-TODO-TREE",
      );
    });
  });

  it("marks the current task in the markdown tree", () => {
    const current = getCurrentTask(TODO_TREE);
    const md = buildMarkdownTodoTree(TODO_TREE, current);
    expect(md).toContain("Add transaction wrapper ◄ current");
  });

  it("builds the markdown tree without a current marker when all done", () => {
    const allDone: TodoNode[] = [
      { id: "a", content: "Done task", status: "completed", priority: "medium", children: [] },
    ];
    const md = buildMarkdownTodoTree(allDone, null);
    expect(md).not.toContain("◄");
    expect(md).toContain("[x] Done task");
  });
});

// ─── Plugin tool surface ──────────────────────────────────────────────────────

describe("ImprovedTodowritePlugin tool surface", () => {
  function makeContext(sessionID: string, calls: unknown[]) {
    return {
      sessionID,
      messageID: `msg_${sessionID}`,
      agent: "opencode-plugin-improved-todowrite-proof",
      directory: "/tmp",
      worktree: "/tmp",
      abort: new AbortController().signal,
      metadata() {},
      async ask(input: unknown) {
        calls.push(input);
      },
    };
  }

  it("todo_plan creates a plan and blocks a second call", async () => {
    const { plugin } = await createPlugin();
    const calls: unknown[] = [];
    await plugin.tool!.todo_plan.execute(
      { todos: [{ content: "Phase 1" }, { content: "Phase 2" }] },
      makeContext("ses_plugin", calls),
    );

    await expect(
      plugin.tool!.todo_plan.execute(
        { todos: [{ content: "Overwrite" }] },
        makeContext("ses_plugin", calls),
      ),
    ).rejects.toThrow("A plan already exists");
  });

  it("todo_read returns current tree and current task", async () => {
    const { plugin } = await createPlugin();
    const calls: unknown[] = [];
    storeTodoForest("ses_read", TODO_TREE);
    const result = await plugin.tool!.todo_read.execute(
      {},
      makeContext("ses_read", calls),
    );
    expect(result).toContain("add-transaction-wrapper");
    expect(calls).toEqual([
      { permission: "todo_read", patterns: ["*"], always: ["*"], metadata: {} },
    ]);
  });

  it("todo_advance requires the correct current task ID", async () => {
    const { plugin } = await createPlugin();
    const calls: unknown[] = [];
    storeTodoForest("ses_tool_adv", TODO_TREE);

    await expect(
      plugin.tool!.todo_advance.execute(
        { id: "add-mcp-coverage", action: "complete" },
        makeContext("ses_tool_adv", calls),
      ),
    ).rejects.toThrow("The current task is");

    await plugin.tool!.todo_advance.execute(
      { id: "add-transaction-wrapper", action: "complete" },
      makeContext("ses_tool_adv", calls),
    );
    expect(loadTodoForest("ses_tool_adv")[0].children[1].children[0].status).toBe(
      "completed",
    );
  });

  it("todo_edit makes surgical changes without touching status", async () => {
    const { plugin } = await createPlugin();
    const calls: unknown[] = [];
    storeTodoForest("ses_tool_edit", TODO_TREE);

    await plugin.tool!.todo_edit.execute(
      {
        ops: [
          { type: "add", content: "New trailing task" },
          { type: "update", id: "add-transaction-wrapper", content: "Revised task" },
        ],
      },
      makeContext("ses_tool_edit", calls),
    );

    const updated = loadTodoForest("ses_tool_edit");
    expect(updated[updated.length - 1].content).toBe("New trailing task");
    expect(updated[0].children[1].children[0].content).toBe("Revised task");
    expect(updated[0].children[1].children[0].status).toBe("pending");
  });
});
