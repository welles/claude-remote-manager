import type { ConversationItem } from './conversation';
import type { ShownItem } from './preparation';

type ToolItem = Extract<ConversationItem, { kind: 'tool' }>;
type AssistantItem = Extract<ConversationItem, { kind: 'assistant' }>;

/**
 * Consecutive tool calls between two of Claude's messages, shown as one
 * collapsed row so Claude's text and the user's messages stand out. The
 * calls of subagents and their text belong to the group too.
 */
export interface ToolGroup {
  kind: 'tools';
  key: string;
  /** The calls and the subagents' text, in order. */
  items: (ToolItem | AssistantItem)[];
  /** The tool calls alone. */
  tools: ToolItem[];
}

export type ConversationEntry = ShownItem | ToolGroup;

/** Whether an item belongs to a run of tool calls. */
function inRun(item: ShownItem): item is ToolItem | AssistantItem {
  return item.kind === 'tool' || (item.kind === 'assistant' && item.nested);
}

/**
 * The conversation with each run of two or more tool calls folded into a
 * group. A single call stays a row of its own; a run that has a subagent's
 * text but only one call is left as it is. When a second call follows, the
 * row becomes a group (keyed by its first item), so an opened row closes.
 */
export function groupTools(items: ShownItem[]): ConversationEntry[] {
  const entries: ConversationEntry[] = [];
  let run: (ToolItem | AssistantItem)[] = [];
  const flush = () => {
    const tools = run.filter((item): item is ToolItem => item.kind === 'tool');
    if (tools.length > 1) {
      entries.push({
        kind: 'tools',
        key: `tools:${run[0].key}`,
        items: run,
        tools,
      });
    } else {
      entries.push(...run);
    }
    run = [];
  };
  for (const item of items) {
    if (inRun(item)) {
      run.push(item);
      continue;
    }
    if (item.kind === 'queued' && item.state === 'queued') {
      // Waiting messages show in the queue, not here: no break in the run.
      entries.push(item);
      continue;
    }
    flush();
    entries.push(item);
  }
  flush();
  return entries;
}

/** The tools of a group by how often they ran, e.g. `Bash 12 · Read 2`. */
export function toolCounts(tools: ToolItem[]): string {
  const counts = new Map<string, number>();
  for (const tool of tools) {
    const name = shortToolName(tool.name);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => (count > 1 ? `${name} ${count}` : name))
    .join(' · ');
}

/** An MCP tool's own name without the server, e.g. `show_file`. */
export function shortToolName(name: string): string {
  const parts = name.split('__');
  return parts[0] === 'mcp' && parts.length > 2
    ? parts.slice(2).join('__')
    : name;
}
