import { Link } from "react-router-dom";
import { Layout } from "../components/Layout";
import { HUB_NAME, TOOL_GROUPS } from "../lib/tools";

/** Hub landing page: one section per tool group, one card per tool from the registry. */
export function HubHomePage() {
  return (
    <Layout title={HUB_NAME}>
      <div className="px-6 py-8 max-w-5xl mx-auto">
        <h2 className="text-2xl font-semibold">Welcome to the {HUB_NAME}</h2>
        <p className="mt-2 text-fg-subtle">Pick a tool to get started.</p>
        {TOOL_GROUPS.map((group) => (
          <section key={group.id} aria-labelledby={`hub-${group.id}-heading`} className="mt-8">
            <h3 id={`hub-${group.id}-heading`} className="text-sm font-semibold uppercase tracking-wider text-fg-subtle">
              {group.label}
            </h3>
            <ul className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {group.tools.map(({ id, name, path, description, goal, icon: Icon }) => (
                <li key={id}>
                  <Link
                    to={path}
                    aria-label={`Open ${name}`}
                    className="flex h-full flex-col gap-3 rounded-lg border border-line bg-surface p-5 transition-colors hover:border-[color:var(--cm-light-blue)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--cm-light-blue)]"
                  >
                    <span className="flex items-center gap-3">
                      <span className="flex h-10 w-10 items-center justify-center rounded-md" style={{ backgroundColor: "var(--cm-dark-blue)", color: "var(--cm-teal)" }}>
                        <Icon className="h-6 w-6" />
                      </span>
                      <span className="text-lg font-semibold">{name}</span>
                    </span>
                    <span className="text-sm text-fg-muted">{description}</span>
                    <span className="text-sm text-fg-subtle">
                      <span className="font-semibold text-fg-soft">Goal: </span>
                      {goal}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Layout>
  );
}
