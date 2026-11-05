import { notFound, redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getChatGPTUser } from "../chatgpt-auth";
import { isSelfHosted, verifyValue } from "@/lib/selfhost-auth";
import { deniedCookie, microsoftSignInReady, type DeniedAccount } from "@/lib/microsoft-signin";
export const dynamic = "force-dynamic";
export default async function Login({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (!isSelfHosted()) notFound();
  if (await getChatGPTUser()) redirect("/");
  const query = await searchParams; const microsoft = await microsoftSignInReady();
  const denied = query.error === "not_allowed" ? await verifyValue<DeniedAccount>((await cookies()).get(deniedCookie)?.value) : null;
  const deniedEmail = denied && typeof denied.email === "string" && denied.exp > Date.now() / 1000 ? denied.email : "";
  const errors: Record<string, string> = { credentials: "Email or password was incorrect.", not_allowed: deniedEmail ? `You signed in to Microsoft as ${deniedEmail}, which is not on this workspace's sign-in list. Ask the administrator to add this exact address under Connections → Environment editor → Operator sign-in emails.` : "Your Microsoft account is not on this workspace's sign-in list. Ask the administrator to add it under Connections → Environment editor → Operator sign-in emails.", microsoft_cancelled: "Microsoft sign-in was cancelled.", microsoft_expired: "The sign-in attempt expired. Try again.", microsoft_failed: "Microsoft sign-in could not be completed. Check the app registration's redirect URI.", microsoft_unconfigured: "Microsoft sign-in is not configured yet. Use the administrator password." };
  const passwordForm = <form className="login-password-form" action="/api/session" method="POST"><label className="field"><span>Administrator email</span><input type="email" name="email" autoComplete="username" required maxLength={254} /></label><label className="field"><span>Password</span><input type="password" name="password" autoComplete="current-password" required maxLength={512} /></label><button className={"btn full" + (microsoft ? "" : " primary")} type="submit">Sign in with password</button></form>;
  const highlights = [
    ["Approved, step by step", "Every role, group and license removal gets its own approval."],
    ["Data preserved first", "Mailbox and OneDrive handover come before any license is released."],
    ["Audit-ready records", "Each decision, action and outcome is logged and exportable."],
  ];
  return <main className="selfhost-login">
    <section className="login-brand" aria-label="About Exitwise">
      <img className="login-logo" src="/tsme-logo-light.png" alt="TSME — Technology Strategies Middle East" width={185} height={75} />
      <div className="login-brand-copy">
        <span className="login-kicker">EXITWISE · EMPLOYEE OFFBOARDING</span>
        <h2>Secure every departure in Microsoft 365.</h2>
        <ul className="login-highlights">{highlights.map(([title, text]) => <li key={title}><span className="login-check" aria-hidden="true">✓</span><div><strong>{title}</strong><p>{text}</p></div></li>)}</ul>
      </div>
      <small className="login-brand-foot">© TSME — Technology Strategies Middle East</small>
    </section>
    <section className="login-card-wrap">
      <div className="panel login-card">
        <img className="login-logo-mobile" src="/tsme-logo-footer.png" alt="TSME" width={79} height={45} />
        <div className="eyebrow">SELF-HOSTED WORKSPACE</div>
        <h1>Sign in to Exitwise</h1>
        <p>{microsoft ? "Use your work Microsoft account. Only people on this workspace's sign-in list can enter." : "Sign in with the administrator credentials you configured for this installation."}</p>
        {query.error && <div className="login-error" role="alert">{errors[query.error] || errors.microsoft_failed}</div>}
        {microsoft ? <><a className="btn primary full microsoft-signin" href="/api/auth/microsoft"><span className="ms-mark" aria-hidden="true"><i /><i /><i /><i /></span>Sign in with Microsoft</a><details className="password-fallback"><summary>Use the administrator password instead</summary>{passwordForm}</details></> : passwordForm}
        <small className="login-note">{microsoft ? "Sign-in access is managed under Connections → Operator sign-in emails." : "Microsoft sign-in becomes available after the tenant connection is saved under Connections."}</small>
      </div>
    </section>
  </main>;
}
