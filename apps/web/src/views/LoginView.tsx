import { useState } from "react";
import { apiRequest } from "../api.js";
import { useRouter } from "../router.js";

/**
 * The only public page. There is no sign-up and no first-run setup: the admin login lives in the
 * database, and the admin creates every other login in the admin panel and hands over the
 * email and password.
 */
export function LoginView() {
  const { navigate } = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await apiRequest("/api/v1/session", {
        method: "POST",
        body: JSON.stringify({ email: email.trim(), password }),
      });
      navigate("/");
    } catch (err: unknown) {
      const apiErr = err as { code?: string; message?: string };
      if (apiErr.code === "account_suspended") {
        setError("This account is suspended. Contact your administrator.");
      } else if (apiErr.code === "not_authenticated") {
        setError("Incorrect email or password. Please try again.");
      } else if (apiErr.code === "rate_limited") {
        setError("Too many attempts. Please wait a few minutes and try again.");
      } else {
        setError(apiErr.message || "Sign-in failed. Please try again.");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-slate-50 dark:bg-slate-950 transition-colors">
      <div className="card p-8 sm:p-10 w-full max-w-md shadow-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 animate-scale-in">
        <div className="text-center mb-8">
          <div className="w-14 h-14 rounded-2xl bg-indigo-600 text-white flex items-center justify-center text-2xl font-black mx-auto mb-4 shadow-sm shadow-indigo-500/25">
            LD
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white m-0">Sign in to Lead Desk</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1.5 mb-0">WhatsApp CRM &amp; automation</p>
        </div>

        {error && (
          <div className="error-banner mb-6" role="alert">
            {error}
          </div>
        )}

        <form onSubmit={handleLogin} className="space-y-5">
          <div>
            <label
              htmlFor="login-email"
              className="text-xs font-bold text-slate-700 dark:text-slate-300 block mb-1.5 uppercase tracking-wider"
            >
              Email
            </label>
            <input
              id="login-email"
              type="email"
              required
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="input w-full p-3 border rounded-xl text-sm outline-none focus:border-indigo-500 bg-white dark:bg-slate-800 border-slate-300 dark:border-slate-700 text-slate-900 dark:text-white"
              placeholder="you@company.com"
              autoFocus
            />
          </div>
          <div>
            <label
              htmlFor="login-password"
              className="text-xs font-bold text-slate-700 dark:text-slate-300 block mb-1.5 uppercase tracking-wider"
            >
              Password
            </label>
            <input
              id="login-password"
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="input w-full p-3 border rounded-xl text-sm font-mono outline-none focus:border-indigo-500 bg-white dark:bg-slate-800 border-slate-300 dark:border-slate-700 text-slate-900 dark:text-white"
              placeholder="Enter your password"
            />
          </div>
          <div className="pt-1">
            <button type="submit" className="btn btn-primary w-full text-sm py-3 font-bold" disabled={loading}>
              {loading ? "Signing in..." : "Sign In"}
            </button>
          </div>
          <p className="text-center text-xs text-slate-500 dark:text-slate-400 m-0">
            Your administrator creates your login and gives you your email and password. Forgot your
            password? Ask them to reset it.
          </p>
        </form>
      </div>
    </div>
  );
}
