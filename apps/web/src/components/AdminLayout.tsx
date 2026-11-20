import { useEffect, useState, type ReactNode } from "react";
import { useRouter } from "../router.js";
import { useTheme } from "../theme.js";
import type { Me } from "../types.js";

/**
 * Layout of the admin console. The super admin only manages clients, plans and their own
 * login; the WhatsApp desk pages belong to client logins and are not shown here.
 */
const NAV: Array<{ href: string; label: string; icon: string; exact?: boolean }> = [
  { href: "/admin", label: "Overview", icon: "📈", exact: true },
  { href: "/admin/clients", label: "Clients", icon: "🏢" },
  { href: "/admin/plans", label: "Plans", icon: "🧾" },
  { href: "/admin/activity", label: "Activity", icon: "🕘" },
  { href: "/admin/account", label: "My account", icon: "🔐" },
];

function NavItem({ href, label, icon, exact }: (typeof NAV)[number]) {
  const { path, navigate } = useRouter();
  const active = exact ? path === href : path === href || path.startsWith(`${href}/`);
  return (
    <a
      href={href}
      aria-current={active ? "page" : undefined}
      onClick={(e) => {
        if (!e.metaKey && !e.ctrlKey && !e.shiftKey) {
          e.preventDefault();
          navigate(href);
        }
      }}
      className={`flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-[15px] font-medium transition-colors ${
        active
          ? "bg-violet-500 text-white shadow-sm shadow-violet-900/30"
          : "text-slate-300 hover:bg-white/10 hover:text-white"
      }`}
    >
      <span aria-hidden="true">{icon}</span>
      {label}
    </a>
  );
}

export function AdminLayout({ me, onLogout, children }: { me: Me; onLogout: () => void; children: ReactNode }) {
  const { path, navigate } = useRouter();
  const { toggleTheme, isDark } = useTheme();
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => setMenuOpen(false), [path]);

  const themeButton = (
    <button
      type="button"
      onClick={toggleTheme}
      className="w-9 h-9 rounded-lg border border-white/15 flex items-center justify-center text-sm text-slate-200 hover:bg-white/10 transition-colors"
      aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
      title={isDark ? "Switch to light theme" : "Switch to dark theme"}
    >
      {isDark ? "☀️" : "🌙"}
    </button>
  );

  const brand = (
    <button type="button" className="flex items-center gap-2.5 text-left" onClick={() => navigate("/admin")}>
      <span className="w-9 h-9 rounded-xl bg-violet-500 text-white flex items-center justify-center text-sm font-black shadow-sm">
        LD
      </span>
      <span className="leading-tight">
        <span className="block font-extrabold text-lg tracking-tight text-white">Lead Desk</span>
        <span className="block text-[11px] font-bold uppercase tracking-[0.14em] text-violet-300">Admin console</span>
      </span>
    </button>
  );

  return (
    <div className="shell bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100">
      {/* Mobile header */}
      <header className="lg:hidden flex items-center justify-between px-4 py-3 bg-slate-900 border-b border-slate-800 z-40">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setMenuOpen(!menuOpen)}
            className="w-10 h-10 rounded-xl border border-white/15 flex items-center justify-center text-slate-100 hover:bg-white/10"
            aria-label="Toggle navigation menu"
            aria-expanded={menuOpen}
          >
            {menuOpen ? "✕" : "☰"}
          </button>
          {brand}
        </div>
        {themeButton}
      </header>

      {/* Sidebar */}
      <aside
        className={`flex-col gap-6 bg-slate-900 dark:bg-slate-950 border-r border-slate-800 px-5 py-6 overflow-y-auto ${
          menuOpen ? "fixed inset-y-0 left-0 z-50 w-72 flex shadow-2xl lg:static lg:w-auto lg:shadow-none" : "hidden lg:flex"
        }`}
        aria-label="Admin navigation"
      >
        <div className="flex items-center justify-between">
          {brand}
          <span className="hidden lg:block">{themeButton}</span>
        </div>

        <nav className="flex flex-col gap-1 flex-1">
          {NAV.map((item) => (
            <NavItem key={item.href} {...item} />
          ))}
        </nav>

        <div className="border-t border-white/10 pt-4 flex items-center justify-between gap-2">
          <div className="min-w-0">
            <span className="block truncate text-sm font-semibold text-white">{me.displayName}</span>
            <span className="block truncate text-xs text-slate-400" title={me.email}>
              {me.email}
            </span>
          </div>
          <button
            type="button"
            onClick={onLogout}
            className="shrink-0 px-3 py-1.5 rounded-lg border border-white/15 text-xs font-medium text-slate-200 hover:text-rose-300 hover:border-rose-400/50 transition-colors"
          >
            Logout
          </button>
        </div>
      </aside>

      {menuOpen && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-40 lg:hidden" onClick={() => setMenuOpen(false)} />
      )}

      <main className="main" role="main">
        {children}
      </main>
    </div>
  );
}
