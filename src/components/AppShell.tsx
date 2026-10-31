import { Link } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";

const nav = [
  { to: "/", label: "Overview" },
  { to: "/calendar", label: "Calendar" },
  { to: "/ideas", label: "Idea research" },
  { to: "/scripts", label: "Script editor" },
  { to: "/pipeline", label: "Production" },
  { to: "/approvals", label: "Approvals" },
  { to: "/analytics", label: "Analytics" },
  { to: "/channel", label: "YouTube channel" },
  { to: "/settings", label: "Settings" },
] as const;

export function AppShell({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const links = (
    <nav aria-label="Main" className="flex flex-col gap-1">
      {nav.map((n) => (
        <Link key={n.to} to={n.to} onClick={() => setOpen(false)}
          activeOptions={{ exact: n.to === "/" }}
          className="rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-secondary hover:text-foreground"
          activeProps={{ className: "bg-accent !text-accent-foreground font-medium" }}>
          {n.label}
        </Link>
      ))}
    </nav>
  );
  const brand = (
    <div className="flex items-center gap-2">
      <div className="grid h-8 w-8 place-items-center rounded-lg bg-primary font-display text-sm font-bold text-primary-foreground">T</div>
      <div className="leading-tight"><div className="font-display text-sm font-semibold">Tony AI</div><div className="text-xs text-muted-foreground">YouTube Studio</div></div>
    </div>
  );
  return (
    <div className="min-h-screen lg:flex">
      <aside className="hidden w-60 shrink-0 border-r bg-sidebar p-4 lg:block">
        <div className="mb-6">{brand}</div>{links}
      </aside>
      <header className="sticky top-0 z-20 flex items-center justify-between border-b bg-sidebar px-4 py-3 lg:hidden">
        {brand}
        <button className="btn" aria-expanded={open} aria-controls="mnav" onClick={() => setOpen(!open)}>{open ? "Close" : "Menu"}</button>
      </header>
      {open && <div id="mnav" className="border-b bg-sidebar p-3 lg:hidden">{links}</div>}
      <div className="min-w-0 flex-1">
        <div role="status" className="border-b border-warning/30 bg-warning/10 px-4 py-2 text-center text-xs text-warning">
          Demo mode — all data is sample data. No accounts are connected and nothing is published or automated.
        </div>
        <main className="mx-auto max-w-6xl p-4 sm:p-6 lg:p-8">{children}</main>
      </div>
    </div>
  );
}
