import { useEffect, useState } from "react";
import { apiRequest } from "../api.js";

/** The dashboard may sit on a static host that only proxies the API; the extension talks to the server directly. */
const EXTENSION_SERVER_URL = (import.meta.env.VITE_EXTENSION_SERVER_URL || window.location.origin).replace(/\/+$/, "");

interface DeviceItem {
  id: string;
  label: string;
  pairedAt: string;
  lastSeenAt: string;
  revokedAt: string | null;
  waPushName: string | null;
  waJid: string | null;
  sender: boolean;
  grace: boolean;
  leaseUntil: string | null;
}

interface PairingCodeRes {
  code: string;
  expiresAt: string;
}

export function ConnectionView() {
  const [devices, setDevices] = useState<DeviceItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Pairing code modal state
  const [pairCode, setPairCode] = useState<string | null>(null);
  const [codeExpiresAt, setCodeExpiresAt] = useState<string | null>(null);
  const [generatingCode, setGeneratingCode] = useState(false);

  const loadDevices = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiRequest<{ items: DeviceItem[] }>("/api/v1/devices");
      setDevices(res.items);
    } catch (err: any) {
      setError(err.message || "Failed to load connected devices.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadDevices();
  }, []);

  const handleGenerateCode = async () => {
    setError(null);
    setGeneratingCode(true);
    try {
      const res = await apiRequest<PairingCodeRes>("/api/v1/pairing-codes", { method: "POST" });
      setPairCode(res.code);
      setCodeExpiresAt(res.expiresAt);
    } catch (err: any) {
      setError(err.message || "Failed to generate pairing code.");
    } finally {
      setGeneratingCode(false);
    }
  };

  const handleMakeSender = async (deviceId: string) => {
    setError(null);
    try {
      await apiRequest(`/api/v1/devices/${deviceId}/sender`, { method: "POST" });
      loadDevices();
    } catch (err: any) {
      setError(err.message || "Failed to promote device to sender.");
    }
  };

  const handleRevoke = async (deviceId: string) => {
    if (!window.confirm("Are you sure you want to revoke this device? It will be disconnected immediately.")) {
      return;
    }
    setError(null);
    try {
      await apiRequest(`/api/v1/devices/${deviceId}/revoke`, { method: "POST" });
      loadDevices();
    } catch (err: any) {
      setError(err.message || "Failed to revoke device.");
    }
  };

  return (
    <div className="view-container animate-fade-in space-y-6">
      {/* View Header */}
      <div className="view-header flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight text-slate-900 dark:text-white m-0">
            Extension Connection
          </h1>
          <p className="text-base text-slate-500 dark:text-slate-400 mt-1">
            Manage paired Chrome extensions and active WhatsApp sender leases.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button className="btn btn-secondary text-sm px-4 py-2.5 rounded-lg" onClick={loadDevices}>
            Refresh
          </button>
          <button
            className="btn btn-primary text-sm px-5 py-2.5 rounded-lg font-medium"
            onClick={handleGenerateCode}
            disabled={generatingCode}
          >
            {generatingCode ? "Generating..." : "+ Pair New Device"}
          </button>
        </div>
      </div>

      {error && (
        <div className="p-4 rounded-xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 text-rose-700 dark:text-rose-300 text-sm">
          {error}
        </div>
      )}

      {/* Connected Devices Table */}
      <div className="card bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-0 shadow-sm overflow-hidden">
        {loading ? (
          <div className="py-16 text-center text-slate-400 dark:text-slate-500">
            <div className="inline-block w-6 h-6 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin mb-2" />
            <p className="text-sm">Loading connected devices...</p>
          </div>
        ) : devices.length === 0 ? (
          <div className="py-16 text-center text-slate-500 dark:text-slate-400 space-y-4">
            <div className="w-12 h-12 mx-auto rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-xl">
              🔌
            </div>
            <div>
              <p className="text-base font-semibold text-slate-800 dark:text-slate-200">
                No extension devices paired yet
              </p>
              <p className="text-sm text-slate-400 max-w-sm mx-auto mt-1">
                Install the Lead Desk Chrome extension and generate an 8-character pairing code to connect.
              </p>
            </div>
            <button className="btn btn-primary text-sm px-5 py-2.5 rounded-lg font-medium" onClick={handleGenerateCode}>
              Generate Pairing Code
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm divide-y divide-slate-200 dark:divide-slate-800">
              <thead className="bg-slate-50 dark:bg-slate-800/60 text-xs uppercase font-semibold text-slate-500 dark:text-slate-400">
                <tr>
                  <th className="px-5 py-3.5">Device Label</th>
                  <th className="px-5 py-3.5">Status</th>
                  <th className="px-5 py-3.5">WhatsApp Push Name</th>
                  <th className="px-5 py-3.5">WhatsApp JID</th>
                  <th className="px-5 py-3.5">Last Seen</th>
                  <th className="px-5 py-3.5">Paired At</th>
                  <th className="px-5 py-3.5 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60">
                {devices.map((device) => {
                  let statusBadge = (
                    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300">
                      Standby
                    </span>
                  );
                  if (device.revokedAt) {
                    statusBadge = (
                      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300">
                        Revoked
                      </span>
                    );
                  } else if (device.sender) {
                    statusBadge = (
                      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300">
                        Sender (Active)
                      </span>
                    );
                  } else if (device.grace) {
                    statusBadge = (
                      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300">
                        Reconnecting
                      </span>
                    );
                  }

                  return (
                    <tr
                      key={device.id}
                      className="hover:bg-slate-50/70 dark:hover:bg-slate-800/40 transition-colors"
                    >
                      <td className="px-5 py-4">
                        <span className="font-semibold text-sm text-slate-900 dark:text-white">
                          {device.label}
                        </span>
                        <div className="text-xs text-slate-400 font-mono mt-0.5">{device.id}</div>
                      </td>
                      <td className="px-5 py-4 whitespace-nowrap">
                        {statusBadge}
                        {device.grace && device.leaseUntil && (
                          <div className="text-xs text-slate-400 mt-1">
                            Grace until {new Date(device.leaseUntil).toLocaleTimeString()}
                          </div>
                        )}
                      </td>
                      <td className="px-5 py-4 text-sm text-slate-700 dark:text-slate-300">
                        {device.waPushName || "—"}
                      </td>
                      <td className="px-5 py-4 font-mono text-xs text-slate-500 dark:text-slate-400">
                        {device.waJid || "—"}
                      </td>
                      <td className="px-5 py-4 text-xs font-mono text-slate-500 dark:text-slate-400 whitespace-nowrap">
                        {new Date(device.lastSeenAt).toLocaleString()}
                      </td>
                      <td className="px-5 py-4 text-xs font-mono text-slate-500 dark:text-slate-400 whitespace-nowrap">
                        {new Date(device.pairedAt).toLocaleDateString()}
                      </td>
                      <td className="px-5 py-4 text-right whitespace-nowrap">
                        <div className="flex items-center justify-end gap-2">
                          {!device.revokedAt && !device.sender && (
                            <button
                              className="btn btn-secondary text-xs px-3 py-1.5 rounded-lg"
                              onClick={() => handleMakeSender(device.id)}
                            >
                              Make Sender
                            </button>
                          )}
                          {!device.revokedAt && (
                            <button
                              className="btn btn-danger text-xs px-3 py-1.5 rounded-lg"
                              onClick={() => handleRevoke(device.id)}
                            >
                              Revoke
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Pairing Code Modal */}
      {pairCode && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in"
          role="dialog"
          aria-modal="true"
        >
          <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-800 w-full max-w-sm p-7 text-center animate-scale-in space-y-4">
            <h3 className="text-xl font-bold text-slate-900 dark:text-white m-0">
              Pair Extension
            </h3>
            <p className="text-sm text-slate-500 dark:text-slate-400">
              Enter this 8-character Crockford code into your Lead Desk Chrome extension popup.
            </p>

            <div className="my-4 p-5 font-mono font-extrabold text-3xl tracking-widest bg-indigo-50 dark:bg-indigo-950/50 rounded-xl border-2 border-dashed border-indigo-300 dark:border-indigo-700 text-indigo-700 dark:text-indigo-300 select-all">
              {pairCode}
            </div>

            <p className="text-sm text-slate-500 dark:text-slate-400">
              Server address for the extension:{" "}
              <span className="font-mono font-semibold text-slate-800 dark:text-slate-200 select-all break-all">
                {EXTENSION_SERVER_URL}
              </span>
            </p>

            <p className="text-xs text-slate-400 dark:text-slate-500">
              Code is valid for 10 minutes.
              {codeExpiresAt && ` (Expires ${new Date(codeExpiresAt).toLocaleTimeString()})`}
            </p>

            <div className="pt-2 flex justify-center">
              <button
                className="btn btn-primary text-sm px-8 py-2.5 font-bold rounded-lg"
                onClick={() => setPairCode(null)}
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
