import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';

// ─── Constants ───────────────────────────────────────────────────────────────

export const IMPROVED_TODO_DIR_ENV = 'IMPROVED_TODO_DIR';
export const IMPROVED_TODO_VERIFICATION_PASSPHRASE_ENV =
  'IMPROVED_TODO_VERIFICATION_PASSPHRASE';

export const DEFAULT_TODO_DIR = join(
  process.env.HOME ?? '/tmp',
  '.local',
  'share',
  'opencode',
  'todos',
);

// ─── Types ───────────────────────────────────────────────────────────────────

export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';
export type TodoPriority = 'high' | 'medium' | 'low';

export type TodoNode = {
  id: string;
  content: string;
  status: TodoStatus;
  priority: TodoPriority;
  cancelReason?: string;
  children: TodoNode[];
};

export type PlanInput = {
  content: string;
  priority?: TodoPriority;
  children?: PlanInput[];
};

export type EditOp =
  | {
      type: 'add';
      parent_id?: string;
      after_id?: string;
      content: string;
      priority?: TodoPriority;
    }
  | { type: 'update'; id: string; content?: string; priority?: TodoPriority }
  | { type: 'cancel'; id: string; reason: string };

// ─── Zod schemas (for tool arg validation) ───────────────────────────────────

export const PlanInputSchema: z.ZodType<PlanInput> = z.lazy(() =>
  z.object({
    content: z.string().describe('Brief description of the task'),
    priority: z
      .enum(['high', 'medium', 'low'])
      .optional()
      .describe('Priority level. Defaults to medium if omitted.'),
    children: z.array(PlanInputSchema).optional().describe('Nested subtasks'),
  }),
);

export const EditOpSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('add'),
    parent_id: z
      .string()
      .optional()
      .describe('ID of the parent node. Omit to add at the top level.'),
    after_id: z
      .string()
      .optional()
      .describe('Insert after this sibling ID. Omit to append.'),
    content: z.string().describe('Task description'),
    priority: z.enum(['high', 'medium', 'low']).optional(),
  }),
  z.object({
    type: z.literal('update'),
    id: z.string().describe('ID of the node to update'),
    content: z.string().optional(),
    priority: z.enum(['high', 'medium', 'low']).optional(),
  }),
  z.object({
    type: z.literal('cancel'),
    id: z.string().describe('ID of the node to cancel'),
    reason: z
      .string()
      .describe('Required explanation for why this task is being cancelled'),
  }),
]);

// ─── Slug generation ─────────────────────────────────────────────────────────

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 64);
}

function uniqueSlug(content: string, existing: Set<string>): string {
  const base = slugify(content);
  let candidate = base;
  let counter = 2;
  while (existing.has(candidate)) {
    candidate = `${base}-${counter}`;
    counter++;
  }
  existing.add(candidate);
  return candidate;
}

function assignSlugs(inputs: PlanInput[], existing: Set<string>): TodoNode[] {
  return inputs.map((input) => ({
    id: uniqueSlug(input.content, existing),
    content: input.content,
    status: 'pending',
    priority: input.priority ?? 'medium',
    children: assignSlugs(input.children ?? [], existing),
  }));
}

// ─── Path resolution ─────────────────────────────────────────────────────────

function resolveTodoDir(): string {
  return process.env[IMPROVED_TODO_DIR_ENV]?.trim() ?? DEFAULT_TODO_DIR;
}

export function resolveTodoFilePath(sessionID: string): string {
  return join(resolveTodoDir(), `${sessionID}.md`);
}

// ─── Serialization ───────────────────────────────────────────────────────────

const STATUS_CHAR: Record<TodoStatus, string> = {
  pending: ' ',
  in_progress: '-',
  completed: 'x',
  cancelled: '~',
};

function serializeNode(node: TodoNode, depth: number): string {
  const pad = '  '.repeat(depth);
  const ch = STATUS_CHAR[node.status];
  const pri = node.priority !== 'medium' ? ` (${node.priority})` : '';
  const cancelSuffix = node.cancelReason ? `; cancelled: ${node.cancelReason}` : '';
  const line = `${pad}- [${ch}] ${node.content}${pri} <!-- ${node.id}${cancelSuffix} -->`;
  const childLines = node.children.map((c) => serializeNode(c, depth + 1)).join('\n');
  return childLines ? `${line}\n${childLines}` : line;
}

export function serializeTodoForest(nodes: TodoNode[]): string {
  return nodes.map((n) => serializeNode(n, 0)).join('\n') + '\n';
}

// ─── Parsing ─────────────────────────────────────────────────────────────────

const CHAR_TO_STATUS: Record<string, TodoStatus> = {
  ' ': 'pending',
  '-': 'in_progress',
  x: 'completed',
  '~': 'cancelled',
};

const LINE_RE = /^( *)- \[(.)\] (.*?) <!-- ([^>]+) -->$/;

export function parseTodoForest(text: string): TodoNode[] {
  const lines = text.split('\n').filter((l) => l.trim());
  const stack: { node: TodoNode; depth: number }[] = [];
  const roots: TodoNode[] = [];

  for (const line of lines) {
    const match = LINE_RE.exec(line);
    if (!match) continue;

    const depth = match[1].length / 2;
    const statusChar = match[2];
    const contentAndPriority = match[3];
    const commentContent = match[4];

    const priorityMatch = /^(.*?) \((high|medium|low)\)$/.exec(contentAndPriority);
    const content = priorityMatch ? priorityMatch[1] : contentAndPriority;
    const priority = (priorityMatch ? priorityMatch[2] : 'medium') as TodoPriority;

    const cancelIdx = commentContent.indexOf('; cancelled: ');
    const id =
      cancelIdx === -1
        ? commentContent.trim()
        : commentContent.slice(0, cancelIdx).trim();
    const cancelReason =
      cancelIdx === -1
        ? undefined
        : commentContent.slice(cancelIdx + '; cancelled: '.length);

    const node: TodoNode = {
      id,
      content,
      status: CHAR_TO_STATUS[statusChar] ?? 'pending',
      priority,
      ...(cancelReason !== undefined ? { cancelReason } : {}),
      children: [],
    };

    while (stack.length > 0 && stack[stack.length - 1].depth >= depth) {
      stack.pop();
    }
    if (stack.length === 0) {
      roots.push(node);
    } else {
      stack[stack.length - 1].node.children.push(node);
    }
    stack.push({ node, depth });
  }

  return roots;
}

// ─── Load / Store ─────────────────────────────────────────────────────────────

export function loadTodoForest(sessionID: string): TodoNode[] {
  const filePath = resolveTodoFilePath(sessionID);
  try {
    return parseTodoForest(readFileSync(filePath, 'utf-8'));
  } catch {
    return [];
  }
}

export function storeTodoForest(sessionID: string, nodes: TodoNode[]): void {
  const filePath = resolveTodoFilePath(sessionID);
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, serializeTodoForest(nodes), 'utf-8');
  renameSync(tmp, filePath);
}

// ─── Tree utilities ───────────────────────────────────────────────────────────

export function collectAllIDs(nodes: TodoNode[]): Set<string> {
  const ids = new Set<string>();
  const visit = (ns: TodoNode[]) => {
    for (const n of ns) {
      ids.add(n.id);
      visit(n.children);
    }
  };
  visit(nodes);
  return ids;
}

export function findNode(nodes: TodoNode[], id: string): TodoNode | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    const found = findNode(node.children, id);
    if (found) return found;
  }
  return null;
}

function isTerminal(node: TodoNode): boolean {
  return node.status === 'completed' || node.status === 'cancelled';
}

/**
 * Returns the current actionable task: the first node in DFS order that is
 * not yet terminal, whose preceding siblings are all terminal, and whose
 * children are all terminal (i.e., it is the next leaf to work on).
 */
export function getCurrentTask(nodes: TodoNode[]): TodoNode | null {
  for (const node of nodes) {
    if (isTerminal(node)) continue;
    if (node.children.length > 0 && !node.children.every(isTerminal)) {
      return getCurrentTask(node.children);
    }
    return node;
  }
  return null;
}

export function countTodoNodes(nodes: TodoNode[]): number {
  return nodes.reduce((total, n) => total + 1 + countTodoNodes(n.children), 0);
}

// ─── Plan ────────────────────────────────────────────────────────────────────

export function createPlan(sessionID: string, inputs: PlanInput[]): TodoNode[] {
  const existing = loadTodoForest(sessionID);
  if (existing.length > 0) {
    throw new Error(
      'A plan already exists for this session. Use todo_edit to make surgical changes, or todo_advance to cancel tasks you no longer intend to do.',
    );
  }
  const nodes = assignSlugs(inputs, new Set());
  storeTodoForest(sessionID, nodes);
  return nodes;
}

// ─── Advance ─────────────────────────────────────────────────────────────────

export function advanceTodo(
  sessionID: string,
  id: string,
  action: 'complete' | 'cancel',
  reason?: string,
): { updated: TodoNode[]; next: TodoNode | null } {
  const nodes = loadTodoForest(sessionID);
  const current = getCurrentTask(nodes);

  if (!current) {
    throw new Error('No current task — all tasks are complete or cancelled.');
  }
  if (current.id !== id) {
    throw new Error(
      `The current task is "${current.id}" ("${current.content}"). ` +
        `You must advance the current task before any other.`,
    );
  }
  if (action === 'cancel' && !reason?.trim()) {
    throw new Error('A reason is required when cancelling a task.');
  }

  const mutate = (ns: TodoNode[]): TodoNode[] =>
    ns.map((n) => {
      if (n.id === id) {
        return {
          ...n,
          status: action === 'complete' ? 'completed' : 'cancelled',
          ...(action === 'cancel' ? { cancelReason: reason } : {}),
          children: mutate(n.children),
        };
      }
      return { ...n, children: mutate(n.children) };
    });

  const updated = mutate(nodes);
  storeTodoForest(sessionID, updated);
  return { updated, next: getCurrentTask(updated) };
}

// ─── Edit ─────────────────────────────────────────────────────────────────────

export function editTodos(sessionID: string, ops: EditOp[]): TodoNode[] {
  let nodes = loadTodoForest(sessionID);

  for (const op of ops) {
    if (op.type === 'add') {
      const existing = collectAllIDs(nodes);
      const newNode: TodoNode = {
        id: uniqueSlug(op.content, existing),
        content: op.content,
        status: 'pending',
        priority: op.priority ?? 'medium',
        children: [],
      };

      if (!op.parent_id) {
        if (op.after_id) {
          const idx = nodes.findIndex((n) => n.id === op.after_id);
          nodes = [...nodes.slice(0, idx + 1), newNode, ...nodes.slice(idx + 1)];
        } else {
          nodes = [...nodes, newNode];
        }
      } else {
        const insert = (ns: TodoNode[]): TodoNode[] =>
          ns.map((n) => {
            if (n.id === op.parent_id) {
              const siblings = op.after_id
                ? (() => {
                    const idx = n.children.findIndex((c) => c.id === op.after_id);
                    return [
                      ...n.children.slice(0, idx + 1),
                      newNode,
                      ...n.children.slice(idx + 1),
                    ];
                  })()
                : [...n.children, newNode];
              return { ...n, children: siblings };
            }
            return { ...n, children: insert(n.children) };
          });
        nodes = insert(nodes);
      }
    } else if (op.type === 'update') {
      const target = findNode(nodes, op.id);
      if (!target) throw new Error(`No node with id "${op.id}"`);
      if (isTerminal(target)) {
        throw new Error(`Cannot update a ${target.status} node.`);
      }
      const update = (ns: TodoNode[]): TodoNode[] =>
        ns.map((n) => {
          if (n.id === op.id) {
            return {
              ...n,
              ...(op.content !== undefined ? { content: op.content } : {}),
              ...(op.priority !== undefined ? { priority: op.priority } : {}),
            };
          }
          return { ...n, children: update(n.children) };
        });
      nodes = update(nodes);
    } else if (op.type === 'cancel') {
      const target = findNode(nodes, op.id);
      if (!target) throw new Error(`No node with id "${op.id}"`);
      if (target.status === 'completed') {
        throw new Error('Cannot cancel a completed node.');
      }
      if (target.status === 'cancelled') {
        throw new Error(`Node "${op.id}" is already cancelled.`);
      }
      const cancel = (ns: TodoNode[]): TodoNode[] =>
        ns.map((n) => {
          if (n.id === op.id) {
            return { ...n, status: 'cancelled', cancelReason: op.reason };
          }
          return { ...n, children: cancel(n.children) };
        });
      nodes = cancel(nodes);
    }
  }

  storeTodoForest(sessionID, nodes);
  return nodes;
}

// ─── Display helpers ──────────────────────────────────────────────────────────

function statusMarker(status: TodoStatus): string {
  if (status === 'completed') return '[x]';
  if (status === 'in_progress') return '[-]';
  if (status === 'cancelled') return '[~]';
  return '[ ]';
}

function childSummary(children: TodoNode[]): string {
  if (children.length === 0) return '';
  if (children.length === 1) return ' (1 child)';
  return ` (${children.length} children)`;
}

export function summarizeTopLevelTodos(todos: TodoNode[]): string[] {
  return todos.map(
    (todo) =>
      `- ${statusMarker(todo.status)} ${todo.content}${childSummary(todo.children)}`,
  );
}

export function buildMarkdownTodoTree(
  todos: TodoNode[],
  current: TodoNode | null,
): string {
  const lines = ['# Todo Tree', ''];

  const visit = (nodes: TodoNode[], depth: number): void => {
    for (const node of nodes) {
      const pad = '  '.repeat(depth);
      const marker = statusMarker(node.status);
      const isCurrent = current && node.id === current.id ? ' ◄ current' : '';
      lines.push(`${pad}- ${marker} ${node.content}${isCurrent}`);
      visit(node.children, depth + 1);
    }
  };

  if (todos.length === 0) {
    lines.push('_No todos yet._');
  } else {
    visit(todos, 0);
  }

  return lines.join('\n');
}

export function buildTodoTreeReminder(): string {
  return [
    '<system-reminder>',
    'The full todo tree has already been displayed in chat.',
    'Refer to that displayed tree instead of repeating the full hierarchy unless the user asks for it again.',
    '</system-reminder>',
    '',
  ].join('\n');
}

export function buildTodoTreeResult(todos: TodoNode[], current: TodoNode | null) {
  const verificationPassphrase =
    process.env[IMPROVED_TODO_VERIFICATION_PASSPHRASE_ENV]?.trim() ?? '';

  const currentLine = current
    ? `\nCurrent task: ${current.id} — "${current.content}"`
    : '\nAll tasks complete.';

  const lines = [
    'Top-level todos:',
    ...summarizeTopLevelTodos(todos),
    '',
    'Todo tree (JSON):',
    JSON.stringify(todos, null, 2),
    currentLine,
  ];
  if (verificationPassphrase) {
    lines.push('', `Verification passphrase: ${verificationPassphrase}`);
  }

  return {
    title: `${todos.length} top-level todos`,
    metadata: {
      topLevelCount: todos.length,
      totalCount: countTodoNodes(todos),
      currentTaskId: current?.id ?? null,
    },
    output: lines.join('\n'),
  };
}
