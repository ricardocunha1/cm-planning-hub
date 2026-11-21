import { NavLink } from "react-router-dom";
import { useAuth } from "../authStore";
import { TOOL_GROUPS } from "../lib/tools";
import { SignOutIcon } from "./icons/SignOutIcon";
import { SettingsButton } from "./settings/SettingsButton";
import { SidebarToggleIcon } from "./icons/SidebarToggleIcon";

const NAV_ID = "hub-sidebar-nav";

const FOCUS_RING = "focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--cm-light-blue)]";

const ICON_BUTTON = `shrink-0 rounded p-1.5 text-fg-subtle transition-colors hover:bg-surface-raised/60 hover:text-fg ${FOCUS_RING}`;

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

/** Round avatar: the profile picture when there is one (and it loads), else the user's initial. */
function Avatar({ name, pictureUrl }: { name: string; pictureUrl: string | null }) {
  const initial = name.trim().charAt(0).toUpperCase() || "?";
  return (
    <span
      className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full text-sm font-semibold"
      style={{ backgroundColor: "var(--cm-dark-blue)", color: "var(--cm-teal)" }}
      aria-hidden="true"
    >
      {pictureUrl ? <img src={pictureUrl} alt="" referrerPolicy="no-referrer" className="h-full w-full object-cover" /> : initial}
    </span>
  );
}

/**
 * Bottom block of the panel (pushed down with `mt-auto`): avatar, the user's name, a settings button and a sign-out button.
 * Collapsed (md+), only the avatar and the button remain; the name stays as the avatar's tooltip and the
 * button's accessible name. Renders nothing without a signed-in user.
 */
function SidebarFooter({ collapsed }: { collapsed: boolean }) {
  const { user, signOut } = useAuth();
  if (!user) {
    return null;
  }
  return (
    <div
      className={`mt-auto flex items-center gap-2 border-t border-line p-3 ${collapsed ? "md:flex-col md:px-2" : ""}`}
      data-testid="sidebar-footer"
    >
      <div className="flex min-w-0 flex-1 items-center gap-3" title={collapsed ? user.name : undefined}>
        <Avatar name={user.name} pictureUrl={user.pictureUrl} />
        <span className={`truncate text-sm font-medium text-fg ${collapsed ? "md:sr-only" : ""}`}>{user.name}</span>
      </div>
      <div className={`flex shrink-0 items-center gap-1 ${collapsed ? "md:flex-col" : ""}`}>
        <SettingsButton className={ICON_BUTTON} />
        <button type="button" onClick={() => void signOut()} aria-label="Sign out" title="Sign out" className={ICON_BUTTON}>
          <SignOutIcon className="h-5 w-5" />
        </button>
      </div>
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
    <div className="flex flex-1 flex-col">
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
      <SidebarFooter collapsed={collapsed} />
    </div>
  );
}
