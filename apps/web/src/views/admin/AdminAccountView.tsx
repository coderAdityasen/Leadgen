import { useEffect, useState } from "react";
import { apiRequest } from "../../api.js";
import { useSession } from "../../session.js";
import { apiErrorText } from "../../format.js";
import { PageLoading, cardClass, fieldClass } from "../../components/BillingParts.js";

/** The admin's own login: name and password. */
export function AdminAccountView() {
  const { me, reloadMe } = useSession();
  const [name, setName] = useState("");
  const [nameMsg, setNameMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [savingName, setSavingName] = useState(false);

  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [pwMsg, setPwMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [savingPw, setSavingPw] = useState(false);

  useEffect(() => {
    if (me) setName(me.displayName);
  }, [me?.displayName]);

  if (!me) return <PageLoading />;

  const saveName = async (e: React.FormEvent) => {
    e.preventDefault();
    setNameMsg(null);
    setSavingName(true);
    try {
      await apiRequest("/api/v1/me", { method: "PATCH", body: JSON.stringify({ displayName: name.trim() }) });
      await reloadMe();
      setNameMsg({ ok: true, text: "Name saved." });
    } catch (err) {
      setNameMsg({ ok: false, text: apiErrorText(err, "Could not save the name.") });
    } finally {
      setSavingName(false);
    }
  };

  const savePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPwMsg(null);
    if (next.length < 12) return setPwMsg({ ok: false, text: "The new password must be at least 12 characters." });
    if (next !== confirm) return setPwMsg({ ok: false, text: "The two new passwords do not match." });
    setSavingPw(true);
    try {
      await apiRequest("/api/v1/me/password", {
        method: "POST",
        body: JSON.stringify({ currentPassword: current, nextPassword: next }),
      });
      setCurrent("");
      setNext("");
      setConfirm("");
      setPwMsg({ ok: true, text: "Password changed. Your other sessions were signed out." });
    } catch (err) {
      const code = (err as { code?: string }).code;
      setPwMsg({
        ok: false,
        text: code === "not_authenticated" ? "Your current password is not correct." : apiErrorText(err, "Could not change the password."),
      });
    } finally {
      setSavingPw(false);
    }
  };

  const message = (m: { ok: boolean; text: string } | null) =>
    m && (
      <p
        role={m.ok ? "status" : "alert"}
        className={`text-sm m-0 ${m.ok ? "text-emerald-700 dark:text-emerald-400" : "text-rose-700 dark:text-rose-400"}`}
      >
        {m.text}
      </p>
    );

  return (
    <div className="view-container animate-fade-in space-y-6 max-w-2xl">
      <div className="view-header">
        <h1 className="text-3xl font-extrabold tracking-tight text-slate-900 dark:text-white m-0">My account</h1>
        <p className="text-base text-slate-500 dark:text-slate-400 mt-1">Your admin login.</p>
      </div>

      <section className={`${cardClass} p-6 space-y-4`}>
        <h2 className="text-lg font-bold text-slate-900 dark:text-white m-0">Profile</h2>
        <form onSubmit={saveName} className="space-y-4">
          <label className={fieldClass}>
            Email (your login)
            <input type="email" value={me.email} readOnly className="opacity-80" />
          </label>
          <label className={fieldClass}>
            Name
            <input type="text" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <div className="flex items-center gap-3">
            <button type="submit" className="btn btn-primary btn-sm" disabled={savingName || !name.trim() || name.trim() === me.displayName}>
              {savingName ? "Saving…" : "Save name"}
            </button>
            {message(nameMsg)}
          </div>
        </form>
      </section>

      <section className={`${cardClass} p-6 space-y-4`}>
        <h2 className="text-lg font-bold text-slate-900 dark:text-white m-0">Change password</h2>
        <form onSubmit={savePassword} className="space-y-4">
          <label className={fieldClass}>
            Current password
            <input type="password" required autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
          </label>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <label className={fieldClass}>
              New password (12+ characters)
              <input type="password" required minLength={12} autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
            </label>
            <label className={fieldClass}>
              Repeat new password
              <input type="password" required autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </label>
          </div>
          <div className="flex items-center gap-3">
            <button type="submit" className="btn btn-primary btn-sm" disabled={savingPw}>
              {savingPw ? "Changing…" : "Change password"}
            </button>
            {message(pwMsg)}
          </div>
        </form>
        <p className="text-xs text-slate-500 dark:text-slate-400 m-0">
          Forgot it? On the server run <code className="font-mono">npm run admin:reset-password -- --email {me.email}</code>.
        </p>
      </section>
    </div>
  );
}
