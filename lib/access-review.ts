import type { Case, Finding, Step } from './model';
import { available, done, event, retained } from './model';
import { assertLive, graphClient, licenseName } from './graph';
import { saveCase } from './store';
import { validateRun } from './agent';

type Api = Awaited<ReturnType<typeof graphClient>>;
const list = (names: string[]) => names.slice(0, 8).join(', ') + (names.length > 8 ? ` and ${names.length - 8} more` : '');
function unchecked(error: unknown, permission: string): Omit<Finding, 'check'> {
  const message = error instanceof Error ? error.message : 'Request failed.';
  return { status: 'unchecked', detail: /Graph 40[13]/.test(message) ? `Not checked: the app needs the ${permission} permission.` : /Graph 400|Graph 404/.test(message) ? 'Not available for this tenant or account.' : 'Not checked: ' + message };
}

/** Read-only review of the access that remains after the cleanup steps. Records each finding; changes nothing in Microsoft 365. */
export async function reviewAccess(owner: string, actor: string, c: Case, s: Step): Promise<Case> {
  validateRun(c); await assertLive(actor, c.email);
  if (s.id !== 'review' || done(s) || !available(c, s)) throw new Error('The access review is not open.');
  if (!c.inventory) throw new Error('Discovery is required.');
  s.status = 'running'; s.startedAt = new Date().toISOString(); event(c, actor, 'started', 'Automated access check started.'); await saveCase(owner, c);
  const findings: Finding[] = [];
  try {
    const api: Api = await graphClient(), uid = encodeURIComponent(c.inventory.id), principal = encodeURIComponent(`principalId eq '${c.inventory.id}'`);
    const check = async (name: string, permission: string, run: () => Promise<Omit<Finding, 'check'>>) => { try { findings.push({ check: name, ...await run() }); } catch (e) { findings.push({ check: name, ...unchecked(e, permission) }); } };
    const user = await api.call<{ userPrincipalName: string; accountEnabled: boolean; onPremisesSyncEnabled: boolean | null; assignedLicenses: { skuId: string }[] }>(`/users/${uid}?$select=userPrincipalName,accountEnabled,onPremisesSyncEnabled,assignedLicenses`);
    if (user.userPrincipalName.toLowerCase() !== c.email.toLowerCase()) throw new Error('The target account identity changed. Stop and create a newly reviewed case.');
    findings.push({ check: 'Sign-in blocked', status: user.accountEnabled ? 'attention' : 'ok', detail: user.accountEnabled ? 'The account can still sign in.' : 'Sign-in is disabled.' });
    findings.push({ check: 'On-premises source', status: user.onPremisesSyncEnabled ? 'attention' : 'ok', detail: user.onPremisesSyncEnabled ? 'Synchronized from on-premises Active Directory. Disable the account there too, or sync can re-enable it.' : 'Cloud-only account.' });
    await check('Direct Entra roles', 'RoleManagement.Read.Directory', async () => { const r = await api.all<{ roleDefinition?: { displayName?: string } }>(`/roleManagement/directory/roleAssignments?$filter=${principal}&$expand=roleDefinition`); return r.length ? { status: 'attention', detail: 'Still assigned: ' + list(r.map(x => x.roleDefinition?.displayName || 'Unknown role')) } : { status: 'ok', detail: 'No direct active roles.' }; });
    await check('PIM eligible roles', 'RoleManagement.Read.Directory', async () => { const r = await api.all<{ roleDefinition?: { displayName?: string } }>(`/roleManagement/directory/roleEligibilitySchedules?$filter=${principal}&$expand=roleDefinition`); return r.length ? { status: 'attention', detail: 'Can still activate: ' + list(r.map(x => x.roleDefinition?.displayName || 'Unknown role')) } : { status: 'ok', detail: 'No eligible roles.' }; });
    await check('Groups (including inherited)', 'Group.Read.All', async () => { const r = await api.all<{ displayName?: string }>(`/users/${uid}/transitiveMemberOf/microsoft.graph.group?$select=id,displayName`); return r.length ? { status: 'attention', detail: `Still a member of ${r.length}: ` + list(r.map(g => g.displayName || 'Unnamed group')) } : { status: 'ok', detail: 'No group memberships.' }; });
    findings.push(user.assignedLicenses.length ? { check: 'Licenses', status: retained(c) ? 'ok' : 'attention', detail: (retained(c) ? 'Kept by the preservation policy: ' : 'Still assigned: ') + list(user.assignedLicenses.map(l => licenseName(l.skuId))) } : { check: 'Licenses', status: 'ok', detail: 'No licenses assigned.' });
    await check('App assignments', 'Directory.Read.All', async () => { const r = await api.all<{ resourceDisplayName?: string }>(`/users/${uid}/appRoleAssignments?$select=resourceDisplayName`); return r.length ? { status: 'attention', detail: 'Assigned to: ' + list([...new Set(r.map(a => a.resourceDisplayName || 'Unknown app'))]) } : { status: 'ok', detail: 'No app assignments.' }; });
    await check('Delegated app consents', 'Directory.Read.All', async () => { const r = await api.all<{ scope?: string }>(`/users/${uid}/oauth2PermissionGrants`); return r.length ? { status: 'attention', detail: `${r.length} app consent(s) granted by this user remain.` } : { status: 'ok', detail: 'No user consents.' }; });
    await check('Owned groups and apps', 'Directory.Read.All', async () => { const r = await api.all<{ displayName?: string }>(`/users/${uid}/ownedObjects?$select=id,displayName`); return r.length ? { status: 'attention', detail: 'Owner of: ' + list(r.map(o => o.displayName || 'Unnamed object')) + '. Assign new owners.' } : { status: 'ok', detail: 'Owns no groups or apps.' }; });
    await check('Devices', 'Directory.Read.All', async () => { const r = await api.all<{ displayName?: string; accountEnabled?: boolean }>(`/users/${uid}/ownedDevices?$select=id,displayName,accountEnabled`); const active = r.filter(d => d.accountEnabled !== false); return active.length ? { status: 'attention', detail: 'Enabled devices: ' + list(active.map(d => d.displayName || 'Unnamed device')) } : { status: 'ok', detail: r.length ? 'All owned devices are disabled.' : 'No registered devices.' }; });
    findings.push({ check: 'Azure subscriptions (RBAC)', status: 'unchecked', detail: 'Outside Microsoft Graph. Check Azure portal → Access control (IAM) if the employee used Azure.' });
    const attention = findings.filter(f => f.status === 'attention').length, skipped = findings.filter(f => f.status === 'unchecked').length;
    s.findings = findings; s.status = 'completed'; s.completedAt = new Date().toISOString();
    s.detail = `Access check: ${findings.length - attention - skipped} clear, ${attention} need attention, ${skipped} not checked.`;
    s.evidence = findings.map(f => `${f.check}: ${f.status === 'ok' ? 'clear' : f.status === 'attention' ? 'needs attention' : 'not checked'} — ${f.detail}`).join('\n');
    event(c, 'Microsoft Graph', 'completed', 'Verify remaining access: ' + s.detail);
  } catch (error) { s.status = 'failed'; s.detail = (error instanceof Error ? error.message : 'Access check failed.') + ' Try again.'; event(c, 'Automation bot', 'failed', 'Verify remaining access: ' + s.detail); }
  await saveCase(owner, c); return c;
}
