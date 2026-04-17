import { useState, useEffect, useCallback, useMemo } from "react";
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

// VITE_API_URL must be set explicitly. Previously fell back to the
// production URL if missing, which meant a forgotten dev .env silently
// pointed the dev app at prod — admin actions you thought were local
// would grant real subscriptions. Fail loud instead.
const API_URL = import.meta.env.VITE_API_URL;
if (!API_URL) {
  throw new Error(
    "VITE_API_URL is not set. Add it to .env.local (e.g. " +
    "VITE_API_URL=http://localhost:8000/core)."
  );
}

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
  social_posts_counts: Record<string, number>;
  localseo_posts_counts: Record<string, number>;
}

interface UsageBreakdown {
  input_tokens: number;
  output_tokens: number;
  images: number;
  cost_usd: number;
  count?: number;
}

interface UsageProject {
  project_id: string;
  project_name: string;
  account_id: string;
  email: string;
  total_input_tokens: number;
  total_output_tokens: number;
  total_images: number;
  total_cost_usd: number;
  by_service: Record<string, UsageBreakdown>;
  by_provider: Record<string, UsageBreakdown>;
  by_operation: Record<string, UsageBreakdown>;
}

interface UsageData {
  period_days: number;
  total_cost_usd: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_images: number;
  total_api_calls: number;
  total_row_count: number;
  truncated: boolean;
  projects: UsageProject[];
}

// --- Constants ---

const PLAN_LABELS: Record<string, string> = {
  trial: "Trial",
  pro30: "Pro 30",
  active: "Active",
};

const MODULE_LABELS: Record<string, string> = {
  blog: "Blog",
  localseo: "LocalSEO",
  social: "Social",
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
    // Handle empty bodies (204 No Content, or zero-length 200) so future
    // endpoints that don't return JSON don't break callers.
    if (res.status === 204) return null;
    const text = await res.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("Server returned invalid JSON");
    }
  }

  return {
    async grantDemo(email: string, plan: string, projectId?: string, modules: string[] = [], days?: number) {
      // Caller MUST pass `modules` — defaulting to all three caused users
      // to see modules in their sidebar that they never set up. Backend
      // also enforces this with a 400 if empty.
      if (!modules.length) {
        throw new Error("Pick at least one module to grant.");
      }
      const body: Record<string, unknown> = { email, plan, modules };
      if (days !== undefined) body.days = days;
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
    async changeSubscription(email: string, plan: string, days?: number, projectId?: string, modules: string[] = []) {
      if (!modules.length) {
        throw new Error("Pick at least one module to change.");
      }
      const body: Record<string, unknown> = { email, plan, modules };
      if (days !== undefined) body.days = days;
      if (projectId) body.project_id = projectId;
      const res = await fetch(`${API_URL}/api/v1/admin/change-subscription`, {
        method: "PUT",
        headers,
        body: JSON.stringify(body),
      });
      return handleResponse(res);
    },
    async removeModule(email: string, projectId: string, module: string) {
      const res = await fetch(`${API_URL}/api/v1/admin/remove-module`, {
        method: "DELETE",
        headers,
        body: JSON.stringify({ email, project_id: projectId, module }),
      });
      return handleResponse(res);
    },
    async getUsage(params: { email?: string; project_id?: string; days?: number } = {}): Promise<UsageData> {
      const searchParams = new URLSearchParams();
      if (params.email) searchParams.set("email", params.email);
      if (params.project_id) searchParams.set("project_id", params.project_id);
      if (params.days) searchParams.set("days", params.days.toString());
      const res = await fetch(`${API_URL}/api/v1/admin/usage?${searchParams}`, { headers });
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
      sessionStorage.setItem("admin_key", key);
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
  const date = new Date(d);
  if (isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function fmtShortDate(d: string) {
  const date = new Date(d);
  if (isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// Provider color classes — summary bar uses bordered variant, row badges use lighter variant
const PROVIDER_COLORS: Record<string, { summary: string; row: string }> = {
  claude:  { summary: "bg-orange-100 text-orange-700 border-orange-200", row: "bg-orange-50 text-orange-600" },
  gemini:  { summary: "bg-blue-100 text-blue-700 border-blue-200",     row: "bg-blue-50 text-blue-600" },
  bfl:     { summary: "bg-purple-100 text-purple-700 border-purple-200", row: "bg-purple-50 text-purple-600" },
  fal:     { summary: "bg-green-100 text-green-700 border-green-200",   row: "bg-green-50 text-green-600" },
  recraft: { summary: "bg-pink-100 text-pink-700 border-pink-200",     row: "bg-pink-50 text-pink-600" },
};

// --- Dashboard ---

function Dashboard({ adminKey, onLogout }: { adminKey: string; onLogout: () => void }) {
  // Memoize so child callbacks can include `client` in their deps cleanly
  // and we stop relying on eslint-disable to suppress missing-dep warnings.
  const client = useMemo(() => api(adminKey), [adminKey]);

  // User lookup state
  const [email, setEmail] = useState("");
  const [userData, setUserData] = useState<UserSubscriptionData | null>(null);
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupMsg, setLookupMsg] = useState<{ type: "success" | "error"; text: string } | null>(null);

  // Plan action state — per-module plan/days keyed by "projectId:module"
  const [modulePlans, setModulePlans] = useState<Record<string, string>>({});
  const [moduleDays, setModuleDays] = useState<Record<string, string>>({});
  const [actingOn, setActingOn] = useState<string | null>(null);
  const [applyConfirm, setApplyConfirm] = useState<{ projectId: string; module: string } | null>(null);
  const [removeConfirm, setRemoveConfirm] = useState<{ projectId: string; module: string } | null>(null);

  const getPlan = (key: string) => modulePlans[key] || "pro30";
  const getDays = (key: string) => moduleDays[key] || "";
  const setPlan = (key: string, val: string) => setModulePlans((prev) => ({ ...prev, [key]: val }));
  const setDays = (key: string, val: string) => setModuleDays((prev) => ({ ...prev, [key]: val }));

  // Demo accounts state
  const [accounts, setAccounts] = useState<DemoAccount[]>([]);
  const [loadingAccounts, setLoadingAccounts] = useState(true);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [revokeConfirm, setRevokeConfirm] = useState<string | null>(null);

  const [accountsError, setAccountsError] = useState<string | null>(null);

  // Usage tracking state
  const [usageData, setUsageData] = useState<UsageData | null>(null);
  const [usageLoading, setUsageLoading] = useState(false);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [usageDays, setUsageDays] = useState("30");
  const [usageEmail, setUsageEmail] = useState("");
  const [usageSort, setUsageSort] = useState<"cost" | "tokens" | "images">("cost");

  const loadAccounts = useCallback(async () => {
    setAccountsError(null);
    try {
      const data = await client.listAccounts();
      setAccounts(data.accounts || []);
    } catch (err) {
      setAccountsError(err instanceof Error ? err.message : "Failed to load accounts");
    } finally {
      setLoadingAccounts(false);
    }
  }, [client]);

  useEffect(() => { loadAccounts(); }, [loadAccounts]);

  const loadUsage = useCallback(async (filterEmail?: string) => {
    setUsageLoading(true);
    setUsageError(null);
    try {
      const params: { email?: string; days?: number } = { days: parseInt(usageDays) || 30 };
      if (filterEmail) params.email = filterEmail;
      const data = await client.getUsage(params);
      setUsageData(data);
    } catch (err) {
      setUsageError(err instanceof Error ? err.message : "Failed to load usage data");
    } finally {
      setUsageLoading(false);
    }
  }, [client, usageDays]);

  const handleLookup = async () => {
    if (!email.trim()) return;
    setLookupLoading(true);
    setLookupMsg(null);
    setUserData(null);
    setModulePlans({});
    setModuleDays({});
    try {
      const data = await client.getUserSubscription(email.trim());
      setUserData(data);
    } catch (err) {
      setLookupMsg({ type: "error", text: err instanceof Error ? err.message : "User not found" });
    } finally {
      setLookupLoading(false);
    }
  };

  // Apply plan to a single module of a project
  const handleApplyModule = async (projectId: string, module: string) => {
    if (!email.trim()) return;
    const key = `${projectId}:${module}`;
    const plan = getPlan(key);
    const daysVal = getDays(key);
    setActingOn(key);
    setLookupMsg(null);
    try {
      const d = daysVal ? parseInt(daysVal) : undefined;
      const act = getActivation(projectId, module);
      if (act) {
        await client.changeSubscription(email.trim(), plan, d, projectId, [module]);
      } else {
        // Don't pass days if empty — let backend use plan defaults (trial=3, pro30=30, active=365)
        await client.grantDemo(email.trim(), plan, projectId, [module], d);
      }
      setLookupMsg({ type: "success", text: `${PLAN_LABELS[plan]} applied to ${MODULE_LABELS[module]}` });
      const data = await client.getUserSubscription(email.trim());
      setUserData(data);
      loadAccounts();
    } catch (err) {
      setLookupMsg({ type: "error", text: err instanceof Error ? err.message : "Failed" });
    } finally {
      setActingOn(null);
    }
  };

  // Remove a single module activation from a project
  const handleRemoveModule = async (projectId: string, module: string) => {
    if (!email.trim()) return;
    const key = `${projectId}:${module}`;
    setActingOn(key);
    setLookupMsg(null);
    try {
      await client.removeModule(email.trim(), projectId, module);
      setLookupMsg({ type: "success", text: `${MODULE_LABELS[module]} removed from project` });
      const data = await client.getUserSubscription(email.trim());
      setUserData(data);
      loadAccounts();
    } catch (err) {
      setLookupMsg({ type: "error", text: err instanceof Error ? err.message : "Failed to remove module" });
    } finally {
      setActingOn(null);
    }
  };

  const handleRevoke = async (accountEmail: string) => {
    setRevokeConfirm(null);
    setRevoking(accountEmail);
    try {
      await client.revokeDemo(accountEmail);
      loadAccounts();
    } catch (err) {
      setAccountsError(err instanceof Error ? err.message : "Failed to revoke access");
    } finally {
      setRevoking(null);
    }
  };

  // Helper: get activation for a project+module (try project-level first, fall back to account-level)
  const getActivation = (projectId: string, module: string) => {
    if (!userData) return null;
    // Try project-level match first
    const projectLevel = userData.module_activations.find(
      (a: Record<string, unknown>) => a.project_id === projectId && a.module_code === module
    );
    if (projectLevel) return projectLevel as Record<string, unknown>;
    // Fall back to account-level (project_id is null)
    return userData.module_activations.find(
      (a: Record<string, unknown>) => a.project_id === null && a.module_code === module
    ) as Record<string, unknown> | undefined;
  };

  // Helper: get subscription for a project+module (for period end date display)
  const getSubscription = (projectId: string, module: string) => {
    if (!userData) return null;
    return userData.subscriptions.find(
      (s: Record<string, unknown>) => s.project_id === projectId && s.module_name === module
    ) as Record<string, unknown> | undefined;
  };

  const sortedUsageProjects = useMemo(() => {
    if (!usageData) return [];
    return [...usageData.projects].sort((a, b) =>
      usageSort === "cost" ? b.total_cost_usd - a.total_cost_usd :
      usageSort === "tokens" ? (b.total_input_tokens + b.total_output_tokens) - (a.total_input_tokens + a.total_output_tokens) :
      b.total_images - a.total_images
    );
  }, [usageData, usageSort]);

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

              {/* Projects with per-module rows */}
              {userData.projects.map((proj) => {
                return (
                  <div key={proj.id} className="border-b border-border last:border-0">
                    {/* Project header */}
                    <div className="px-4 py-2 bg-muted/10 border-b border-border">
                      <span className="text-sm font-medium">{proj.name}</span>
                      <span className="text-xs text-muted-foreground ml-2 font-mono">{proj.id.slice(0, 8)}...</span>
                    </div>

                    {/* Module rows */}
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-border bg-muted/5 text-xs text-muted-foreground uppercase tracking-wider">
                          <th className="text-left px-4 py-1.5 font-medium">Module</th>
                          <th className="text-left px-4 py-1.5 font-medium">Status</th>
                          <th className="text-left px-4 py-1.5 font-medium">Generated</th>
                          <th className="text-left px-4 py-1.5 font-medium">Expires</th>
                          <th className="text-left px-4 py-1.5 font-medium">Set Plan</th>
                          <th className="text-left px-4 py-1.5 font-medium">Days</th>
                          <th className="text-right px-4 py-1.5 font-medium"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {(["blog", "localseo", "social"] as const).map((mod) => {
                          const act = getActivation(proj.id, mod);
                          const sub = getSubscription(proj.id, mod);
                          const modStatus = (act?.status as string) || null;
                          const actExpiry = (act?.trial_ends_at as string) || null;
                          // Show subscription period end (when the billing cycle ends)
                          // Falls back to activation trial_ends_at for display
                          const subPeriodEnd = (sub?.current_period_end as string) || null;
                          const displayExpiry = subPeriodEnd || actExpiry;
                          const isAccountLevel = act ? act.project_id === null : false;
                          const key = `${proj.id}:${mod}`;
                          const isActing = actingOn === key;
                          const modCount = mod === "blog"
                            ? userData.blog_generation_counts[proj.id] || 0
                            : mod === "social"
                            ? (userData.social_posts_counts?.[proj.id] || 0)
                            : (userData.localseo_posts_counts?.[proj.id] || 0);

                          // Expired = activation trial_ends_at is in the past (NOT subscription period end).
                          // "active" plans have trial_ends_at=null → never expired.
                          const isExpired = actExpiry ? new Date(actExpiry) < new Date() : false;
                          const displayStatus = modStatus && isExpired ? "expired" : modStatus;

                          return (
                            <tr key={mod} className="border-b border-border last:border-0 hover:bg-muted/20">
                              <td className="px-4 py-2 font-medium">{MODULE_LABELS[mod]}</td>
                              <td className="px-4 py-2">
                                {modStatus ? (
                                  <span className="inline-flex items-center gap-1">
                                    <Badge className={`text-xs font-medium border-0 ${STATUS_COLORS[displayStatus || ""] || "bg-muted"}`}>
                                      {isExpired ? `${modStatus} (expired)` : modStatus}
                                    </Badge>
                                    {isAccountLevel && <span className="text-[10px] text-muted-foreground" title="Inherited from account-level activation">acct</span>}
                                  </span>
                                ) : <span className="text-muted-foreground">—</span>}
                              </td>
                              <td className="px-4 py-2 text-muted-foreground">{modCount}</td>
                              <td className={`px-4 py-2 text-xs ${isExpired ? "text-red-500 font-medium" : "text-muted-foreground"}`}>
                                {displayExpiry ? fmtDate(displayExpiry) : "—"}
                              </td>
                              <td className="px-4 py-2">
                                <Select value={getPlan(key)} onValueChange={(v) => setPlan(key, v)}>
                                  <SelectTrigger className="w-[130px] h-7 text-xs cursor-pointer">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="trial" className="cursor-pointer">
                                      <div>Trial <span className="text-muted-foreground">(3d, 3 blogs)</span></div>
                                    </SelectItem>
                                    <SelectItem value="pro30" className="cursor-pointer">
                                      <div>Pro 30 <span className="text-muted-foreground">(30d, 30 blogs)</span></div>
                                    </SelectItem>
                                    <SelectItem value="active" className="cursor-pointer">
                                      <div>Active <span className="text-muted-foreground">(365d, unlimited)</span></div>
                                    </SelectItem>
                                  </SelectContent>
                                </Select>
                              </td>
                              <td className="px-4 py-2">
                                <Input
                                  type="number"
                                  placeholder="auto"
                                  value={getDays(key)}
                                  onChange={(e) => setDays(key, e.target.value)}
                                  className="w-[70px] h-7 text-xs"
                                />
                              </td>
                              <td className="px-4 py-2 text-right">
                                <div className="flex items-center justify-end gap-1">
                                  <Button
                                    size="sm"
                                    onClick={() => setApplyConfirm({ projectId: proj.id, module: mod })}
                                    disabled={actingOn !== null}
                                    className="h-7 px-3 text-xs cursor-pointer"
                                  >
                                    {isActing ? <Spinner /> : "Apply"}
                                  </Button>
                                  {modStatus && (
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      onClick={() => setRemoveConfirm({ projectId: proj.id, module: mod })}
                                      disabled={actingOn !== null}
                                      className="h-7 px-2 text-xs text-destructive hover:text-destructive hover:bg-destructive/10 cursor-pointer"
                                    >
                                      {isActing ? <Spinner /> : "×"}
                                    </Button>
                                  )}
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* ============ API USAGE TRACKING ============ */}
        <section>
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">API Usage</h2>

          <div className="flex gap-2 mb-3 items-end">
            <Input
              type="email"
              placeholder="Filter by email (optional)"
              value={usageEmail}
              onChange={(e) => setUsageEmail(e.target.value)}
              className="max-w-[240px] h-9"
            />
            <Select value={usageDays} onValueChange={setUsageDays}>
              <SelectTrigger className="w-[120px] h-9 cursor-pointer">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="7" className="cursor-pointer">Last 7 days</SelectItem>
                <SelectItem value="30" className="cursor-pointer">Last 30 days</SelectItem>
                <SelectItem value="90" className="cursor-pointer">Last 90 days</SelectItem>
                <SelectItem value="365" className="cursor-pointer">Last year</SelectItem>
              </SelectContent>
            </Select>
            <Button onClick={() => loadUsage(usageEmail.trim() || undefined)} disabled={usageLoading} className="h-9 px-4 cursor-pointer">
              {usageLoading ? <Spinner /> : "Load Usage"}
            </Button>
          </div>

          {usageError && <p className="text-sm text-destructive mb-3">{usageError}</p>}

          {usageData && (
            <div className="space-y-4">
              {/* Summary cards */}
              <div className="grid grid-cols-4 gap-3">
                <div className="border border-border rounded-lg p-3 bg-card">
                  <p className="text-xs text-muted-foreground uppercase tracking-wider">Total Cost</p>
                  <p className="text-xl font-semibold mt-1">${usageData.total_cost_usd.toFixed(2)}</p>
                </div>
                <div className="border border-border rounded-lg p-3 bg-card">
                  <p className="text-xs text-muted-foreground uppercase tracking-wider">API Calls</p>
                  <p className="text-xl font-semibold mt-1">{usageData.total_api_calls.toLocaleString()}</p>
                </div>
                <div className="border border-border rounded-lg p-3 bg-card">
                  <p className="text-xs text-muted-foreground uppercase tracking-wider">Total Tokens</p>
                  <p className="text-xl font-semibold mt-1">{(usageData.total_input_tokens + usageData.total_output_tokens).toLocaleString()}</p>
                </div>
                <div className="border border-border rounded-lg p-3 bg-card">
                  <p className="text-xs text-muted-foreground uppercase tracking-wider">Images Generated</p>
                  <p className="text-xl font-semibold mt-1">{usageData.total_images.toLocaleString()}</p>
                </div>
              </div>

              {/* Provider cost breakdown */}
              {(() => {
                const providerTotals: Record<string, { cost: number; images: number }> = {};
                for (const proj of usageData.projects) {
                  for (const [prov, data] of Object.entries(proj.by_provider)) {
                    if (!providerTotals[prov]) providerTotals[prov] = { cost: 0, images: 0 };
                    providerTotals[prov].cost += data.cost_usd;
                    providerTotals[prov].images += data.images;
                  }
                }
                const providers = Object.entries(providerTotals).sort((a, b) => b[1].cost - a[1].cost);
                if (providers.length === 0) return null;
                return (
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs text-muted-foreground uppercase tracking-wider">By Provider:</span>
                    {providers.map(([prov, data]) => (
                      <span
                        key={prov}
                        className={`text-xs px-2 py-1 rounded border ${PROVIDER_COLORS[prov]?.summary || "bg-muted text-muted-foreground border-border"}`}
                      >
                        {prov}: ${data.cost.toFixed(2)} · {data.images} img
                      </span>
                    ))}
                  </div>
                );
              })()}

              {usageData.truncated && (
                <p className="text-sm text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                  Showing 5,000 of {usageData.total_row_count.toLocaleString()} records. Totals below are incomplete — narrow the date range or filter by email for accurate numbers.
                </p>
              )}

              {/* Sort controls */}
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">Sort by:</span>
                {(["cost", "tokens", "images"] as const).map((s) => (
                  <button
                    key={s}
                    onClick={() => setUsageSort(s)}
                    className={`text-xs px-2 py-1 rounded cursor-pointer ${usageSort === s ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-muted/80"}`}
                  >
                    {s === "cost" ? "Cost" : s === "tokens" ? "Tokens" : "Images"}
                  </button>
                ))}
                <span className="text-xs text-muted-foreground ml-auto">
                  {usageData.projects.length} project{usageData.projects.length !== 1 ? "s" : ""} in last {usageData.period_days}d
                </span>
              </div>

              {/* Per-project table */}
              {usageData.projects.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-6">No usage data for this period</p>
              ) : (
                <div className="border border-border rounded-lg overflow-hidden">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border bg-muted/30 text-xs text-muted-foreground uppercase tracking-wider">
                        <th className="text-left px-4 py-2 font-medium">Project</th>
                        <th className="text-left px-4 py-2 font-medium">Email</th>
                        <th className="text-right px-4 py-2 font-medium">Input Tokens</th>
                        <th className="text-right px-4 py-2 font-medium">Output Tokens</th>
                        <th className="text-right px-4 py-2 font-medium">Images</th>
                        <th className="text-right px-4 py-2 font-medium">Cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedUsageProjects.map((proj) => (
                        <tr key={proj.project_id} className="border-b border-border last:border-0 hover:bg-muted/20 group">
                          <td className="px-4 py-2.5">
                            <div>
                              <span className="font-medium">{proj.project_name}</span>
                              <span className="text-xs text-muted-foreground ml-1.5 font-mono">{proj.project_id.slice(0, 8)}</span>
                            </div>
                            <div className="flex gap-1 mt-1 flex-wrap">
                              {Object.entries(proj.by_service).map(([svc, data]) => (
                                <span key={svc} className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                                  {svc}: ${data.cost_usd.toFixed(2)}
                                </span>
                              ))}
                              <span className="text-[10px] text-muted-foreground/40 mx-0.5">|</span>
                              {Object.entries(proj.by_provider).map(([prov, data]) => (
                                <span key={prov} className={`text-[10px] px-1.5 py-0.5 rounded ${PROVIDER_COLORS[prov]?.row || "bg-muted text-muted-foreground"}`}>
                                  {prov}: ${data.cost_usd.toFixed(2)}{data.images > 0 ? ` · ${data.images}img` : ""}
                                </span>
                              ))}
                            </div>
                          </td>
                          <td className="px-4 py-2.5 text-muted-foreground text-xs">{proj.email}</td>
                          <td className="px-4 py-2.5 text-right font-mono text-xs">{proj.total_input_tokens.toLocaleString()}</td>
                          <td className="px-4 py-2.5 text-right font-mono text-xs">{proj.total_output_tokens.toLocaleString()}</td>
                          <td className="px-4 py-2.5 text-right font-mono text-xs">{proj.total_images}</td>
                          <td className="px-4 py-2.5 text-right font-semibold">${proj.total_cost_usd.toFixed(2)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t border-border bg-muted/10 font-semibold text-xs">
                        <td className="px-4 py-2" colSpan={2}>Total</td>
                        <td className="px-4 py-2 text-right font-mono">{usageData.total_input_tokens.toLocaleString()}</td>
                        <td className="px-4 py-2 text-right font-mono">{usageData.total_output_tokens.toLocaleString()}</td>
                        <td className="px-4 py-2 text-right font-mono">{usageData.total_images}</td>
                        <td className="px-4 py-2 text-right">${usageData.total_cost_usd.toFixed(2)}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
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

          {accountsError && <p className="text-sm text-destructive mb-3">{accountsError}</p>}

          {loadingAccounts ? (
            <div className="flex justify-center py-8"><Spinner className="h-5 w-5 text-muted-foreground" /></div>
          ) : accounts.length === 0 && !accountsError ? (
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

      {/* Apply confirm dialog */}
      <AlertDialog open={!!applyConfirm} onOpenChange={(open) => !open && setApplyConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Apply Plan Change</AlertDialogTitle>
            <AlertDialogDescription>
              {applyConfirm && (() => {
                const key = `${applyConfirm.projectId}:${applyConfirm.module}`;
                const planLabel = PLAN_LABELS[getPlan(key)] || getPlan(key);
                const daysVal = getDays(key);
                return (
                  <>
                    Set <span className="font-semibold text-foreground">{MODULE_LABELS[applyConfirm.module]}</span> to{" "}
                    <span className="font-semibold text-foreground">{planLabel}</span>
                    {daysVal ? ` for ${daysVal} days` : " (default days)"}
                    {" "}for <span className="font-semibold text-foreground">{userData?.email}</span>?
                  </>
                );
              })()}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="cursor-pointer">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (applyConfirm) {
                  handleApplyModule(applyConfirm.projectId, applyConfirm.module);
                  setApplyConfirm(null);
                }
              }}
              className="cursor-pointer"
            >
              Confirm
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Remove module confirm dialog */}
      <AlertDialog open={!!removeConfirm} onOpenChange={(open) => !open && setRemoveConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove Module</AlertDialogTitle>
            <AlertDialogDescription>
              {removeConfirm && (
                <>
                  This will remove{" "}
                  <span className="font-semibold text-foreground">{MODULE_LABELS[removeConfirm.module]}</span>{" "}
                  from this project for{" "}
                  <span className="font-semibold text-foreground">{userData?.email}</span>.
                  {" "}The module's subscription and activation will be deleted. The user will no longer see this module in their sidebar.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="cursor-pointer">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (removeConfirm) {
                  handleRemoveModule(removeConfirm.projectId, removeConfirm.module);
                  setRemoveConfirm(null);
                }
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90 cursor-pointer"
            >
              Remove Module
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
    sessionStorage.getItem("admin_key")
  );

  const handleLogout = () => {
    sessionStorage.removeItem("admin_key");
    setAdminKey(null);
  };

  if (!adminKey) {
    return <LoginScreen onLogin={setAdminKey} />;
  }

  return <Dashboard adminKey={adminKey} onLogout={handleLogout} />;
}
