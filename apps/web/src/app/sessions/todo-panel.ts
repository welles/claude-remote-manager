import { Component, computed, input } from '@angular/core';
import type { Todo } from './todos';

/** Claude's task list with the state of each task. */
@Component({
  selector: 'app-todo-panel',
  host: { class: 'block' },
  template: `
    <details class="type-body-medium" open data-testid="todos">
      <summary class="app-section-label m-0 cursor-pointer">
        Tasks {{ done() }}/{{ todos().length }}
      </summary>
      <ul class="my-1 list-none p-0">
        @for (todo of todos(); track todo.id) {
          @let status = todo.status;
          <li
            class="flex gap-2 py-0.5 wrap-anywhere"
            [class]="status === 'in_progress' ? 'font-medium text-primary' : ''"
            data-testid="todo"
          >
            <span
              class="w-[1em] flex-none text-center"
              [class.text-on-surface-variant]="status !== 'in_progress'"
              aria-hidden="true"
              >{{
                todo.status === 'completed'
                  ? '✓'
                  : todo.status === 'in_progress'
                    ? '▶'
                    : '○'
              }}</span
            >
            <span
              [class]="
                status === 'completed'
                  ? 'text-on-surface-variant line-through'
                  : ''
              "
              >{{
                todo.status === 'in_progress' && todo.activeForm
                  ? todo.activeForm
                  : todo.content
              }}</span
            >
            <span class="sr-only">({{ todo.status.replace('_', ' ') }})</span>
          </li>
        }
      </ul>
    </details>
  `,
})
export class TodoPanel {
  readonly todos = input.required<Todo[]>();
  protected readonly done = computed(
    () => this.todos().filter((todo) => todo.status === 'completed').length,
  );
}
