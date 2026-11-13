import type {
  SessionEvent,
  SessionEventInput,
} from '@claude-remote-manager/shared-types';
import { buildConversation } from './conversation';
import { todoList } from './todos';

let seq = 0;
const event = (input: SessionEventInput): SessionEvent =>
  ({ ...input, seq: ++seq, at: null }) as SessionEvent;
const call = (
  toolUseId: string,
  name: string,
  input: unknown,
  parentToolUseId: string | null = null,
) =>
  event({
    type: 'tool.call',
    messageId: 'm',
    toolUseId,
    name,
    input,
    parentToolUseId,
  });
const result = (toolUseId: string, content: string, isError = false) =>
  event({
    type: 'tool.result',
    toolUseId,
    isError,
    content,
    truncated: false,
    parentToolUseId: null,
  });

describe('todoList', () => {
  it('takes the latest TodoWrite list of the main thread', () => {
    const todos = todoList(
      buildConversation([
        call('t1', 'TodoWrite', {
          todos: [
            { content: 'Read', status: 'pending', activeForm: 'Reading' },
          ],
        }),
        call('t2', 'TodoWrite', {
          todos: [
            { content: 'Read', status: 'completed', activeForm: 'Reading' },
            { content: 'Test', status: 'in_progress', activeForm: 'Testing' },
            { content: 'Odd', status: 'unknown' },
          ],
        }),
        // A subagent's list is its own.
        call('t3', 'TodoWrite', { todos: [] }, 't0'),
      ]),
    );
    expect(todos).toEqual([
      { id: '0', content: 'Read', activeForm: 'Reading', status: 'completed' },
      {
        id: '1',
        content: 'Test',
        activeForm: 'Testing',
        status: 'in_progress',
      },
      { id: '2', content: 'Odd', activeForm: null, status: 'pending' },
    ]);
  });

  it('follows TaskCreate and TaskUpdate', () => {
    const todos = todoList(
      buildConversation([
        call('c1', 'TaskCreate', {
          subject: 'Write code',
          activeForm: 'Coding',
        }),
        result('c1', 'Task #1 created successfully: Write code'),
        call('c2', 'TaskCreate', { subject: 'Ship', description: 'Release' }),
        result('c2', 'Task #2 created successfully: Ship'),
        call('c3', 'TaskCreate', { subject: 'Failed' }),
        result('c3', 'error', true),
        call('u1', 'TaskUpdate', { taskId: '1', status: 'in_progress' }),
        call('u2', 'TaskUpdate', { taskId: '1', status: 'completed' }),
        call('u3', 'TaskUpdate', { taskId: '2', status: 'deleted' }),
      ]),
    );
    expect(todos).toEqual([
      {
        id: '1',
        content: 'Write code',
        activeForm: 'Coding',
        status: 'completed',
      },
    ]);
  });

  it('is empty without task tools', () => {
    expect(todoList(buildConversation([call('t', 'Bash', {})]))).toEqual([]);
  });
});
