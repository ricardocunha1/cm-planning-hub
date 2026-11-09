import { useId, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import { expandedForFilter, filterTree, findNodeChain, visibleRows, type TreeRow } from "../../lib/ado/tree";
import type { AdoTreeNode } from "../../lib/ado/types";

function initialExpanded(root: AdoTreeNode, selectedPath: string | null): Set<string> {
  const expanded = new Set([root.path]);
  const chain = selectedPath ? findNodeChain(root, selectedPath) : null;
  chain?.slice(0, -1).forEach((node) => expanded.add(node.path));
  return expanded;
}

/**
 * Searchable single-select tree of Azure DevOps Area or Iteration paths
 * (`role="tree"`, a flat list of `treeitem`s with `aria-level`). The root starts
 * expanded (plus the ancestors of `selectedPath`). The search box keeps only the
 * nodes whose name or path contains the text (case-insensitive) and their
 * ancestors, expanded. Keys: ↑/↓ move, → expands / goes to the first child,
 * ← collapses / goes to the parent, Home/End, Enter/Space select. A click
 * selects too. Collapsing a node with the mouse while one of its descendants
 * has focus moves focus to that node. `disabled` (a request is running) keeps
 * browsing possible but blocks searching and selecting. Remount it (`key`) to
 * reset search and expansion.
 */
export function PathTree({
  root,
  selectedPath,
  onSelect,
  label,
  disabled = false,
}: {
  root: AdoTreeNode;
  /** Path of the selected node, compared exactly. */
  selectedPath: string | null;
  /** Called with the node's `path` when it is selected. */
  onSelect: (path: string) => void;
  /** Accessible name of the tree, e.g. "Area path"; the search box is "Search <label>". */
  label: string;
  /** Selection and search are blocked (`aria-disabled` tree, disabled search box). */
  disabled?: boolean;
}) {
  const searchId = useId();
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(() => initialExpanded(root, selectedPath));
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const itemRefs = useRef(new Map<string, HTMLLIElement>());

  const visible = useMemo(() => filterTree(root, query), [root, query]);
  const rows = useMemo(() => visibleRows(root, expanded, visible), [root, expanded, visible]);

  const tabbablePath =
    rows.find((r) => r.node.path === focusedPath)?.node.path ??
    rows.find((r) => r.node.path === selectedPath)?.node.path ??
    rows[0]?.node.path ??
    null;

  const onSearch = (event: ChangeEvent<HTMLInputElement>) => {
    const next = event.target.value;
    setQuery(next);
    const matches = filterTree(root, next);
    if (matches) {
      const add = expandedForFilter(root, matches);
      setExpanded((current) => new Set([...current, ...add]));
    }
  };

  const toggle = (path: string, open: boolean) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (open) {
        next.add(path);
      } else {
        next.delete(path);
      }
      return next;
    });
  };

  const focusRow = (row: TreeRow | undefined) => {
    if (row) {
      setFocusedPath(row.node.path);
      itemRefs.current.get(row.node.path)?.focus();
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLLIElement>, row: TreeRow) => {
    const index = rows.indexOf(row);
    switch (event.key) {
      case "ArrowDown":
        focusRow(rows[index + 1]);
        break;
      case "ArrowUp":
        focusRow(rows[index - 1]);
        break;
      case "Home":
        focusRow(rows[0]);
        break;
      case "End":
        focusRow(rows[rows.length - 1]);
        break;
      case "ArrowRight":
        if (row.hasChildren && !row.expanded) {
          toggle(row.node.path, true);
        } else if (row.expanded) {
          focusRow(rows[index + 1]);
        }
        break;
      case "ArrowLeft":
        if (row.expanded) {
          toggle(row.node.path, false);
        } else {
          focusRow(rows.find((r) => r.node.path === row.parentPath));
        }
        break;
      case "Enter":
      case " ":
        if (!disabled) {
          onSelect(row.node.path);
        }
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  return (
    <div className="space-y-2">
      <label htmlFor={searchId} className="sr-only">
        Search {label}
      </label>
      <input
        id={searchId}
        type="search"
        value={query}
        onChange={onSearch}
        disabled={disabled}
        placeholder="Search paths…"
        className="block w-full rounded border border-line-bold bg-canvas px-3 py-1.5 text-sm text-fg placeholder:text-fg-faint focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--cm-light-blue)]"
      />
      {rows.length === 0 ? (
        <p className="text-fg-subtle">No matching paths.</p>
      ) : (
        <ul role="tree" aria-label={label} aria-disabled={disabled ? true : undefined} className={`max-h-64 overflow-auto rounded border border-line-strong bg-canvas py-1${disabled ? " opacity-60" : ""}`}>
          {rows.map((row) => {
            const { node } = row;
            const selected = node.path === selectedPath;
            return (
              <li
                key={node.path}
                ref={(el) => {
                  if (el) {
                    itemRefs.current.set(node.path, el);
                  } else {
                    itemRefs.current.delete(node.path);
                  }
                }}
                role="treeitem"
                aria-level={row.level}
                aria-selected={selected}
                aria-expanded={row.hasChildren ? row.expanded : undefined}
                tabIndex={node.path === tabbablePath ? 0 : -1}
                title={node.path}
                onFocus={() => setFocusedPath(node.path)}
                onClick={() => {
                  setFocusedPath(node.path);
                  if (!disabled) {
                    onSelect(node.path);
                  }
                }}
                onKeyDown={(event) => onKeyDown(event, row)}
                className={`flex cursor-pointer items-center gap-1 py-1 pr-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[color:var(--cm-light-blue)] ${
                  selected ? "bg-[color:var(--cm-light-blue)] text-white" : "text-fg-soft hover:bg-surface-raised"
                }`}
                style={{ paddingLeft: `${(row.level - 1) * 1.25 + 0.5}rem` }}
              >
                <span
                  aria-hidden="true"
                  data-testid={row.hasChildren ? "tree-toggle" : undefined}
                  onClick={(event) => {
                    if (row.hasChildren) {
                      event.stopPropagation();
                      toggle(node.path, !row.expanded);
                      // The focused descendant is about to disappear: keep focus in the tree, on this node.
                      const focusedEl = focusedPath !== null ? itemRefs.current.get(focusedPath) : undefined;
                      if (row.expanded && focusedPath?.startsWith(`${node.path}\\`) && focusedEl === document.activeElement) {
                        focusRow(row);
                      }
                    }
                  }}
                  className="inline-flex w-4 justify-center text-fg-subtle"
                >
                  {row.hasChildren ? (row.expanded ? "▾" : "▸") : ""}
                </span>
                <span className="truncate">{node.name}</span>
                {node.finishDate ? <span className={`ml-auto pl-2 text-xs ${selected ? "text-white/80" : "text-fg-subtle"}`}>{node.finishDate}</span> : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
