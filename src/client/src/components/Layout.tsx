import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { loadSidebarCollapsed, saveSidebarCollapsed } from "../lib/sidebarPreference";
import { HUB_NAME } from "../lib/tools";
import { Sidebar } from "./Sidebar";
import { ThemeToggle } from "./ThemeToggle";

/**
 * Dashboard shell: global header (logo + hub name, theme toggle at the right), left sidebar and main content area.
 * Owns the sidebar's collapsed state, persisted in localStorage across pages and reloads. The header keeps its
 * brand-blue background and light text in both themes.
 */
export function Layout({ title, children }: { title: string; children: ReactNode }) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(loadSidebarCollapsed);

  useEffect(() => {
    document.title = title;
  }, [title]);

  function toggleSidebar() {
    const next = !sidebarCollapsed;
    setSidebarCollapsed(next);
    saveSidebarCollapsed(next);
  }

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center gap-4 px-6 py-4 border-b border-line text-slate-100" style={{ backgroundColor: "var(--cm-dark-blue)" }}>
        <Link to="/" aria-label={`${HUB_NAME} home`}>
          <img src="/cmlogo.png" alt="CM Logo" className="h-10 w-auto" />
        </Link>
        <h1 className="text-xl font-semibold">{HUB_NAME}</h1>
        <div className="ml-auto">
          <ThemeToggle />
        </div>
      </header>
      <div className="flex flex-1 flex-col md:flex-row">
        <aside
          data-collapsed={sidebarCollapsed}
          className={`overflow-hidden border-b border-line bg-surface transition-[width] duration-200 md:shrink-0 md:border-b-0 md:border-r ${
            sidebarCollapsed ? "md:w-16" : "md:w-60"
          }`}
        >
          <Sidebar collapsed={sidebarCollapsed} onToggleCollapsed={toggleSidebar} />
        </aside>
        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}
