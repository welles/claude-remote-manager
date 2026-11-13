import { Component, computed, input } from '@angular/core';
import type { Todo } from './todos';

/** Claude's task list with the state of each task. */
@Component({
  selector: 'app-todo-panel',
  template: `
    <details class="todos" open data-testid="todos">
      <summary>Tasks {{ done() }}/{{ todos().length }}</summary>
      <ul>
        @for (todo of todos(); track todo.id) {
          <li class="todo todo-{{ todo.status }}" data-testid="todo">
            <span class="todo-mark" aria-hidden="true">{{
              todo.status === 'completed'
                ? '✓'
                : todo.status === 'in_progress'
                  ? '▶'
                  : '○'
            }}</span>
            <span class="todo-text">{{
              todo.status === 'in_progress' && todo.activeForm
                ? todo.activeForm
                : todo.content
            }}</span>
            <span class="visually-hidden"
              >({{ todo.status.replace('_', ' ') }})</span
            >
          </li>
        }
      </ul>
    </details>
  `,
  styleUrl: './todo-panel.scss',
})
export class TodoPanel {
  readonly todos = input.required<Todo[]>();
  protected readonly done = computed(
    () => this.todos().filter((todo) => todo.status === 'completed').length,
  );
}
