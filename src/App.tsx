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

interface BlogQuotaData {
  email: string;
  account_id: string;
  plan_code: string | null;
  plan_display_name: string | null;
  plan_billing_cycle: string | null;   // 'monthly' / '6_month' / 'yearly' / 'trial'
  plan_monthly_quota: number | null;   // per-cycle limit from plan_features
  plan_reset_interval: string | null;  // 'monthly' / 'subscription_period' / etc.
  plan_duration_days: number | null;
  legacy_status: string | null;        // 'trial' | 'pro30' | 'active' | etc.
  custom_blog_quota: number | null;    // override (per-cycle), null = no override
  override_reason: string | null;
  effective_quota: number | null;      // per-cycle cap (what enforcement counts)
  // Quota cycle dates (what enforcement uses + customer indicator shows)
  period_start: string | null;
  period_end: string | null;
  // Billing dates (when Dodo charges next) — separate from quota cycle
  billing_period_start: string | null;
  billing_period_end: string | null;
  used_this_period: number;
}

// Subscription plan as defined in core.subscription_plans (migration 058).
// Fetched dynamically via GET /api/v1/admin/plans so the dashboard reflects
// the DB without needing a frontend deploy when admin adds new tiers.
interface Plan {
  code: string;
  display_name: string;
  module_code: string;
  billing_cycle: string;                 // 'monthly' / '6_month' / 'yearly' / 'trial'
  duration_days: number;
  monthly_price_usd: number | null;
  annual_price_usd: number | null;
  bundle_code: string | null;
  monthly_blog_quota: number | null;     // per-month cadence from plan_features
  blogs_per_period: number | null;       // cadence × months_in_period
  is_active: boolean;
}

interface ChangePlanResponse {
  success: boolean;
  email: string;
  account_id: string;
  plan_code: string;
  affected_activations: number;
  affected_project_ids: string[];
  message: string;
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

interface LeaderboardRow {
  rank: number;
  account_id: string;
  account_name: string;
  account_slug: string;
  owner_email: string;
  total_cost_usd: number;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  images: number;
  by_service: Record<string, number>;
  by_provider: Record<string, number>;
}

interface LeaderboardData {
  date: string;
  limit: number;
  platform_total_cost_usd: number;
  platform_total_calls: number;
  active_accounts: number;
  truncated: boolean;
  leaderboard: LeaderboardRow[];
}

interface FailedJobRow {
  blog_id: string;
  project_id: string;
  title: string | null;
  // generation_failed / publish_failed = terminal failed states
  // generating / text_ready_images_pending = stuck (>45min, reaper-eligible)
  status:
    | "generation_failed"
    | "publish_failed"
    | "generating"
    | "text_ready_images_pending";
  scheduled_date: string | null;
  gen_attempts: number | null;
  gen_last_error: string | null;
  publish_attempts: number | null;
  publish_last_error: string | null;
  updated_at: string | null;
}

interface FailedJobsData {
  rows: FailedJobRow[];
  total_count: number;
  limit: number;
  offset: number;
}

interface RetryJobResponse {
  success: boolean;
  blog_id: string;
  from_status: string;
  to_status: string;
  message: string;
}

// --- Constants ---

// PLAN_LABELS is now mostly historical — actual plan names come from the
// backend (GET /api/v1/admin/plans, sourced from core.subscription_plans
// added in migration 048). Kept here only for backwards-compat display
// when an old subscription row still references a legacy status string
// (trial / pro30 / active) and the new plan_code-based mapping isn't
// available yet.
const PLAN_LABELS: Record<string, string> = {
  trial: "Trial",
  pro30: "Pro 30",
  active: "Active",
  // New plan codes (mirrored here so legacy lookups don't return undefined
  // when the dashboard renders them before the dynamic plans list loads).
  trial_3day: "Trial (3 days)",
  monthly_30: "Standard 30 — Monthly",
  monthly_50: "Growth 50 — Monthly",
  monthly_80: "Premium 80 — Monthly",
  yearly_30: "Standard 30 — Annual",
  yearly_50: "Growth 50 — Annual",
  yearly_80: "Premium 80 — Annual",
};

const MODULE_LABELS: Record<string, string> = {
  blog: "Blog",
  localseo: "LocalSEO",
  social: "Social",
};

const STATUS_COLORS: Record<string, string> = {
  // Legacy status values
  trial: "bg-amber-100 text-amber-700",
  pro30: "bg-blue-100 text-blue-700",
  active: "bg-emerald-100 text-emerald-700",
  trialing: "bg-amber-100 text-amber-700",
  expired: "bg-red-100 text-red-600",
  // New plan codes from migration 048 — colored by tier capacity:
  // trial = amber (low), monthly_* = blue (mid), yearly_* = emerald (high commitment).
  trial_3day:  "bg-amber-100 text-amber-700",
  monthly_30:  "bg-blue-100 text-blue-700",
  monthly_50:  "bg-blue-100 text-blue-700",
  monthly_80:  "bg-blue-100 text-blue-700",
  yearly_30:   "bg-emerald-100 text-emerald-700",
  yearly_50:   "bg-emerald-100 text-emerald-700",
  yearly_80:   "bg-emerald-100 text-emerald-700",
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
    async getLeaderboard(params: { date?: string; limit?: number } = {}): Promise<LeaderboardData> {
      const searchParams = new URLSearchParams();
      if (params.date) searchParams.set("date", params.date);
      if (params.limit) searchParams.set("limit", params.limit.toString());
      const res = await fetch(`${API_URL}/api/v1/admin/usage/leaderboard?${searchParams}`, { headers });
      return handleResponse(res);
    },
    async listFailedJobs(params: {
      status_filter?: "generation_failed" | "publish_failed" | "stuck_generating";
      limit?: number;
      offset?: number;
    } = {}): Promise<FailedJobsData> {
      const searchParams = new URLSearchParams();
      if (params.status_filter) searchParams.set("status_filter", params.status_filter);
      if (params.limit) searchParams.set("limit", params.limit.toString());
      if (params.offset) searchParams.set("offset", params.offset.toString());
      const qs = searchParams.toString();
      const url = `${API_URL}/api/v1/admin/failed-jobs${qs ? "?" + qs : ""}`;
      const res = await fetch(url, { headers });
      return handleResponse(res);
    },
    async retryFailedJob(blogId: string): Promise<RetryJobResponse> {
      const res = await fetch(`${API_URL}/api/v1/admin/jobs/${encodeURIComponent(blogId)}/retry`, {
        method: "POST",
        headers,
      });
      return handleResponse(res);
    },
    async getBlogQuota(email: string): Promise<BlogQuotaData> {
      const res = await fetch(
        `${API_URL}/api/v1/admin/get-blog-quota?email=${encodeURIComponent(email)}`,
        { headers }
      );
      return handleResponse(res);
    },
    async setBlogQuota(email: string, customBlogQuota: number | null, reason?: string) {
      const res = await fetch(`${API_URL}/api/v1/admin/set-blog-quota`, {
        method: "PUT",
        headers,
        body: JSON.stringify({
          email,
          custom_blog_quota: customBlogQuota,
          reason: reason || null,
        }),
      });
      return handleResponse(res);
    },
    async listPlans(moduleCode: string = "blog"): Promise<{ plans: Plan[] }> {
      const res = await fetch(
        `${API_URL}/api/v1/admin/plans?module_code=${encodeURIComponent(moduleCode)}`,
        { headers }
      );
      return handleResponse(res);
    },
    async changePlan(
      email: string,
      planCode: string,
      resetPeriod: boolean,
      reason?: string,
      projectId?: string,
    ): Promise<ChangePlanResponse> {
      // reset_period=True bumps activated_at and resets the period counter.
      // project_id optional: omitted = all account projects, set = just that one.
      const body: Record<string, unknown> = {
        email,
        plan_code: planCode,
        reset_period: resetPeriod,
        reason: reason || null,
      };
      if (projectId) {
        body.project_id = projectId;
      }
      const res = await fetch(`${API_URL}/api/v1/admin/change-plan`, {
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

// Format a date-only string (YYYY-MM-DD) as a UTC date. Distinct from
// fmtDate which assumes its input is a full ISO timestamp and renders
// in the user's local timezone. Use this for backend fields that carry
// only a calendar date — e.g. leaderboardData.date — so an admin in
// US-Pacific doesn't see "May 10" when they picked May 11 UTC.
function fmtUtcDate(d: string) {
  const date = new Date(d);
  if (isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
  });
}

// Provider color classes — summary bar uses bordered variant, row badges use lighter variant
const PROVIDER_COLORS: Record<string, { summary: string; row: string }> = {
  claude:  { summary: "bg-orange-100 text-orange-700 border-orange-200", row: "bg-orange-50 text-orange-600" },
  gemini:  { summary: "bg-blue-100 text-blue-700 border-blue-200",     row: "bg-blue-50 text-blue-600" },
  // OpenAI (gpt-image-2, gpt-image-1.5) — social module's primary image provider post-migration.
  openai:  { summary: "bg-emerald-100 text-emerald-700 border-emerald-200", row: "bg-emerald-50 text-emerald-600" },
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

  // Subscription plans loaded from the backend (post-migration-048 source
  // of truth in core.subscription_plans). Populates plan dropdowns
  // dynamically so admin can add new tiers without a frontend deploy.
  const [plans, setPlans] = useState<Plan[]>([]);

  // Blog quota state — separate from generic user lookup so the admin can
  // adjust quota for one user while keeping a different user open in the
  // main subscription panel.
  const [quotaEmail, setQuotaEmail] = useState("");
  const [quotaData, setQuotaData] = useState<BlogQuotaData | null>(null);
  const [quotaCustomValue, setQuotaCustomValue] = useState("");
  const [quotaReason, setQuotaReason] = useState("");
  const [quotaLoading, setQuotaLoading] = useState(false);
  const [quotaSaving, setQuotaSaving] = useState(false);
  const [quotaMsg, setQuotaMsg] = useState<{ type: "success" | "error"; text: string } | null>(null);

  // Plan action state — per-module plan/days keyed by "projectId:module"
  const [modulePlans, setModulePlans] = useState<Record<string, string>>({});
  const [moduleDays, setModuleDays] = useState<Record<string, string>>({});
  const [actingOn, setActingOn] = useState<string | null>(null);
  const [applyConfirm, setApplyConfirm] = useState<{ projectId: string; module: string } | null>(null);
  const [removeConfirm, setRemoveConfirm] = useState<{ projectId: string; module: string } | null>(null);

  // Change-plan (advanced) dialog state — uses the new /api/v1/admin/change-plan
  // endpoint. Period-based model: reset_period bumps activated_at + the
  // subscription window so the new plan starts with a clean quota counter.
  // give_fresh_quota was removed — there's no monthly cap to refresh.
  // project_id is optional: blank = apply to every project the account has
  // on the blog module; populated = scope to that single project.
  const [changePlanOpen, setChangePlanOpen] = useState(false);
  const [changePlanCode, setChangePlanCode] = useState("monthly_30");
  const [changePlanResetPeriod, setChangePlanResetPeriod] = useState(true);
  const [changePlanReason, setChangePlanReason] = useState("");
  const [changePlanProjectId, setChangePlanProjectId] = useState("");
  const [changePlanLoading, setChangePlanLoading] = useState(false);
  const [changePlanResult, setChangePlanResult] = useState<ChangePlanResponse | null>(null);
  const [changePlanError, setChangePlanError] = useState<string | null>(null);

  // Default selection: prefer the new plan_code "monthly_30" (post-migration-048
  // canonical), fall back to legacy "pro30" if the dynamic plans list isn't
  // loaded yet — backend's _resolve_plan accepts both via LEGACY_PLAN_ALIAS.
  const getPlan = (key: string) =>
    modulePlans[key] || (plans.length > 0 ? "monthly_30" : "pro30");
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

  // Daily leaderboard state — date-pinned, top-N accounts across all modules.
  // Default date = today (UTC) so the page shows the current spend leaderboard
  // on first paint without the admin needing to pick anything.
  const todayUTC = new Date().toISOString().slice(0, 10);
  const [leaderboardDate, setLeaderboardDate] = useState(todayUTC);
  const [leaderboardLimit, setLeaderboardLimit] = useState("10");
  const [leaderboardData, setLeaderboardData] = useState<LeaderboardData | null>(null);
  const [leaderboardLoading, setLeaderboardLoading] = useState(false);
  const [leaderboardError, setLeaderboardError] = useState<string | null>(null);

  // Failed jobs (cron-pipeline triage)
  const [failedJobsData, setFailedJobsData] = useState<FailedJobsData | null>(null);
  const [failedJobsLoading, setFailedJobsLoading] = useState(false);
  const [failedJobsError, setFailedJobsError] = useState<string | null>(null);
  const [failedJobsFilter, setFailedJobsFilter] = useState<
    "" | "generation_failed" | "publish_failed" | "stuck_generating"
  >("");
  const [retryingJobId, setRetryingJobId] = useState<string | null>(null);
  const [failedJobsMsg, setFailedJobsMsg] = useState<{ type: "success" | "error"; text: string } | null>(null);

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

  // Load plan list once on dashboard mount. Failing silently is acceptable —
  // the dropdown falls back to legacy hardcoded options if `plans` is empty
  // (older backends without /admin/plans return 404).
  useEffect(() => {
    let cancelled = false;
    client.listPlans("blog")
      .then((d) => { if (!cancelled) setPlans(d.plans || []); })
      .catch((err) => console.warn("[admin] failed to load plans:", err));
    return () => { cancelled = true; };
  }, [client]);

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

  const loadLeaderboard = useCallback(async () => {
    setLeaderboardLoading(true);
    setLeaderboardError(null);
    try {
      const data = await client.getLeaderboard({
        date: leaderboardDate || undefined,
        limit: parseInt(leaderboardLimit) || 10,
      });
      setLeaderboardData(data);
    } catch (err) {
      setLeaderboardError(err instanceof Error ? err.message : "Failed to load leaderboard");
    } finally {
      setLeaderboardLoading(false);
    }
  }, [client, leaderboardDate, leaderboardLimit]);

  const loadFailedJobs = useCallback(async () => {
    setFailedJobsLoading(true);
    setFailedJobsError(null);
    try {
      const data = await client.listFailedJobs({
        status_filter: failedJobsFilter || undefined,
        limit: 50,
        offset: 0,
      });
      setFailedJobsData(data);
    } catch (err) {
      setFailedJobsError(err instanceof Error ? err.message : "Failed to load failed jobs");
    } finally {
      setFailedJobsLoading(false);
    }
  }, [client, failedJobsFilter]);

  // Auto-load failed jobs on mount so ops see fresh status without
  // having to click. Re-runs when the status filter changes.
  // Declared AFTER loadFailedJobs so TypeScript's
  // "used-before-declaration" check passes — useCallback captures a
  // fresh closure each render and the dep array correctly tracks it.
  useEffect(() => { loadFailedJobs(); }, [loadFailedJobs]);

  const handleRetryFailedJob = async (blogId: string) => {
    setRetryingJobId(blogId);
    setFailedJobsMsg(null);
    try {
      const result = await client.retryFailedJob(blogId);
      setFailedJobsMsg({
        type: "success",
        text: `${result.message} (${result.from_status} → ${result.to_status})`,
      });
      // Refresh the list so the retried row drops out.
      await loadFailedJobs();
    } catch (err) {
      setFailedJobsMsg({
        type: "error",
        text: err instanceof Error ? err.message : "Retry failed",
      });
    } finally {
      setRetryingJobId(null);
    }
  };

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

  // ---- Blog quota handlers ---------------------------------------------
  const handleQuotaLookup = async () => {
    if (!quotaEmail.trim()) return;
    setQuotaLoading(true);
    setQuotaMsg(null);
    setQuotaData(null);
    setQuotaCustomValue("");
    try {
      const data = await client.getBlogQuota(quotaEmail.trim());
      setQuotaData(data);
      setQuotaCustomValue(
        data.custom_blog_quota !== null ? String(data.custom_blog_quota) : ""
      );
    } catch (err) {
      setQuotaMsg({
        type: "error",
        text: err instanceof Error ? err.message : "User not found",
      });
    } finally {
      setQuotaLoading(false);
    }
  };

  const handleQuotaSet = async (value: number | null) => {
    if (!quotaEmail.trim()) return;
    setQuotaSaving(true);
    setQuotaMsg(null);
    try {
      const result = await client.setBlogQuota(
        quotaEmail.trim(),
        value,
        quotaReason.trim() || undefined
      );
      setQuotaMsg({ type: "success", text: result.message });
      setQuotaReason("");
      // Refresh the displayed state with the new value
      const fresh = await client.getBlogQuota(quotaEmail.trim());
      setQuotaData(fresh);
      setQuotaCustomValue(
        fresh.custom_blog_quota !== null ? String(fresh.custom_blog_quota) : ""
      );
    } catch (err) {
      setQuotaMsg({
        type: "error",
        text: err instanceof Error ? err.message : "Failed to update quota",
      });
    } finally {
      setQuotaSaving(false);
    }
  };

  const handleQuotaCustomSubmit = async () => {
    const trimmed = quotaCustomValue.trim();
    if (!trimmed) return;
    const n = parseInt(trimmed, 10);
    if (isNaN(n) || n < 0 || !Number.isFinite(n)) {
      setQuotaMsg({
        type: "error",
        text: "Custom quota must be a non-negative integer.",
      });
      return;
    }
    if (n > 10000) {
      // 10k is plenty of room above the largest legitimate enterprise plan;
      // anything larger is almost certainly a typo (300 → 3000 → 30000).
      // No "unlimited" sentinel — every integer is a hard cap, so a typo
      // 30000 silently grants 30000 blogs and over-spends Claude credits.
      setQuotaMsg({
        type: "error",
        text: `Custom quota of ${n} looks unusually high (likely a typo). Re-enter the intended cap, or contact engineering if you genuinely need more than 10,000.`,
      });
      return;
    }
    await handleQuotaSet(n);
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

  // Change-plan (advanced) — calls the new endpoint with reset_period +
  // Period-based model: reset_period=True bumps activated_at + the
  // subscription period_start/period_end so the new plan starts with a
  // clean quota counter. The backend refuses reset_period=False when
  // the new plan's duration_days differs from the existing window
  // (e.g., monthly→yearly) — that 400 surfaces as changePlanError so
  // the admin can re-submit with reset_period=True.
  //
  // project_id is optional. Blank = apply to all of the account's blog
  // projects (legacy default). Populated = scope to a single project,
  // useful when one project of a multi-project account needs an
  // independent plan.
  const handleChangePlanSubmit = async () => {
    if (!email.trim() || !userData) return;
    setChangePlanLoading(true);
    setChangePlanError(null);
    setChangePlanResult(null);
    try {
      const result = await client.changePlan(
        email.trim(),
        changePlanCode,
        changePlanResetPeriod,
        changePlanReason.trim() || undefined,
        changePlanProjectId.trim() || undefined,
      );
      setChangePlanResult(result);
      setChangePlanReason("");
      setChangePlanProjectId("");
      // Refresh the user-detail view so the new plan_code shows up
      const data = await client.getUserSubscription(email.trim());
      setUserData(data);
      loadAccounts();
    } catch (err) {
      setChangePlanError(err instanceof Error ? err.message : "Failed to change plan");
    } finally {
      setChangePlanLoading(false);
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

  // Sum failed Gemini API attempts across all projects. Each `*_failed`
  // operation row corresponds to one billed-but-unsuccessful Google API call.
  const failureSummary = useMemo(() => {
    if (!usageData) return { count: 0, cost: 0 };
    let count = 0;
    let cost = 0;
    for (const proj of usageData.projects) {
      for (const [op, data] of Object.entries(proj.by_operation)) {
        if (op.endsWith("_failed")) {
          count += data.count ?? 0;
          cost += data.cost_usd;
        }
      }
    }
    return { count, cost };
  }, [usageData]);

  const projectFailedCount = (proj: UsageProject) =>
    Object.entries(proj.by_operation)
      .filter(([op]) => op.endsWith("_failed"))
      .reduce((sum, [, data]) => sum + (data.count ?? 0), 0);

  const activeCount = accounts.filter((a) => !a.expired).length;
  const expiredCount = accounts.length - activeCount;

  // "Expiring soon" = accounts with trial_ends_at in the next 3 days.
  // Helps admin reach out before the customer churns. Skips already-
  // expired rows (those need a different action: revoke or upgrade).
  const now = Date.now();
  const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
  const expiringSoonCount = accounts.filter((a) => {
    if (a.expired) return false;
    if (!a.trial_ends_at) return false;
    const ts = new Date(a.trial_ends_at).getTime();
    if (isNaN(ts)) return false;
    return ts - now <= THREE_DAYS_MS && ts >= now;
  }).length;

  // Recent signups = granted in the last 7 days. Pulled from the same
  // /demo-accounts response — no new endpoint call.
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
  const recentSignupsCount = accounts.filter((a) => {
    if (!a.granted_at) return false;
    const ts = new Date(a.granted_at).getTime();
    if (isNaN(ts)) return false;
    return now - ts <= SEVEN_DAYS_MS;
  }).length;

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

        {/* ============ DASHBOARD OVERVIEW ============ */}
        {/* At-a-glance snapshot derived from the existing /demo-accounts
            response (already loaded for the Demo Accounts table below).
            Zero extra API calls. Shows what an admin most often needs to
            answer when they log in: who's about to churn, who just
            signed up, where do I focus today. */}
        <section>
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">
            Overview
          </h2>
          {loadingAccounts ? (
            <div className="grid grid-cols-4 gap-3">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="border border-border rounded-lg p-3 bg-card">
                  <div className="h-3 w-20 bg-muted rounded animate-pulse" />
                  <div className="h-7 w-12 bg-muted rounded animate-pulse mt-2" />
                </div>
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-4 gap-3">
              <div className="border border-border rounded-lg p-3 bg-card">
                <p className="text-xs text-muted-foreground uppercase tracking-wider">
                  Active customers
                </p>
                <p className="text-2xl font-semibold mt-1">{activeCount}</p>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  of {accounts.length} total demo records
                </p>
              </div>
              <div
                className={`border rounded-lg p-3 ${
                  expiringSoonCount > 0
                    ? "border-amber-300 bg-amber-50"
                    : "border-border bg-card"
                }`}
              >
                <p
                  className={`text-xs uppercase tracking-wider ${
                    expiringSoonCount > 0
                      ? "text-amber-800"
                      : "text-muted-foreground"
                  }`}
                >
                  Expiring in 3 days
                </p>
                <p
                  className={`text-2xl font-semibold mt-1 ${
                    expiringSoonCount > 0 ? "text-amber-800" : ""
                  }`}
                >
                  {expiringSoonCount}
                </p>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  {expiringSoonCount > 0
                    ? "consider proactive outreach"
                    : "no immediate action"}
                </p>
              </div>
              <div className="border border-border rounded-lg p-3 bg-card">
                <p className="text-xs text-muted-foreground uppercase tracking-wider">
                  Signups (7d)
                </p>
                <p className="text-2xl font-semibold mt-1">{recentSignupsCount}</p>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  granted in the past week
                </p>
              </div>
              <div className="border border-border rounded-lg p-3 bg-card">
                <p className="text-xs text-muted-foreground uppercase tracking-wider">
                  Expired records
                </p>
                <p className="text-2xl font-semibold mt-1 text-muted-foreground">
                  {expiredCount}
                </p>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  inactive — revoke or upgrade
                </p>
              </div>
            </div>
          )}
        </section>

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
                <div className="flex items-center gap-3">
                  <span className="text-xs text-muted-foreground">{userData.projects.length} project{userData.projects.length !== 1 ? "s" : ""}</span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setChangePlanResult(null);
                      setChangePlanError(null);
                      setChangePlanOpen(true);
                    }}
                    className="h-7 px-3 text-xs cursor-pointer"
                    title="Change plan with reset_period + optional project_id scoping. Backend refuses duration-mismatched no-reset switches."
                  >
                    Change Plan (Advanced)
                  </Button>
                </div>
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
                                  <SelectTrigger className="w-[180px] h-7 text-xs cursor-pointer">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {/* Plans pulled dynamically from core.subscription_plans
                                        (post-migration-048). Falls back to legacy hardcoded
                                        options if `plans` hasn't loaded yet (e.g. backend
                                        without /admin/plans endpoint). */}
                                    {plans.length > 0 ? (
                                      plans.map((p) => (
                                        <SelectItem
                                          key={p.code}
                                          value={p.code}
                                          className="cursor-pointer"
                                        >
                                          <div>
                                            {p.display_name}{" "}
                                            <span className="text-muted-foreground">
                                              ({p.duration_days}d
                                              {p.monthly_blog_quota !== null
                                                ? `, ${p.monthly_blog_quota} blogs/mo`
                                                : ", unlimited"}
                                              )
                                            </span>
                                          </div>
                                        </SelectItem>
                                      ))
                                    ) : (
                                      <>
                                        <SelectItem value="trial" className="cursor-pointer">
                                          <div>Trial <span className="text-muted-foreground">(3d, 3 blogs)</span></div>
                                        </SelectItem>
                                        <SelectItem value="pro30" className="cursor-pointer">
                                          <div>Pro 30 <span className="text-muted-foreground">(30d, 30 blogs)</span></div>
                                        </SelectItem>
                                        <SelectItem value="active" className="cursor-pointer">
                                          <div>Active <span className="text-muted-foreground">(365d, unlimited)</span></div>
                                        </SelectItem>
                                      </>
                                    )}
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

        {/* ============ CUSTOM BLOG QUOTA ============ */}
        <section>
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">
            Custom Blog Quota
          </h2>
          <p className="text-sm text-muted-foreground mb-3">
            Set a per-account override for the blog generation quota. Wins over the
            plan default. <span className="font-medium">There is no "unlimited" sentinel</span> —
            any number you set becomes a hard cap (the customer gets blocked on their
            Nth blog). Clear the override to fall back to the plan tier default.
            Effective immediately on the user's next blog generation request.
          </p>

          <div className="flex gap-2 mb-3 items-end">
            <Input
              type="email"
              placeholder="user@example.com"
              value={quotaEmail}
              onChange={(e) => setQuotaEmail(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleQuotaLookup()}
              className="max-w-[280px] h-9"
            />
            <Button
              onClick={handleQuotaLookup}
              disabled={quotaLoading || !quotaEmail.trim()}
              className="h-9 px-4 cursor-pointer"
            >
              {quotaLoading ? <Spinner /> : "Look up"}
            </Button>
          </div>

          {quotaMsg && (
            <p
              className={`text-sm mb-3 ${
                quotaMsg.type === "success" ? "text-green-700" : "text-destructive"
              }`}
            >
              {quotaMsg.text}
            </p>
          )}

          {quotaData && (
            <div className="border border-border rounded-lg p-4 bg-card space-y-4 max-w-2xl">
              {/* Current state */}
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <p className="text-xs text-muted-foreground uppercase tracking-wider">
                    Plan
                  </p>
                  <p className="font-medium mt-0.5">
                    {quotaData.plan_display_name ?? quotaData.plan_code ?? quotaData.legacy_status ?? "—"}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground uppercase tracking-wider">
                    Effective quota (per period)
                  </p>
                  <p className="font-medium mt-0.5 font-mono">
                    {quotaData.effective_quota ?? "—"}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground uppercase tracking-wider">
                    Custom override
                  </p>
                  <p className="font-medium mt-0.5">
                    {quotaData.custom_blog_quota === null ? (
                      <span className="text-muted-foreground italic">
                        not set (using plan default)
                      </span>
                    ) : (
                      <span>
                        <span className="font-mono">
                          {quotaData.custom_blog_quota}
                        </span>{" "}
                        blogs / period{" "}
                        <span className="text-xs text-muted-foreground">
                          (hard cap)
                        </span>{" "}
                      </span>
                    )}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground uppercase tracking-wider">
                    Used this period
                  </p>
                  <p className="font-medium mt-0.5 font-mono">
                    {quotaData.used_this_period}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground uppercase tracking-wider">
                    Quota cycle ({quotaData.plan_reset_interval ?? "—"})
                  </p>
                  <p className="font-medium mt-0.5 text-xs">
                    {quotaData.period_start ? fmtDate(quotaData.period_start) : "—"}
                    {" → "}
                    {quotaData.period_end ? fmtDate(quotaData.period_end) : "—"}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground uppercase tracking-wider">
                    Billing period
                  </p>
                  <p className="font-medium mt-0.5 text-xs">
                    {quotaData.billing_period_start ? fmtDate(quotaData.billing_period_start) : "—"}
                    {" → "}
                    {quotaData.billing_period_end ? fmtDate(quotaData.billing_period_end) : "—"}
                  </p>
                </div>
              </div>

              {/* Quick set buttons */}
              <div>
                <p className="text-xs text-muted-foreground uppercase tracking-wider mb-2">
                  Quick set
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleQuotaSet(null)}
                    disabled={quotaSaving}
                    className="cursor-pointer"
                  >
                    Use plan default
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleQuotaSet(3)}
                    disabled={quotaSaving}
                    className="cursor-pointer"
                  >
                    3 (Trial)
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleQuotaSet(30)}
                    disabled={quotaSaving}
                    className="cursor-pointer"
                  >
                    30 (Standard)
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleQuotaSet(50)}
                    disabled={quotaSaving}
                    className="cursor-pointer"
                  >
                    50 (Growth)
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleQuotaSet(80)}
                    disabled={quotaSaving}
                    className="cursor-pointer"
                  >
                    80 (Premium)
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground mt-2">
                  Quick-set buttons match the seeded plan tiers (3 / 30 / 50 / 80).
                  For any other cap (enterprise deals, support comp), use the custom
                  value field below. Every value is a hard cap — there is no unlimited
                  sentinel. The only unlimited path is a NULL{" "}
                  <span className="font-mono">plan_code</span> on{" "}
                  <span className="font-mono">module_activations</span> (legacy
                  'active' tier path).
                </p>
              </div>

              {/* Custom value input */}
              <div>
                <p className="text-xs text-muted-foreground uppercase tracking-wider mb-2">
                  Or set custom value
                </p>
                <div className="flex gap-2 items-center">
                  <Input
                    type="number"
                    min={0}
                    placeholder="e.g. 75"
                    value={quotaCustomValue}
                    onChange={(e) => setQuotaCustomValue(e.target.value)}
                    onKeyDown={(e) =>
                      e.key === "Enter" && handleQuotaCustomSubmit()
                    }
                    className="w-32 h-9"
                  />
                  <span className="text-sm text-muted-foreground">
                    blogs / billing period
                  </span>
                  <Button
                    size="sm"
                    onClick={handleQuotaCustomSubmit}
                    disabled={quotaSaving || !quotaCustomValue.trim()}
                    className="ml-2 cursor-pointer"
                  >
                    {quotaSaving ? <Spinner /> : "Apply"}
                  </Button>
                </div>
              </div>

              {/* Optional reason */}
              <div>
                <p className="text-xs text-muted-foreground uppercase tracking-wider mb-2">
                  Reason (optional, logged to server)
                </p>
                <Input
                  type="text"
                  placeholder="e.g. customer comp for bug, enterprise deal #4521"
                  value={quotaReason}
                  onChange={(e) => setQuotaReason(e.target.value)}
                  className="h-9"
                />
              </div>
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
              <div className="grid grid-cols-5 gap-3">
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
                <div className={`border rounded-lg p-3 ${failureSummary.count > 0 ? "border-red-200 bg-red-50" : "border-border bg-card"}`}>
                  <p className={`text-xs uppercase tracking-wider ${failureSummary.count > 0 ? "text-red-700" : "text-muted-foreground"}`}>Failed Calls</p>
                  <p className={`text-xl font-semibold mt-1 ${failureSummary.count > 0 ? "text-red-700" : ""}`}>{failureSummary.count.toLocaleString()}</p>
                  {failureSummary.count > 0 && (
                    <p className="text-[11px] text-red-600 mt-0.5">${failureSummary.cost.toFixed(2)} billed by Google</p>
                  )}
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
                              {projectFailedCount(proj) > 0 && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-50 text-red-700 border border-red-200">
                                  {projectFailedCount(proj)} failed
                                </span>
                              )}
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

        {/* ============ DAILY USAGE LEADERBOARD ============ */}
        <section>
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">Daily Leaderboard</h2>

          <div className="flex gap-2 mb-3 items-end flex-wrap">
            <div>
              <p className="text-xs text-muted-foreground mb-1">Date (UTC)</p>
              <Input
                type="date"
                value={leaderboardDate}
                onChange={(e) => setLeaderboardDate(e.target.value)}
                max={todayUTC}
                className="w-[160px] h-9"
              />
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-1">Top N</p>
              <Select value={leaderboardLimit} onValueChange={setLeaderboardLimit}>
                <SelectTrigger className="w-[100px] h-9 cursor-pointer">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="5" className="cursor-pointer">Top 5</SelectItem>
                  <SelectItem value="10" className="cursor-pointer">Top 10</SelectItem>
                  <SelectItem value="20" className="cursor-pointer">Top 20</SelectItem>
                  <SelectItem value="50" className="cursor-pointer">Top 50</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button onClick={loadLeaderboard} disabled={leaderboardLoading || !leaderboardDate} className="h-9 px-4 cursor-pointer">
              {leaderboardLoading ? <Spinner /> : "Load Leaderboard"}
            </Button>
          </div>

          {leaderboardError && <p className="text-sm text-destructive mb-3">{leaderboardError}</p>}

          {leaderboardData && (
            <div className="space-y-3">
              {/* Platform totals for the selected day */}
              <div className="grid grid-cols-3 gap-3">
                <div className="border border-border rounded-lg p-3 bg-card">
                  <p className="text-xs text-muted-foreground uppercase tracking-wider">
                    Platform Spend · {fmtUtcDate(leaderboardData.date)}
                  </p>
                  <p className="text-xl font-semibold mt-1">${leaderboardData.platform_total_cost_usd.toFixed(2)}</p>
                </div>
                <div className="border border-border rounded-lg p-3 bg-card">
                  <p className="text-xs text-muted-foreground uppercase tracking-wider">Total Calls</p>
                  <p className="text-xl font-semibold mt-1">{leaderboardData.platform_total_calls.toLocaleString()}</p>
                </div>
                <div className="border border-border rounded-lg p-3 bg-card">
                  <p className="text-xs text-muted-foreground uppercase tracking-wider">Active Accounts</p>
                  <p className="text-xl font-semibold mt-1">{leaderboardData.active_accounts.toLocaleString()}</p>
                </div>
              </div>

              {leaderboardData.truncated && (
                <p className="text-sm text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                  Result was truncated at the row cap. Numbers below underestimate actual spend for very active days.
                </p>
              )}

              {leaderboardData.leaderboard.length === 0 ? (
                <p className="text-sm text-muted-foreground">No API usage recorded on this date.</p>
              ) : (
                <div className="overflow-x-auto border border-border rounded-lg">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/40">
                      <tr className="text-left">
                        <th className="px-3 py-2 font-medium text-muted-foreground">#</th>
                        <th className="px-3 py-2 font-medium text-muted-foreground">Account</th>
                        <th className="px-3 py-2 font-medium text-muted-foreground">Owner</th>
                        <th className="px-3 py-2 font-medium text-muted-foreground text-right">Total $</th>
                        <th className="px-3 py-2 font-medium text-muted-foreground text-right">Blog $</th>
                        <th className="px-3 py-2 font-medium text-muted-foreground text-right">Social $</th>
                        <th className="px-3 py-2 font-medium text-muted-foreground text-right">LocalSEO $</th>
                        <th className="px-3 py-2 font-medium text-muted-foreground text-right">Claude $</th>
                        <th className="px-3 py-2 font-medium text-muted-foreground text-right">Gemini $</th>
                        <th className="px-3 py-2 font-medium text-muted-foreground text-right">OpenAI $</th>
                        <th className="px-3 py-2 font-medium text-muted-foreground text-right">Other $</th>
                        <th className="px-3 py-2 font-medium text-muted-foreground text-right">Calls</th>
                        <th className="px-3 py-2 font-medium text-muted-foreground text-right">Images</th>
                      </tr>
                    </thead>
                    <tbody>
                      {leaderboardData.leaderboard.map((row) => {
                        const blogCost = row.by_service.blog ?? 0;
                        const socialCost = row.by_service.social ?? 0;
                        const localseoCost = row.by_service.localseo ?? 0;
                        const claudeCost = row.by_provider.claude ?? 0;
                        const geminiCost = row.by_provider.gemini ?? 0;
                        const openaiCost = row.by_provider.openai ?? 0;
                        // "Other $" captures any future provider (bfl, fal, recraft, etc.)
                        // so the per-provider columns always sum to total_cost_usd and we
                        // never silently drop a new image-provider's spend off the table.
                        // Computed as Total minus the three explicit columns so floating-
                        // point rounding can't make it slightly negative — clamp at 0.
                        const knownProviderTotal = claudeCost + geminiCost + openaiCost;
                        const otherCost = Math.max(0, row.total_cost_usd - knownProviderTotal);
                        // Highlight the #1 spender — quick visual cue without scanning numbers.
                        const isTop = row.rank === 1;
                        return (
                          <tr key={row.account_id} className={`border-t border-border ${isTop ? "bg-amber-50/50" : ""}`}>
                            <td className="px-3 py-2 font-medium">{row.rank}</td>
                            <td className="px-3 py-2">
                              <div className="font-medium">{row.account_name}</div>
                              <div className="text-xs text-muted-foreground">{row.account_slug}</div>
                            </td>
                            <td className="px-3 py-2 text-muted-foreground">{row.owner_email}</td>
                            <td className="px-3 py-2 text-right font-semibold">${row.total_cost_usd.toFixed(2)}</td>
                            <td className="px-3 py-2 text-right">{blogCost > 0 ? `$${blogCost.toFixed(2)}` : "—"}</td>
                            <td className="px-3 py-2 text-right">{socialCost > 0 ? `$${socialCost.toFixed(2)}` : "—"}</td>
                            <td className="px-3 py-2 text-right">{localseoCost > 0 ? `$${localseoCost.toFixed(2)}` : "—"}</td>
                            <td className="px-3 py-2 text-right">{claudeCost > 0 ? `$${claudeCost.toFixed(2)}` : "—"}</td>
                            <td className="px-3 py-2 text-right">{geminiCost > 0 ? `$${geminiCost.toFixed(2)}` : "—"}</td>
                            <td className="px-3 py-2 text-right">{openaiCost > 0 ? `$${openaiCost.toFixed(2)}` : "—"}</td>
                            <td className="px-3 py-2 text-right">{otherCost >= 0.005 ? `$${otherCost.toFixed(2)}` : "—"}</td>
                            <td className="px-3 py-2 text-right">{row.calls.toLocaleString()}</td>
                            <td className="px-3 py-2 text-right">{row.images.toLocaleString()}</td>
                          </tr>
                        );
                      })}
                    </tbody>
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

        {/* Failed Jobs — cron-pipeline triage. Lists rows in generation_failed
            or publish_failed terminal states with per-row Retry buttons that
            resurrect the row so the next cron scan re-attempts it. */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
              Failed Jobs (Cron)
            </h2>
            <div className="flex items-center gap-2">
              <select
                value={failedJobsFilter}
                onChange={(e) => setFailedJobsFilter(
                  e.target.value as "" | "generation_failed" | "publish_failed" | "stuck_generating"
                )}
                className="h-9 px-3 rounded-md border border-input bg-background text-sm"
              >
                <option value="">All failures + stuck</option>
                <option value="generation_failed">generation_failed</option>
                <option value="publish_failed">publish_failed</option>
                <option value="stuck_generating">stuck_generating (worker crashed)</option>
              </select>
              <Button
                onClick={loadFailedJobs}
                disabled={failedJobsLoading}
                variant="outline"
                className="h-9 px-3 cursor-pointer"
              >
                {failedJobsLoading ? <Spinner className="h-4 w-4" /> : "Refresh"}
              </Button>
            </div>
          </div>

          <Message msg={failedJobsMsg} />

          {failedJobsError && (
            <p className="text-sm text-destructive mb-3">{failedJobsError}</p>
          )}

          {failedJobsLoading && !failedJobsData ? (
            <div className="flex justify-center py-8">
              <Spinner className="h-5 w-5 text-muted-foreground" />
            </div>
          ) : !failedJobsData || failedJobsData.rows.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">
              No failed jobs. Pipeline is healthy.
            </p>
          ) : (
            <>
              <div className="text-xs text-muted-foreground mb-2">
                Showing {failedJobsData.rows.length} of {failedJobsData.total_count} failed jobs
                {failedJobsFilter ? ` (filter: ${failedJobsFilter})` : ""}.
              </div>
              <div className="border border-border rounded-lg overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border bg-muted/30 text-xs text-muted-foreground uppercase tracking-wider">
                      <th className="text-left px-4 py-2 font-medium">Status</th>
                      <th className="text-left px-4 py-2 font-medium">Blog</th>
                      <th className="text-left px-4 py-2 font-medium">Attempts</th>
                      <th className="text-left px-4 py-2 font-medium">Error</th>
                      <th className="text-left px-4 py-2 font-medium">Updated</th>
                      <th className="text-right px-4 py-2 font-medium"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {failedJobsData.rows.map((row) => {
                      const isStuck = row.status === "generating" || row.status === "text_ready_images_pending";
                      const isPublishFailed = row.status === "publish_failed";
                      const errorText = isPublishFailed ? row.publish_last_error : row.gen_last_error;
                      const attempts = isPublishFailed ? row.publish_attempts : row.gen_attempts;
                      const statusClass = isStuck
                        ? "bg-amber-100 text-amber-700"
                        : isPublishFailed
                          ? "bg-orange-100 text-orange-700"
                          : "bg-rose-100 text-rose-700";
                      return (
                        <tr key={row.blog_id} className="border-b border-border last:border-0 hover:bg-muted/20">
                          <td className="px-4 py-2.5">
                            <span className={`inline-block px-2 py-0.5 text-xs rounded ${statusClass}`}>
                              {isStuck ? `stuck (${row.status})` : row.status}
                            </span>
                          </td>
                          <td className="px-4 py-2.5">
                            <div className="font-medium truncate max-w-[280px]" title={row.title || ""}>
                              {row.title || "(no title)"}
                            </div>
                            <div className="text-xs text-muted-foreground font-mono">
                              {row.blog_id.slice(0, 8)}... · {row.scheduled_date || "no date"}
                            </div>
                          </td>
                          <td className="px-4 py-2.5 text-muted-foreground">
                            {attempts ?? "—"}
                          </td>
                          <td className="px-4 py-2.5">
                            <div
                              className="text-xs text-muted-foreground truncate max-w-[320px]"
                              title={errorText || ""}
                            >
                              {errorText || "(no error message)"}
                            </div>
                          </td>
                          <td className="px-4 py-2.5 text-xs text-muted-foreground">
                            {row.updated_at ? fmtShortDate(row.updated_at) : "—"}
                          </td>
                          <td className="px-4 py-2.5 text-right">
                            <Button
                              onClick={() => handleRetryFailedJob(row.blog_id)}
                              disabled={retryingJobId === row.blog_id}
                              variant="outline"
                              className="h-8 px-3 text-xs cursor-pointer"
                            >
                              {retryingJobId === row.blog_id ? (
                                <Spinner className="h-3 w-3" />
                              ) : (
                                "Retry"
                              )}
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </section>
      </main>

      {/* Change-plan (Advanced) dialog — uses /api/v1/admin/change-plan */}
      <AlertDialog
        open={changePlanOpen}
        onOpenChange={(open) => {
          if (!open && !changePlanLoading) {
            setChangePlanOpen(false);
          }
        }}
      >
        <AlertDialogContent className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>Change Plan (Advanced)</AlertDialogTitle>
            <AlertDialogDescription>
              Switch <span className="font-semibold text-foreground">{userData?.email}</span> to a new plan.
              Reset_period restarts the subscription window today (clean quota counter).
              Leave Project ID empty to apply to all of the account's blog projects, or
              paste a UUID to scope to one project.
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="space-y-3 py-2">
            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Plan</label>
              <Select
                value={changePlanCode}
                onValueChange={setChangePlanCode}
                disabled={changePlanLoading}
              >
                <SelectTrigger className="w-full mt-1 cursor-pointer">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {plans.length > 0 ? (
                    plans.map((p) => (
                      <SelectItem key={p.code} value={p.code} className="cursor-pointer">
                        {p.display_name} ({p.monthly_blog_quota ?? "—"} blogs/mo)
                      </SelectItem>
                    ))
                  ) : (
                    <>
                      <SelectItem value="trial_3day" className="cursor-pointer">Trial (3 days)</SelectItem>
                      <SelectItem value="monthly_30" className="cursor-pointer">Standard 30 — Monthly</SelectItem>
                      <SelectItem value="monthly_50" className="cursor-pointer">Growth 50 — Monthly</SelectItem>
                      <SelectItem value="monthly_80" className="cursor-pointer">Premium 80 — Monthly</SelectItem>
                      <SelectItem value="yearly_30" className="cursor-pointer">Standard 30 — Annual</SelectItem>
                      <SelectItem value="yearly_50" className="cursor-pointer">Growth 50 — Annual</SelectItem>
                      <SelectItem value="yearly_80" className="cursor-pointer">Premium 80 — Annual</SelectItem>
                    </>
                  )}
                </SelectContent>
              </Select>
            </div>

            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={changePlanResetPeriod}
                onChange={(e) => setChangePlanResetPeriod(e.target.checked)}
                disabled={changePlanLoading}
                className="cursor-pointer"
              />
              <span>Reset subscription period to today</span>
              <span className="text-xs text-muted-foreground">(default; required when duration changes)</span>
            </label>

            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Project ID (optional)
              </label>
              <Input
                value={changePlanProjectId}
                onChange={(e) => setChangePlanProjectId(e.target.value)}
                placeholder="leave blank to apply to all account projects"
                disabled={changePlanLoading}
                className="mt-1 font-mono text-xs"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Multi-project accounts: paste a project UUID to change just that one.
              </p>
            </div>

            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Reason (optional)</label>
              <Input
                value={changePlanReason}
                onChange={(e) => setChangePlanReason(e.target.value)}
                placeholder="e.g. customer requested upgrade"
                disabled={changePlanLoading}
                className="mt-1"
              />
            </div>

            {changePlanError && (
              <div className="rounded border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
                {changePlanError}
              </div>
            )}

            {changePlanResult && (
              <div className="rounded border border-emerald-500/30 bg-emerald-50 dark:bg-emerald-950/20 p-2 text-xs space-y-1">
                <div className="font-medium text-emerald-700 dark:text-emerald-400">{changePlanResult.message}</div>
                <div className="text-muted-foreground">
                  Plan code updated. Customer fills new capacity themselves
                  via "Generate more" (one batch Claude call per request).
                </div>
                {changePlanResult.affected_project_ids && changePlanResult.affected_project_ids.length > 0 && (
                  <div>
                    <div className="text-muted-foreground">
                      Affected project{changePlanResult.affected_project_ids.length === 1 ? "" : "s"}
                      {" "}({changePlanResult.affected_project_ids.length}):
                    </div>
                    <ul className="mt-1 space-y-0.5">
                      {changePlanResult.affected_project_ids.map((pid, i) => (
                        <li key={i} className="font-mono text-[11px] truncate">
                          {pid ?? "(account-level row, no project_id)"}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {changePlanResult.period_start && changePlanResult.period_end && (
                  <div className="text-muted-foreground">
                    New period: {fmtShortDate(changePlanResult.period_start)} →{" "}
                    {fmtShortDate(changePlanResult.period_end)}
                  </div>
                )}
              </div>
            )}
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel
              className="cursor-pointer"
              disabled={changePlanLoading}
            >
              {changePlanResult ? "Close" : "Cancel"}
            </AlertDialogCancel>
            {!changePlanResult && (
              <AlertDialogAction
                onClick={(e) => {
                  e.preventDefault();
                  handleChangePlanSubmit();
                }}
                disabled={changePlanLoading}
                className="cursor-pointer"
              >
                {changePlanLoading ? <Spinner /> : "Apply Plan Change"}
              </AlertDialogAction>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
