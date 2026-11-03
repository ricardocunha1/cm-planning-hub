import { NavLink } from "react-router-dom";
import { TOOL_GROUPS } from "../lib/tools";
import { SidebarToggleIcon } from "./icons/SidebarToggleIcon";

const NAV_ID = "hub-sidebar-nav";

const FOCUS_RING = "focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--cm-light-blue)]";

/**
 * Group heading: the label centered between two lines filling the panel width.
 * Collapsed (md+ only), the label is visually hidden — it still names the group —
 * and a single separator line remains.
 */
function GroupDivider({ id, label, collapsed }: { id: string; label: string; collapsed: boolean }) {
  return (
    <div className={`flex items-center gap-2 px-3 py-2 ${collapsed ? "md:gap-0 md:px-1" : ""}`}>
      <span className="h-px flex-1 bg-surface-strong" aria-hidden="true" />
      <span
        id={id}
        className={`whitespace-nowrap text-xs font-semibold uppercase tracking-wider text-fg-subtle ${collapsed ? "md:sr-only" : ""}`}
      >
        {label}
      </span>
      <span className={`h-px flex-1 bg-surface-strong ${collapsed ? "md:hidden" : ""}`} aria-hidden="true" />
    </div>
  );
}

export interface SidebarProps {
  /** Icons-only mode; applies from the `md` breakpoint up (small screens always show names). */
  collapsed?: boolean;
  /** Called by the collapse/expand button; the button is omitted when not provided. */
  onToggleCollapsed?: () => void;
}

/**
 * Left dashboard panel listing the hub's tools, grouped by category. Expanded it shows
 * icon + name per tool; collapsed only the icons, each keeping its name as accessible
 * name and tooltip, with the same highlight on the active tool.
 */
export function Sidebar({ collapsed = false, onToggleCollapsed }: SidebarProps) {
  const toggleLabel = collapsed ? "Expand sidebar" : "Collapse sidebar";
  return (
    <div className="flex flex-col">
      {onToggleCollapsed && (
        <div className={`hidden px-3 pt-3 md:flex ${collapsed ? "md:justify-center md:px-2" : "md:justify-end"}`}>
          <button
            type="button"
            onClick={onToggleCollapsed}
            aria-expanded={!collapsed}
            aria-controls={NAV_ID}
            aria-label={toggleLabel}
            title={toggleLabel}
            className={`rounded p-1.5 text-fg-subtle transition-colors hover:bg-surface-raised/60 hover:text-fg ${FOCUS_RING}`}
          >
            <SidebarToggleIcon className={`h-5 w-5 transition-transform ${collapsed ? "rotate-180" : ""}`} />
          </button>
        </div>
      )}
      <nav id={NAV_ID} aria-label="Hub navigation" className={`flex flex-col gap-4 p-3 ${collapsed ? "md:px-2" : ""}`}>
        {TOOL_GROUPS.map((group) => (
          <div key={group.id} role="group" aria-labelledby={`sidebar-group-${group.id}`}>
            <GroupDivider id={`sidebar-group-${group.id}`} label={group.label} collapsed={collapsed} />
            <ul className="mt-1 flex flex-col gap-1">
              {group.tools.map(({ id, name, path, icon: Icon }) => (
                <li key={id}>
                  <NavLink
                    to={path}
                    title={collapsed ? name : undefined}
                    className={({ isActive }) =>
                      `flex items-center gap-3 rounded px-3 py-2 text-sm font-medium transition-colors ${FOCUS_RING} ${
                        collapsed ? "md:justify-center md:gap-0 md:px-0" : ""
                      } ${
                        isActive ? "bg-surface-raised text-accent-teal" : "text-fg-muted hover:bg-surface-raised/60 hover:text-fg"
                      }`
                    }
                  >
                    <Icon className="h-5 w-5 shrink-0" />
                    <span className={`whitespace-nowrap ${collapsed ? "md:sr-only" : ""}`}>{name}</span>
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
    </div>
  );
}
