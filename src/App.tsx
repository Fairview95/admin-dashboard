import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

const API_URL =
  import.meta.env.VITE_API_URL || "https://api.thestacc.com/core";

// --- Types ---

interface DemoModule {
  module: string;
  status: string;
  expired: boolean;
  project_id?: string | null;
  project_name?: string | null;
}

interface ProjectInfo {
  id: string;
  name: string;
}

interface DemoAccount {
  email: string;
  account_id: string;
  project_id: string | null;
  projects?: ProjectInfo[];
  modules: DemoModule[];
  granted_at: string;
  trial_ends_at: string;
  expired: boolean;
}

interface UserSubscriptionData {
  email: string;
  user_id: string;
  account_id: string;
  projects: { id: string; name: string; created_at: string }[];
  subscriptions: Record<string, unknown>[];
  module_activations: Record<string, unknown>[];
  blog_generation_counts: Record<string, number>;
}

// --- Constants ---

const PLAN_LABELS: Record<string, string> = {
  trial: "Trial",
  pro30: "Pro 30",
  active: "Active",
};

const STATUS_COLORS: Record<string, string> = {
  trial: "bg-amber-100 text-amber-700",
  pro30: "bg-blue-100 text-blue-700",
  active: "bg-emerald-100 text-emerald-700",
  trialing: "bg-amber-100 text-amber-700",
  expired: "bg-red-100 text-red-600",
};

// --- Spinner ---

const Spinner = ({ className = "h-3.5 w-3.5" }: { className?: string }) => (
  <svg className={`animate-spin ${className}`} viewBox="0 0 24 24">
    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
  </svg>
);

// --- API ---

function api(key: string) {
  const headers: Record<string, string> = {
    "X-Admin-Key": key,
    "Content-Type": "application/json",
  };

  async function handleResponse(res: Response) {
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      throw new Error(data?.detail || `Error ${res.status}`);
    }
    return res.json();
  }

  return {
    async grantDemo(email: string, days: number, plan: string, projectId?: string, modules: string[] = ["blog", "localseo", "social"]) {
      const body: Record<string, unknown> = { email, days, plan, modules };
      if (projectId) body.project_id = projectId;
      const res = await fetch(`${API_URL}/api/v1/admin/grant-demo`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      return handleResponse(res);
    },
    async listAccounts(): Promise<{ accounts: DemoAccount[] }> {
      const res = await fetch(`${API_URL}/api/v1/admin/demo-accounts`, { headers });
      return handleResponse(res);
    },
    async revokeDemo(email: string) {
      const res = await fetch(
        `${API_URL}/api/v1/admin/revoke-demo?email=${encodeURIComponent(email)}`,
        { method: "DELETE", headers }
      );
      return handleResponse(res);
    },
    async getUserSubscription(email: string): Promise<UserSubscriptionData> {
      const res = await fetch(
        `${API_URL}/api/v1/admin/user-subscription?email=${encodeURIComponent(email)}`,
        { headers }
      );
      return handleResponse(res);
    },
    async changeSubscription(email: string, plan: string, days?: number, projectId?: string, modules: string[] = ["blog", "localseo", "social"]) {
      const body: Record<string, unknown> = { email, plan, modules };
      if (days) body.days = days;
      if (projectId) body.project_id = projectId;
      const res = await fetch(`${API_URL}/api/v1/admin/change-subscription`, {
        method: "PUT",
        headers,
        body: JSON.stringify(body),
      });
      return handleResponse(res);
    },
  };
}

// --- Login ---

function LoginScreen({ onLogin }: { onLogin: (key: string) => void }) {
  const [key, setKey] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleLogin = async () => {
    if (!key.trim()) return;
    setLoading(true);
    setError("");
    try {
      await api(key).listAccounts();
      localStorage.setItem("admin_key", key);
      onLogin(key);
    } catch {
      setError("Invalid admin key");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-background">
      <div className="w-[360px] border border-border rounded-lg p-6 bg-card shadow-sm">
        <h1 className="text-lg font-semibold mb-1">theStacc Admin</h1>
        <p className="text-sm text-muted-foreground mb-5">Enter your admin key to continue</p>
        <Input
          type="password"
          placeholder="sk-admin-..."
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleLogin()}
          className="mb-3 h-9"
        />
        {error && <p className="text-sm text-destructive mb-3">{error}</p>}
        <Button onClick={handleLogin} disabled={loading || !key.trim()} className="w-full h-9 cursor-pointer">
          {loading ? <span className="flex items-center gap-2"><Spinner className="h-4 w-4" />Verifying...</span> : "Sign In"}
        </Button>
      </div>
    </div>
  );
}

// --- Inline message ---

function Message({ msg }: { msg: { type: "success" | "error"; text: string } | null }) {
  if (!msg) return null;
  return (
    <p className={`text-sm ${msg.type === "success" ? "text-emerald-600" : "text-destructive"}`}>
      {msg.text}
    </p>
  );
}

// --- Format helpers ---

function fmtDate(d: string) {
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function fmtShortDate(d: string) {
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// --- Dashboard ---

function Dashboard({ adminKey, onLogout }: { adminKey: string; onLogout: () => void }) {
  const client = api(adminKey);

  // User lookup state
  const [email, setEmail] = useState("");
  const [userData, setUserData] = useState<UserSubscriptionData | null>(null);
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupMsg, setLookupMsg] = useState<{ type: "success" | "error"; text: string } | null>(null);

  // Plan action state
  const [plan, setPlan] = useState("pro30");
  const [days, setDays] = useState("");
  const [selectedModules, setSelectedModules] = useState<string[]>(["blog", "localseo", "social"]);
  const [actingProject, setActingProject] = useState<string | null>(null); // null = not acting, "all" = apply all, project_id = specific

  // Demo accounts state
  const [accounts, setAccounts] = useState<DemoAccount[]>([]);
  const [loadingAccounts, setLoadingAccounts] = useState(true);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [revokeConfirm, setRevokeConfirm] = useState<string | null>(null);

  const loadAccounts = useCallback(async () => {
    try {
      const data = await client.listAccounts();
      setAccounts(data.accounts || []);
    } catch {
      // silent
    } finally {
      setLoadingAccounts(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adminKey]);

  useEffect(() => { loadAccounts(); }, [loadAccounts]);

  const handleLookup = async () => {
    if (!email.trim()) return;
    setLookupLoading(true);
    setLookupMsg(null);
    setUserData(null);
    try {
      const data = await client.getUserSubscription(email.trim());
      setUserData(data);
    } catch (err) {
      setLookupMsg({ type: "error", text: err instanceof Error ? err.message : "User not found" });
    } finally {
      setLookupLoading(false);
    }
  };

  // Grant (new user) or Change (existing) — same API pattern
  const handleApply = async (mode: "grant" | "change", projectId?: string) => {
    if (!email.trim()) return;
    setActingProject(projectId || "all");
    setLookupMsg(null);
    try {
      const d = days ? parseInt(days) : undefined;
      if (mode === "grant") {
        await client.grantDemo(email.trim(), d || 30, plan, projectId, selectedModules);
      } else {
        await client.changeSubscription(email.trim(), plan, d, projectId, selectedModules);
      }
      const label = projectId ? `project ${projectId.slice(0, 8)}...` : "all projects";
      setLookupMsg({ type: "success", text: `${PLAN_LABELS[plan]} applied to ${label}` });
      // Refresh both
      const data = await client.getUserSubscription(email.trim());
      setUserData(data);
      loadAccounts();
    } catch (err) {
      setLookupMsg({ type: "error", text: err instanceof Error ? err.message : "Failed" });
    } finally {
      setActingProject(null);
    }
  };

  const handleRevoke = async (accountEmail: string) => {
    setRevokeConfirm(null);
    setRevoking(accountEmail);
    try {
      await client.revokeDemo(accountEmail);
      loadAccounts();
    } catch {
      // silent
    } finally {
      setRevoking(null);
    }
  };

  // Helper: get activation for a project+module
  const getActivation = (projectId: string, module: string) => {
    if (!userData) return null;
    return userData.module_activations.find(
      (a: Record<string, unknown>) => a.project_id === projectId && a.module_code === module
    ) as Record<string, unknown> | undefined;
  };

  const hasSubscriptions = userData && userData.module_activations.length > 0;
  const activeCount = accounts.filter((a) => !a.expired).length;

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border bg-card">
        <div className="max-w-5xl mx-auto px-6 h-12 flex items-center justify-between">
          <span className="font-semibold text-sm">theStacc Admin</span>
          <Button variant="ghost" size="sm" onClick={onLogout} className="text-muted-foreground hover:text-destructive text-xs cursor-pointer">
            Sign Out
          </Button>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-6 space-y-8">

        {/* ============ USER LOOKUP + ACTIONS ============ */}
        <section>
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">User Management</h2>

          {/* Lookup bar */}
          <div className="flex gap-2 mb-3">
            <Input
              type="email"
              placeholder="user@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleLookup()}
              className="max-w-sm h-9"
            />
            <Button onClick={handleLookup} disabled={lookupLoading || !email.trim()} className="h-9 px-4 cursor-pointer">
              {lookupLoading ? <Spinner /> : "Lookup"}
            </Button>
          </div>

          <Message msg={lookupMsg} />

          {/* User found — show projects table + actions */}
          {userData && (
            <div className="mt-3 border border-border rounded-lg overflow-hidden">
              {/* User header row */}
              <div className="px-4 py-2.5 bg-muted/40 border-b border-border flex items-center justify-between">
                <div>
                  <span className="text-sm font-semibold">{userData.email}</span>
                  <span className="text-xs text-muted-foreground ml-2 font-mono">{userData.account_id.slice(0, 8)}...</span>
                </div>
                <span className="text-xs text-muted-foreground">{userData.projects.length} project{userData.projects.length !== 1 ? "s" : ""}</span>
              </div>

              {/* Projects table */}
              {userData.projects.length > 0 && (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border bg-muted/20 text-xs text-muted-foreground uppercase tracking-wider">
                      <th className="text-left px-4 py-2 font-medium">Project</th>
                      <th className="text-left px-4 py-2 font-medium">Blog</th>
                      <th className="text-left px-4 py-2 font-medium">LocalSEO</th>
                      <th className="text-left px-4 py-2 font-medium">Social</th>
                      <th className="text-left px-4 py-2 font-medium">Blogs</th>
                      <th className="text-left px-4 py-2 font-medium">Expires</th>
                      <th className="text-right px-4 py-2 font-medium"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {userData.projects.map((proj) => {
                      const blogAct = getActivation(proj.id, "blog");
                      const seoAct = getActivation(proj.id, "localseo");
                      const socialAct = getActivation(proj.id, "social");
                      const blogStatus = (blogAct?.status as string) || null;
                      const seoStatus = (seoAct?.status as string) || null;
                      const socialStatus = (socialAct?.status as string) || null;
                      const blogExpiry = (blogAct?.trial_ends_at as string) || (seoAct?.trial_ends_at as string) || (socialAct?.trial_ends_at as string) || null;
                      const blogCount = userData.blog_generation_counts[proj.id] || 0;

                      return (
                        <tr key={proj.id} className="border-b border-border last:border-0 hover:bg-muted/20">
                          <td className="px-4 py-2.5">
                            <div className="font-medium">{proj.name}</div>
                            <div className="text-xs text-muted-foreground font-mono">{proj.id.slice(0, 8)}...</div>
                          </td>
                          <td className="px-4 py-2.5">
                            {blogStatus ? (
                              <Badge className={`text-xs font-medium border-0 ${STATUS_COLORS[blogStatus] || "bg-muted"}`}>
                                {blogStatus}
                              </Badge>
                            ) : <span className="text-muted-foreground">—</span>}
                          </td>
                          <td className="px-4 py-2.5">
                            {seoStatus ? (
                              <Badge className={`text-xs font-medium border-0 ${STATUS_COLORS[seoStatus] || "bg-muted"}`}>
                                {seoStatus}
                              </Badge>
                            ) : <span className="text-muted-foreground">—</span>}
                          </td>
                          <td className="px-4 py-2.5">
                            {socialStatus ? (
                              <Badge className={`text-xs font-medium border-0 ${STATUS_COLORS[socialStatus] || "bg-muted"}`}>
                                {socialStatus}
                              </Badge>
                            ) : <span className="text-muted-foreground">—</span>}
                          </td>
                          <td className="px-4 py-2.5 text-muted-foreground">{blogCount}</td>
                          <td className="px-4 py-2.5 text-muted-foreground text-xs">
                            {blogExpiry ? fmtDate(blogExpiry) : "—"}
                          </td>
                          <td className="px-4 py-2.5 text-right">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => handleApply((blogAct || seoAct || socialAct) ? "change" : "grant", proj.id)}
                              disabled={actingProject !== null || selectedModules.length === 0}
                              className="h-7 px-3 text-xs cursor-pointer"
                            >
                              {actingProject === proj.id ? <Spinner /> : "Apply"}
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}

              {/* Action bar */}
              <div className="px-4 py-3 bg-muted/20 border-t border-border flex items-center gap-3 flex-wrap">
                {/* Module checkboxes */}
                <div className="flex items-center gap-3 mr-1">
                  {(["blog", "localseo", "social"] as const).map((mod) => (
                    <label key={mod} className="flex items-center gap-1.5 text-xs cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={selectedModules.includes(mod)}
                        onChange={() =>
                          setSelectedModules((prev) =>
                            prev.includes(mod) ? prev.filter((m) => m !== mod) : [...prev, mod]
                          )
                        }
                        className="accent-primary h-3.5 w-3.5 cursor-pointer"
                      />
                      {mod === "blog" ? "Blog" : mod === "localseo" ? "LocalSEO" : "Social"}
                    </label>
                  ))}
                </div>
                <Select value={plan} onValueChange={setPlan}>
                  <SelectTrigger className="w-[120px] h-8 text-xs cursor-pointer">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="trial" className="cursor-pointer">Trial</SelectItem>
                    <SelectItem value="pro30" className="cursor-pointer">Pro 30</SelectItem>
                    <SelectItem value="active" className="cursor-pointer">Active</SelectItem>
                  </SelectContent>
                </Select>
                <Input
                  type="number"
                  placeholder="days (auto)"
                  value={days}
                  onChange={(e) => setDays(e.target.value)}
                  className="w-[100px] h-8 text-xs"
                />
                <Button
                  size="sm"
                  onClick={() => handleApply(hasSubscriptions ? "change" : "grant")}
                  disabled={actingProject !== null || selectedModules.length === 0}
                  className="h-8 px-4 text-xs cursor-pointer"
                >
                  {actingProject === "all" ? <Spinner /> : "Apply to All"}
                </Button>
              </div>
            </div>
          )}
        </section>

        {/* ============ DEMO ACCOUNTS TABLE ============ */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
              Demo Accounts
            </h2>
            {!loadingAccounts && (
              <span className="text-xs text-muted-foreground">
                {activeCount} active / {accounts.length} total
              </span>
            )}
          </div>

          {loadingAccounts ? (
            <div className="flex justify-center py-8"><Spinner className="h-5 w-5 text-muted-foreground" /></div>
          ) : accounts.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">No demo accounts yet</p>
          ) : (
            <div className="border border-border rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/30 text-xs text-muted-foreground uppercase tracking-wider">
                    <th className="text-left px-4 py-2 font-medium">Email</th>
                    <th className="text-left px-4 py-2 font-medium">Project</th>
                    <th className="text-left px-4 py-2 font-medium">Modules</th>
                    <th className="text-left px-4 py-2 font-medium">Period</th>
                    <th className="text-left px-4 py-2 font-medium">Status</th>
                    <th className="text-right px-4 py-2 font-medium"></th>
                  </tr>
                </thead>
                <tbody>
                  {accounts.map((account) => {
                    const projectDisplay = account.projects?.map(p => p.name).join(", ")
                      || (account.project_id ? `${account.project_id.slice(0, 8)}...` : "Account-level");

                    return (
                      <tr key={account.email} className="border-b border-border last:border-0 hover:bg-muted/20">
                        <td className="px-4 py-2.5">
                          <span className="font-medium">{account.email}</span>
                        </td>
                        <td className="px-4 py-2.5 text-muted-foreground text-xs">
                          {projectDisplay}
                        </td>
                        <td className="px-4 py-2.5">
                          <div className="flex gap-1 flex-wrap">
                            {account.modules.map((m, i) => (
                              <Badge key={i} className={`text-xs font-medium border-0 ${STATUS_COLORS[m.status] || "bg-muted"}`}>
                                {m.module}: {m.status}
                              </Badge>
                            ))}
                          </div>
                        </td>
                        <td className="px-4 py-2.5 text-xs text-muted-foreground whitespace-nowrap">
                          {fmtShortDate(account.granted_at)} → {fmtShortDate(account.trial_ends_at)}
                        </td>
                        <td className="px-4 py-2.5">
                          <Badge className={`text-xs font-medium border-0 ${account.expired ? STATUS_COLORS.expired : STATUS_COLORS.active}`}>
                            {account.expired ? "Expired" : "Active"}
                          </Badge>
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setRevokeConfirm(account.email)}
                            disabled={revoking === account.email}
                            className="text-destructive hover:text-destructive hover:bg-destructive/10 h-7 px-2 text-xs cursor-pointer"
                          >
                            {revoking === account.email ? <Spinner /> : "Revoke"}
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>

      {/* Revoke confirm dialog */}
      <AlertDialog open={!!revokeConfirm} onOpenChange={(open) => !open && setRevokeConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke Demo Access</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently revoke all demo subscriptions for{" "}
              <span className="font-semibold text-foreground">{revokeConfirm}</span>.
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="cursor-pointer">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => revokeConfirm && handleRevoke(revokeConfirm)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90 cursor-pointer"
            >
              Revoke Access
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// --- App ---

export default function App() {
  const [adminKey, setAdminKey] = useState<string | null>(
    localStorage.getItem("admin_key")
  );

  const handleLogout = () => {
    localStorage.removeItem("admin_key");
    setAdminKey(null);
  };

  if (!adminKey) {
    return <LoginScreen onLogin={setAdminKey} />;
  }

  return <Dashboard adminKey={adminKey} onLogout={handleLogout} />;
}
