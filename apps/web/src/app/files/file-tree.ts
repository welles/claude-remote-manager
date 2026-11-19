import type {
  BrowsedDirectory,
  FileChangeStatus,
} from '@claude-remote-manager/shared-types';

/** A folder or file of a directory's tree. */
interface TreeNode {
  name: string;
  path: string;
  folders: Map<string, TreeNode>;
  files: string[];
  /** Sorted once, after building. */
  sortedFolders?: TreeNode[];
}

/** Files shown per folder before "Show all". */
export const MAX_FOLDER_FILES = 300;

/** One visible row of the file browser. */
export interface TreeRow {
  /** `<directory>:<path>`, unique across the session. */
  key: string;
  directory: number;
  /** Relative to the directory. */
  path: string;
  /** Shown name: the last part, or the whole path when filtering. */
  name: string;
  depth: number;
  folder: boolean;
  expanded: boolean;
  /** What the session changed in the file. */
  change: FileChangeStatus | null;
  /** A folder with changed files below it. */
  changedInside: boolean;
  /**
   * Not a file: "show the other N files" of the folder `path` (keyed by
   * the folder); `name` says how many.
   */
  more?: number;
}

/** At most this many rows match a filter. */
export const MAX_FILTERED_ROWS = 500;

export const rowKey = (directory: number, path: string) =>
  `${directory}:${path}`;

/** The folders and files of a listing as a tree. */
export function buildTree(files: readonly string[]): TreeNode {
  const root: TreeNode = { name: '', path: '', folders: new Map(), files: [] };
  for (const file of files) {
    const parts = file.split('/');
    let node = root;
    for (const part of parts.slice(0, -1)) {
      let next = node.folders.get(part);
      if (!next) {
        next = {
          name: part,
          path: node.path ? `${node.path}/${part}` : part,
          folders: new Map(),
          files: [],
        };
        node.folders.set(part, next);
      }
      node = next;
    }
    node.files.push(file);
  }
  const sort = (node: TreeNode) => {
    node.sortedFolders = [...node.folders.values()].sort((a, b) =>
      byName(a.name, b.name),
    );
    node.files.sort((a, b) => byName(baseName(a), baseName(b)));
    node.sortedFolders.forEach(sort);
  };
  sort(root);
  return root;
}

const baseName = (path: string) => path.split('/').at(-1) ?? path;

const byName = (a: string, b: string) =>
  a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });

/**
 * The visible rows of a directory: folders first, then files, each sorted
 * by name; folders show their content when expanded. With a filter, the
 * files whose path contains every word of it, as a flat list.
 */
export function treeRows(
  directory: BrowsedDirectory,
  tree: TreeNode,
  expanded: ReadonlySet<string>,
  changes: ReadonlyMap<string, FileChangeStatus>,
  filter: string,
  complete: ReadonlySet<string> = new Set(),
): TreeRow[] {
  const at = directory.directory;
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length > 0) {
    return directory.files
      .filter((file) => {
        const lower = file.toLowerCase();
        return words.every((word) => lower.includes(word));
      })
      .slice(0, MAX_FILTERED_ROWS)
      .sort(byName)
      .map((file) => ({
        key: rowKey(at, file),
        directory: at,
        path: file,
        name: file,
        depth: 0,
        folder: false,
        expanded: false,
        change: changes.get(rowKey(at, file)) ?? null,
        changedInside: false,
      }));
  }
  const changedFolders = new Set<string>();
  for (const key of changes.keys()) {
    if (!key.startsWith(`${at}:`)) {
      continue;
    }
    const parts = key.slice(`${at}:`.length).split('/');
    for (let index = 1; index < parts.length; index++) {
      changedFolders.add(parts.slice(0, index).join('/'));
    }
  }
  const rows: TreeRow[] = [];
  const walk = (node: TreeNode, depth: number) => {
    for (const folder of node.sortedFolders ?? []) {
      const name = folder.name;
      const key = rowKey(at, folder.path);
      const open = expanded.has(key);
      rows.push({
        key,
        directory: at,
        path: folder.path,
        name,
        depth,
        folder: true,
        expanded: open,
        change: null,
        changedInside: changedFolders.has(folder.path),
      });
      if (open) {
        walk(folder, depth + 1);
      }
    }
    const folderKey = rowKey(at, node.path);
    const all = complete.has(folderKey);
    const files = all ? node.files : node.files.slice(0, MAX_FOLDER_FILES);
    for (const file of files) {
      rows.push({
        key: rowKey(at, file),
        directory: at,
        path: file,
        name: file.split('/').at(-1) ?? file,
        depth,
        folder: false,
        expanded: false,
        change: changes.get(rowKey(at, file)) ?? null,
        changedInside: false,
      });
    }
    if (files.length < node.files.length) {
      rows.push({
        key: `${folderKey}#more`,
        directory: at,
        path: node.path,
        name: `${node.files.length - files.length} more files`,
        depth,
        folder: false,
        expanded: false,
        change: null,
        changedInside: false,
        more: node.files.length - files.length,
      });
    }
  };
  walk(tree, 0);
  return rows;
}
