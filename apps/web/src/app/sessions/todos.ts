import type { ConversationItem } from './conversation';

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

/** One entry of Claude's task list. */
export interface Todo {
  id: string;
  /** What to do. */
  content: string;
  /** Shown while it is in progress, e.g. "Running tests". */
  activeForm: string | null;
  status: TodoStatus;
}

const STATUSES = new Set<TodoStatus>(['pending', 'in_progress', 'completed']);

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : {};

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value : null;

/**
 * Claude's current task list, from its tool calls in the conversation (so
 * it is rebuilt with the history after a reload). Claude Code keeps it with
 * `TodoWrite` (the whole list each time) or, in newer versions, with
 * `TaskCreate`/`TaskUpdate` (one task at a time; the ID comes in the
 * result of `TaskCreate`). Subagents' lists are not shown. Calls that were
 * denied or failed do not count.
 */
export function todoList(items: ConversationItem[]): Todo[] {
  let todos: Todo[] = [];
  for (const item of items) {
    if (
      item.kind !== 'tool' ||
      item.nested ||
      item.denied ||
      item.result?.isError ||
      (item.permission?.resolved &&
        item.permission.resolved.decision === 'deny')
    ) {
      continue;
    }
    const input = record(item.input);
    if (item.name === 'TodoWrite' && Array.isArray(input['todos'])) {
      todos = input['todos'].map((entry, index) => {
        const todo = record(entry);
        const status = todo['status'] as TodoStatus;
        return {
          id: String(index),
          content: text(todo['content']) ?? '',
          activeForm: text(todo['activeForm']),
          status: STATUSES.has(status) ? status : 'pending',
        };
      });
    } else if (item.name === 'TaskCreate' && item.result) {
      const id =
        /#(\w+)/.exec(item.result.content)?.[1] ??
        /"id"\s*:\s*"?(\w+)/.exec(item.result.content)?.[1] ??
        String(todos.length + 1);
      todos = [
        ...todos.filter((todo) => todo.id !== id),
        {
          id,
          content: text(input['subject']) ?? text(input['description']) ?? '',
          activeForm: text(input['activeForm']),
          status: 'pending',
        },
      ];
    } else if (item.name === 'TaskUpdate') {
      const id = String(input['taskId'] ?? '');
      const status = input['status'];
      todos =
        status === 'deleted'
          ? todos.filter((todo) => todo.id !== id)
          : todos.map((todo) =>
              todo.id !== id
                ? todo
                : {
                    ...todo,
                    content: text(input['subject']) ?? todo.content,
                    activeForm: text(input['activeForm']) ?? todo.activeForm,
                    status: STATUSES.has(status as TodoStatus)
                      ? (status as TodoStatus)
                      : todo.status,
                  },
            );
    }
  }
  return todos;
}
