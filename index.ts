#!/usr/bin/env bun
import {
  advanceTodo,
  buildMarkdownTodoTree,
  buildTodoTreeReminder,
  createPlan,
  editTodos,
  getCurrentTask,
  loadTodoForest,
  buildTodoTreeResult,
} from './src/todo-tree.ts';

async function main() {
  const args = Bun.argv.slice(2);
  if (args.length < 3) {
    console.error('Usage: todowrite <session_id> <tool_name> <json_args>');
    process.exit(1);
  }

  const sessionID = args[0];
  const toolName = args[1];
  const jsonArgs = JSON.parse(args[2]);

  try {
    let result: any;
    if (toolName === 'todo_plan') {
      const nodes = createPlan(sessionID, jsonArgs.todos);
      const current = getCurrentTask(nodes);
      result = {
        todos: nodes,
        current,
        markdown: buildMarkdownTodoTree(nodes, current),
        reminder: buildTodoTreeReminder(),
        display: buildTodoTreeResult(nodes, current),
      };
    } else if (toolName === 'todo_read') {
      const nodes = loadTodoForest(sessionID);
      const current = getCurrentTask(nodes);
      result = {
        todos: nodes,
        current,
        markdown: buildMarkdownTodoTree(nodes, current),
        reminder: buildTodoTreeReminder(),
        display: buildTodoTreeResult(nodes, current),
      };
    } else if (toolName === 'todo_advance') {
      const { updated, next } = advanceTodo(
        sessionID,
        jsonArgs.id,
        jsonArgs.action,
        jsonArgs.reason,
      );
      result = {
        todos: updated,
        current: next,
        markdown: buildMarkdownTodoTree(updated, next),
        reminder: buildTodoTreeReminder(),
        display: buildTodoTreeResult(updated, next),
      };
    } else if (toolName === 'todo_edit') {
      const updated = editTodos(sessionID, jsonArgs.ops);
      const current = getCurrentTask(updated);
      result = {
        todos: updated,
        current,
        markdown: buildMarkdownTodoTree(updated, current),
        reminder: buildTodoTreeReminder(),
        display: buildTodoTreeResult(updated, current),
      };
    } else {
      console.error(`Unknown tool: ${toolName}`);
      process.exit(1);
    }
    process.stdout.write(JSON.stringify(result));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main();
