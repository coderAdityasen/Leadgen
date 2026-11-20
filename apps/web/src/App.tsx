import { useCallback, useEffect, useState } from "react";
import { Router, useRouter, Link } from "./router.js";
import { HeaderChip, useConnectionStatus } from "./components/HeaderChip.js";
import { ServicesModal } from "./components/ServicesModal.js";
import { useTheme } from "./theme.js";
import { LoginView } from "./views/LoginView.js";
import { DashboardView } from "./views/DashboardView.js";
import { LeadsView } from "./views/LeadsView.js";
import { LeadDetailView } from "./views/LeadDetailView.js";
import { StagesView } from "./views/StagesView.js";
import { RepliesView } from "./views/RepliesView.js";
import { SettingsView } from "./views/SettingsView.js";
import { QueueView } from "./views/QueueView.js";
import { ConnectionView } from "./views/ConnectionView.js";
import { SequencesView } from "./views/SequencesView.js";
import { LogView } from "./views/LogView.js";
import { AiSettingsView } from "./views/AiSettingsView.js";
import { BillingView } from "./views/BillingView.js";
import { AdminClientsView } from "./views/admin/AdminClientsView.js";
import { AdminClientDetailView } from "./views/admin/AdminClientDetailView.js";
import { AdminPlansView } from "./views/admin/AdminPlansView.js";
import { AdminOverviewView } from "./views/admin/AdminOverviewView.js";
import { AdminActivityView } from "./views/admin/AdminActivityView.js";
import { AdminAccountView } from "./views/admin/AdminAccountView.js";
import { AdminLayout } from "./components/AdminLayout.js";
import { BillingBanner } from "./components/BillingBanner.js";
import { SessionContext, isPublicPath, useSession } from "./session.js";
import type { Me } from "./types.js";
import { apiRequest } from "./api.js";

function MainLayout({ children }: { children: React.ReactNode }) {
  const { navigate, path } = useRouter();
  const [operator, setOperator] = useState<Me | null>(null);
  const [servicesModalOpen, setServicesModalOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const { toggleTheme, isDark } = useTheme();
  const isPublic = isPublicPath(path);
  // The public page (login) must not poll authenticated endpoints: a 401 would bounce to /login.
  const connectionStatus = useConnectionStatus(!isPublic && operator?.role === "owner");

  const reloadMe = useCallback(async () => {
    try {
      setOperator(await apiRequest<Me>("/api/v1/me"));
    } catch {
      // apiRequest already redirects to /login on 401.
    }
  }, []);

  useEffect(() => {
    if (isPublic) return;
    apiRequest<Me>("/api/v1/me")
      .then(setOperator)
      .catch(() => {
        navigate("/login");
      });
  }, [path]);

  // The admin console and the client desk are separate: send each login to its own area.
  useEffect(() => {
    if (!operator || isPublic) return;
    const inAdmin = path === "/admin" || path.startsWith("/admin/");
    if (operator.role === "superadmin" && !inAdmin) navigate("/admin", { replace: true });
    if (operator.role !== "superadmin" && inAdmin) navigate("/", { replace: true });
  }, [operator?.role, path]);

  // Close mobile drawer on route change
  useEffect(() => {
    setMobileMenuOpen(false);
  }, [path]);

  const handleLogout = async () => {
    try {
      await apiRequest("/api/v1/session", { method: "DELETE" });
    } catch {
      // Ignored
    }
    setOperator(null);
    navigate("/login");
  };

  const session = { me: operator, reloadMe };

  if (isPublic) {
    return (
      <SessionContext.Provider value={session}>
        <div className="login-wrapper bg-slate-50 dark:bg-slate-950 min-h-screen">{children}</div>
      </SessionContext.Provider>
    );
  }

  if (!operator) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-950 text-sm text-slate-500">
        Loading…
      </div>
    );
  }

  if (operator.role === "superadmin") {
    return (
      <SessionContext.Provider value={session}>
        <AdminLayout me={operator} onLogout={handleLogout}>
          {children}
        </AdminLayout>
      </SessionContext.Provider>
    );
  }

  return (
    <SessionContext.Provider value={session}>
    <div className="shell bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 transition-colors duration-150">
      {/* Mobile Top Header (Visible on < 1024px) */}
      <header className="lg:hidden flex items-center justify-between px-5 py-3.5 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 z-40 shadow-xs">
        <div className="flex items-center gap-3">
          <button
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            className="w-10 h-10 rounded-xl border border-slate-200 dark:border-slate-800 flex items-center justify-center text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
            aria-label="Toggle navigation menu"
          >
            {mobileMenuOpen ? "✕" : "☰"}
          </button>
          <div className="font-extrabold text-lg tracking-tight text-indigo-600 dark:text-indigo-400">
            Lead Desk
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={toggleTheme}
            className="w-9 h-9 rounded-xl border border-slate-200 dark:border-slate-800 flex items-center justify-center text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
            aria-label="Toggle dark mode"
          >
            {isDark ? "☀️" : "🌙"}
          </button>
          <HeaderChip status={connectionStatus} />
        </div>
      </header>

      {/* Sidebar Navigation */}
      <aside
        className={`nav ${
          mobileMenuOpen
            ? "fixed inset-y-0 left-0 z-50 w-72 shadow-2xl flex overflow-y-auto lg:static lg:w-auto lg:shadow-none"
            : "hidden lg:flex"
        }`}
        role="navigation"
        aria-label="Main Navigation"
      >
        <div className="brand-section">
          <div className="flex items-center justify-between">
            <div
              className="brand cursor-pointer group"
              onClick={() => navigate("/")}
            >
              <span className="w-8 h-8 rounded-xl bg-indigo-600 text-white flex items-center justify-center text-base font-black shadow-xs group-hover:scale-105 transition-transform">
                LD
              </span>
              <span className="font-extrabold text-xl tracking-tight text-slate-900 dark:text-white">
                Lead Desk
              </span>
            </div>

            {/* Dark Mode Toggle (Desktop) */}
            <button
              onClick={toggleTheme}
              className="w-8 h-8 rounded-lg border border-slate-200 dark:border-slate-800 flex items-center justify-center text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
              title={isDark ? "Switch to light theme" : "Switch to dark theme"}
              aria-label="Toggle theme mode"
            >
              {isDark ? "☀️" : "🌙"}
            </button>
          </div>

          <div className="mt-3 flex items-center gap-2">
            <HeaderChip status={connectionStatus} />
          </div>

          {/* Service Manager Trigger Button */}
          <button
            onClick={() => setServicesModalOpen(true)}
            className="w-full mt-3.5 py-2 px-3.5 rounded-xl bg-slate-900 dark:bg-slate-800 text-white text-xs font-semibold hover:bg-slate-800 dark:hover:bg-slate-700 transition-all flex items-center justify-between group shadow-sm border border-slate-800 dark:border-slate-700 active:scale-[0.98]"
          >
            <span className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse" />
              <span>Services Control</span>
            </span>
            <span className="text-[11px] text-slate-400 group-hover:text-amber-300 font-mono">
              ⚙ Live
            </span>
          </button>
        </div>

        <nav className="nav-links">
          <Link href="/">
            <span>📊</span> Dashboard
          </Link>
          <Link href="/leads">
            <span>👥</span> Leads
          </Link>
          <Link href="/queue">
            <span>📥</span> Queue
          </Link>
          <Link href="/sequences">
            <span>⚡</span> Sequences
          </Link>
          <Link href="/log">
            <span>📜</span> Message Log
          </Link>
          <Link href="/ai">
            <span>🤖</span> AI Settings
          </Link>
          <Link href="/connection">
            <span>🔌</span> Connection
          </Link>

          <div className="nav-divider">Configuration</div>
          <Link href="/settings/stages">
            <span>🏷️</span> Stages
          </Link>
          <Link href="/settings/replies">
            <span>💬</span> Quick Replies
          </Link>
          <Link href="/settings">
            <span>⚙️</span> Policy &amp; System
          </Link>

          <div className="nav-divider">Account</div>
          <Link href="/billing">
            <span>💳</span> Plans &amp; Billing
          </Link>

        </nav>

        {operator && (
          <div className="operator-footer">
            <div className="min-w-0 pr-2">
              <span className="operator-name block truncate">{operator.displayName}</span>
              <span className="text-xs text-muted block truncate" title={operator.email}>
                {operator.account?.name || operator.email}
              </span>
            </div>
            <button
              className="px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-800 text-xs font-medium text-slate-600 dark:text-slate-300 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 transition-colors"
              onClick={handleLogout}
            >
              Logout
            </button>
          </div>
        )}
      </aside>

      {/* Backdrop overlay for mobile menu */}
      {mobileMenuOpen && (
        <div
          className="fixed inset-0 bg-black/50 backdrop-blur-sm z-40 lg:hidden"
          onClick={() => setMobileMenuOpen(false)}
        />
      )}

      {/* Main Content Area */}
      <main className="main" role="main">
        {operator?.billing && <BillingBanner billing={operator.billing} onBillingPage={path === "/billing"} />}
        {children}
      </main>

      <ServicesModal
        isOpen={servicesModalOpen}
        onClose={() => setServicesModalOpen(false)}
      />
    </div>
    </SessionContext.Provider>
  );
}

function RouteSwitch() {
  const { path } = useRouter();
  const { me } = useSession();

  if (path === "/login") {
    return <LoginView />;
  }

  // Admin console: only these pages. Anything else is redirected to /admin by the layout.
  if (me?.role === "superadmin") {
    if (path === "/admin") return <AdminOverviewView />;
    if (path === "/admin/clients") return <AdminClientsView />;
    if (path === "/admin/plans") return <AdminPlansView />;
    if (path === "/admin/activity") return <AdminActivityView />;
    if (path === "/admin/account") return <AdminAccountView />;
    const clientMatch = path.match(/^\/admin\/clients\/([^/]+)$/);
    if (clientMatch && clientMatch[1]) {
      return <AdminClientDetailView accountId={safeDecode(clientMatch[1])} />;
    }
    if (path.startsWith("/admin")) return <NotFound />;
    return null;
  }

  // Client desk below. /admin paths are redirected to / by the layout.
  if (path.startsWith("/admin")) return null;

  if (path === "/billing") {
    return <BillingView />;
  }

  if (path === "/" || path === "/dashboard") {
    return <DashboardView />;
  }

  if (path === "/leads") {
    return <LeadsView />;
  }

  if (path === "/queue") {
    return <QueueView />;
  }

  if (path === "/sequences") {
    return <SequencesView />;
  }

  if (path === "/connection") {
    return <ConnectionView />;
  }

  if (path === "/log") {
    return <LogView />;
  }

  if (path === "/ai") {
    return <AiSettingsView />;
  }

  const leadMatch = path.match(/^\/leads\/([^/]+)$/);
  if (leadMatch && leadMatch[1]) {
    return <LeadDetailView leadId={leadMatch[1]} />;
  }

  if (path === "/settings/stages") {
    return <StagesView />;
  }

  if (path === "/settings/replies") {
    return <RepliesView />;
  }

  if (path === "/settings") {
    return <SettingsView />;
  }

  return <NotFound />;
}

function NotFound() {
  return (
    <div className="p-8 text-center">
      <h2>PAGE NOT FOUND</h2>
      <p className="muted mt-2">
        The requested URL was not recognized on this desk.
      </p>
    </div>
  );
}

export function App() {
  return (
    <Router>
      <MainLayout>
        <RouteSwitch />
      </MainLayout>
    </Router>
  );
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
