"use client";
import { useEffect, useState } from "react";
import { AlertCircle, Check, KeyRound, LoaderCircle, LockKeyhole, RefreshCw, Save, ShieldCheck } from "lucide-react";

type Configuration = { revision: number; ready: boolean; tenantId: string; clientId: string; secretConfigured: boolean; certificate: string; certificateKeyConfigured: boolean; adminEmails: string; protectedUsers: string; liveEnabled: boolean; source: string; updatedAt: string | null; updatedBy: string | null };
export default function EnvironmentEditor({ onSaved }: { onSaved: () => Promise<void> }) {
  const [saved, setSaved] = useState<Configuration | null>(null);
  const [draft, setDraft] = useState<Configuration | null>(null);
  const [secret, setSecret] = useState("");
  const [clearSecret, setClearSecret] = useState(false);
  const [certKey, setCertKey] = useState("");
  const [clearCertificate, setClearCertificate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [allowed, setAllowed] = useState(true);
  async function load() {
    setLoading(true); setError("");
    try {
      const response = await fetch("/api/environment", { cache: "no-store" });
      const data = await response.json() as { configuration: Configuration; error?: string; message?: string };
      if (response.status === 403) { setAllowed(false); return; }
      if (!response.ok) throw new Error(data.error || "The environment editor could not be loaded.");
      setSaved(data.configuration); setDraft(data.configuration); setSecret(""); setClearSecret(false); setCertKey(""); setClearCertificate(false);
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);
  const dirty = !!draft && (JSON.stringify(draft) !== JSON.stringify(saved) || !!secret || clearSecret || !!certKey || clearCertificate);
  function update<K extends keyof Configuration>(key: K, value: Configuration[K]) { setDraft(d => d ? { ...d, [key]: value } : d); setMessage(""); }
  async function save(event: React.FormEvent) {
    event.preventDefault(); if (!draft) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const response = await fetch("/api/environment", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision: draft.revision, tenantId: draft.tenantId, clientId: draft.clientId, clientSecret: secret || undefined, clearSecret, certificate: draft.certificate !== saved?.certificate ? draft.certificate : undefined, certificateKey: certKey || undefined, clearCertificate, adminEmails: draft.adminEmails, protectedUsers: draft.protectedUsers, liveEnabled: draft.liveEnabled }) });
      const data = await response.json() as { configuration: Configuration; error?: string; message?: string }; if (!response.ok) throw new Error(data.error || "Settings could not be saved.");
      setSaved(data.configuration); setDraft(data.configuration); setSecret(""); setClearSecret(false); setCertKey(""); setClearCertificate(false);
      await onSaved(); setMessage("Saved. The new settings are active. Test your connection below.");
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function test() {
    setBusy(true); setError(""); setMessage("");
    try {
      const response = await fetch("/api/workspace", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "connection_test" }) });
      const data = await response.json() as { configuration: Configuration; error?: string; message?: string }; if (!response.ok) throw new Error(data.error || "Connection test failed.");
      setMessage((data.message || "Connection verified.") + " Run a live inactive-account scan to verify sign-in reporting permissions.");
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  if (!allowed) return null;
  return <section className="panel environment-editor" aria-labelledby="environment-title">
    <div className="section-heading"><div><h2 id="environment-title"><KeyRound size={19} />Environment editor</h2><p>Configure the Microsoft connection here. Saved settings take effect immediately.</p></div><span className="version-tag"><LockKeyhole size={12} /> ADMIN ONLY</span></div>
    {loading ? <div className="environment-loading"><LoaderCircle className="spin" size={20} />Loading connection settings…</div> : <>
      {error && <div className="environment-feedback error" role="alert"><AlertCircle size={17} /><span>{error}</span></div>}
      {message && <div className="environment-feedback success" role="status"><Check size={17} /><span>{message}</span></div>}
      {!draft ? <div className="environment-actions"><button className="btn" onClick={load}><RefreshCw size={15} />Retry</button></div> : <form onSubmit={save}>
        {!draft.ready && <div className="environment-feedback error"><AlertCircle size={17} />The host administrator needs to initialize the server encryption key before settings can be saved.</div>}
        <fieldset disabled={busy || !draft.ready} className="environment-fields">
          <div className="form-grid">
            <label className="field"><span>Tenant ID <small>MS_TENANT_ID</small></span><input required value={draft.tenantId} onChange={e => update("tenantId", e.target.value)} placeholder="Directory (tenant) GUID" autoComplete="off" spellCheck={false} /></label>
            <label className="field"><span>Application client ID <small>MS_CLIENT_ID</small></span><input required value={draft.clientId} onChange={e => update("clientId", e.target.value)} placeholder="Application (client) GUID" autoComplete="off" spellCheck={false} /></label>
            <label className="field environment-full"><span>Client secret <small>MS_CLIENT_SECRET · {saved?.secretConfigured ? "Saved securely" : "Not configured"}</small></span><input type="password" value={secret} onChange={e => { setSecret(e.target.value); setClearSecret(false); setMessage(""); }} placeholder={saved?.secretConfigured ? "Leave empty to keep the saved secret" : "Paste the secret Value from Microsoft Entra"} autoComplete="new-password" spellCheck={false} disabled={clearSecret} /><small className="environment-hint">The secret is encrypted on the server and is never returned to this form.</small></label>
            {saved?.secretConfigured && <label className="checkbox-row environment-full"><input type="checkbox" checked={clearSecret} onChange={e => { setClearSecret(e.target.checked); setSecret(""); if (e.target.checked) update("liveEnabled", false); }} />Clear the saved client secret and disable live changes</label>}
            <label className="field environment-full"><span>App certificate <small>For OneDrive handover · {saved?.certificateKeyConfigured ? "Saved securely" : "Not configured"}</small></span><textarea rows={3} value={draft.certificate} disabled={clearCertificate} onChange={e => update("certificate", e.target.value)} placeholder="-----BEGIN CERTIFICATE-----" spellCheck={false} /><small className="environment-hint">The same certificate you uploaded to the app registration (Certificates &amp; secrets). SharePoint needs it to add a site collection administrator.</small></label>
            <label className="field environment-full"><span>Certificate private key <small>{saved?.certificateKeyConfigured ? "Saved securely" : "Not configured"}</small></span><textarea rows={3} value={certKey} disabled={clearCertificate} onChange={e => { setCertKey(e.target.value); setMessage(""); }} placeholder={saved?.certificateKeyConfigured ? "Leave empty to keep the saved private key" : "-----BEGIN PRIVATE KEY-----"} spellCheck={false} autoComplete="off" /><small className="environment-hint">Encrypted on the server and never returned to this form.</small></label>
            {saved?.certificateKeyConfigured && <label className="checkbox-row environment-full"><input type="checkbox" checked={clearCertificate} onChange={e => { setClearCertificate(e.target.checked); setCertKey(""); }} />Remove the saved certificate</label>}
            <label className="field environment-full"><span>Operator sign-in emails <small>OFFBOARDING_ADMIN_EMAILS</small></span><textarea required rows={2} value={draft.adminEmails} onChange={e => update("adminEmails", e.target.value)} placeholder="admin@example.com, operator@example.com" spellCheck={false} /><small className="environment-hint">Only these people can sign in with Microsoft. Remove someone and their access ends on their next click. Add redirect URI <code>{typeof window === "undefined" ? "" : window.location.origin + "/api/auth/microsoft/callback"}</code> to the app registration (Authentication → Web).</small></label>
            <label className="field environment-full"><span>Protected Microsoft accounts <small>OFFBOARDING_PROTECTED_USERS · Optional</small></span><textarea rows={2} value={draft.protectedUsers} onChange={e => update("protectedUsers", e.target.value)} placeholder="breakglass@example.com, service@example.com" spellCheck={false} /><small className="environment-hint">Accounts Exitwise must never offboard. Enter Microsoft sign-in names, and add your Microsoft admin UPN if it differs from your workspace email. This list does not grant sign-in: use Operator sign-in emails for that.</small></label>
          </div>
          <label className={"environment-live " + (draft.liveEnabled ? "enabled" : "")}><input type="checkbox" checked={draft.liveEnabled} disabled={clearSecret} onChange={e => update("liveEnabled", e.target.checked)} /><span><strong>Enable live offboarding changes</strong><small>Leave off to use live reporting only. Enabling this allows approved offboarding actions; every removal still requires its own approval.</small></span><ShieldCheck size={22} /></label>
          <div className="environment-actions"><button className="btn primary" type="submit" disabled={!dirty}>{busy ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />}Save settings</button><button className="btn" type="button" disabled={dirty || !saved?.secretConfigured} onClick={test}><RefreshCw size={15} />Test saved connection</button><button className="text-btn" type="button" onClick={load}>Reload saved settings</button></div>
          {dirty && <p className="environment-hint environment-save-note">Save your changes before testing the new connection.</p>}
        </fieldset>
        <div className="environment-footnote"><LockKeyhole size={14} /><span>{saved?.updatedAt ? `Last saved ${new Date(saved.updatedAt).toLocaleString()} by ${saved.updatedBy}.` : "Host environment values are used until you save settings here."} Secrets are excluded from audit exports.</span></div>
      </form>}
    </>}
  </section>;
}
