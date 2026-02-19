import { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const API_URL =
  import.meta.env.VITE_API_URL || "https://api.thestacc.com/core";

interface DemoModule {
  module: string;
  status: string;
  expired: boolean;
}

interface DemoAccount {
  email: string;
  account_id: string;
  modules: DemoModule[];
  granted_at: string;
  trial_ends_at: string;
  expired: boolean;
}

function api(key: string) {
  const headers: Record<string, string> = {
    "X-Admin-Key": key,
    "Content-Type": "application/json",
  };
  return {
    async grantDemo(email: string, days: number) {
      const res = await fetch(`${API_URL}/api/v1/admin/grant-demo`, {
        method: "POST",
        headers,
        body: JSON.stringify({ email, days, modules: ["blog", "localseo"] }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.detail || `Error ${res.status}`);
      }
      return res.json();
    },
    async listAccounts(): Promise<{ accounts: DemoAccount[] }> {
      const res = await fetch(`${API_URL}/api/v1/admin/demo-accounts`, {
        headers,
      });
      if (!res.ok) throw new Error(`Error ${res.status}`);
      return res.json();
    },
    async revokeDemo(email: string) {
      const res = await fetch(
        `${API_URL}/api/v1/admin/revoke-demo?email=${encodeURIComponent(email)}`,
        { method: "DELETE", headers }
      );
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.detail || `Error ${res.status}`);
      }
      return res.json();
    },
  };
}

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
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-1/2 -left-1/2 w-full h-full bg-[oklch(0.52_0.24_280/0.06)] rounded-full blur-[120px]" />
        <div className="absolute -bottom-1/2 -right-1/2 w-full h-full bg-[oklch(0.45_0.2_300/0.05)] rounded-full blur-[120px]" />
      </div>

      <motion.div
        initial={{ opacity: 0, y: 20, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
      >
        <Card className="w-[380px] border-border/50 bg-card/80 backdrop-blur-xl shadow-2xl shadow-primary/5">
          <CardHeader className="text-center space-y-3 pb-2">
            <div className="mx-auto w-10 h-10 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center">
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="text-primary"
              >
                <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
            </div>
            <div>
              <CardTitle className="text-lg font-bold tracking-tight">
                theStacc Admin
              </CardTitle>
              <p className="text-sm text-muted-foreground mt-1">
                Enter your admin key to continue
              </p>
            </div>
          </CardHeader>
          <CardContent className="space-y-4 pt-2">
            <div className="space-y-2">
              <Label htmlFor="admin-key" className="text-xs text-muted-foreground uppercase tracking-wider font-medium">
                Admin Key
              </Label>
              <Input
                id="admin-key"
                type="password"
                placeholder="sk-admin-..."
                value={key}
                onChange={(e) => setKey(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleLogin()}
                className="bg-background/50 border-border/60 h-10 focus-visible:ring-primary/40"
              />
            </div>

            <AnimatePresence>
              {error && (
                <motion.p
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  className="text-sm text-destructive"
                >
                  {error}
                </motion.p>
              )}
            </AnimatePresence>

            <Button
              onClick={handleLogin}
              disabled={loading || !key.trim()}
              className="w-full h-10 bg-primary hover:bg-primary/90 text-primary-foreground font-semibold cursor-pointer"
            >
              {loading ? (
                <span className="flex items-center gap-2">
                  <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                      fill="none"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                    />
                  </svg>
                  Verifying...
                </span>
              ) : (
                "Sign In"
              )}
            </Button>
          </CardContent>
        </Card>
      </motion.div>
    </div>
  );
}

function Dashboard({
  adminKey,
  onLogout,
}: {
  adminKey: string;
  onLogout: () => void;
}) {
  const [accounts, setAccounts] = useState<DemoAccount[]>([]);
  const [email, setEmail] = useState("");
  const [days, setDays] = useState("7");
  const [granting, setGranting] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [message, setMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);
  const [loadingAccounts, setLoadingAccounts] = useState(true);

  const client = api(adminKey);

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

  useEffect(() => {
    loadAccounts();
  }, [loadAccounts]);

  const handleGrant = async () => {
    if (!email.trim()) return;
    setGranting(true);
    setMessage(null);
    try {
      await client.grantDemo(email.trim(), parseInt(days));
      setMessage({
        type: "success",
        text: `Demo access granted to ${email.trim()} for ${days} days`,
      });
      setEmail("");
      loadAccounts();
    } catch (err) {
      setMessage({
        type: "error",
        text: err instanceof Error ? err.message : "Failed to grant access",
      });
    } finally {
      setGranting(false);
    }
  };

  const handleRevoke = async (accountEmail: string) => {
    setRevoking(accountEmail);
    try {
      await client.revokeDemo(accountEmail);
      loadAccounts();
    } catch {
      setMessage({ type: "error", text: `Failed to revoke ${accountEmail}` });
    } finally {
      setRevoking(null);
    }
  };

  const activeCount = accounts.filter((a) => !a.expired).length;

  return (
    <div className="min-h-screen">
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-1/3 left-1/4 w-[500px] h-[500px] bg-[oklch(0.52_0.24_280/0.04)] rounded-full blur-[150px]" />
        <div className="absolute bottom-0 right-0 w-[400px] h-[400px] bg-[oklch(0.45_0.2_300/0.03)] rounded-full blur-[120px]" />
      </div>

      {/* Header */}
      <header className="relative border-b border-border/40 bg-card/30 backdrop-blur-md">
        <div className="max-w-4xl mx-auto px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-7 h-7 rounded-md bg-primary flex items-center justify-center">
              <span className="text-primary-foreground text-xs font-black">
                S
              </span>
            </div>
            <span className="font-bold text-sm tracking-tight">
              theStacc Admin
            </span>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={onLogout}
            className="text-muted-foreground hover:text-foreground text-xs cursor-pointer"
          >
            Sign Out
          </Button>
        </div>
      </header>

      {/* Content */}
      <main className="relative max-w-4xl mx-auto px-6 py-8 space-y-8">
        {/* Grant Access Card */}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
        >
          <Card className="border-border/40 bg-card/60 backdrop-blur-sm">
            <CardHeader className="pb-4">
              <CardTitle className="text-base font-bold tracking-tight flex items-center gap-2">
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="text-primary"
                >
                  <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                  <circle cx="9" cy="7" r="4" />
                  <line x1="19" x2="19" y1="8" y2="14" />
                  <line x1="22" x2="16" y1="11" y2="11" />
                </svg>
                Grant Demo Access
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex gap-3">
                <div className="flex-1 space-y-1.5">
                  <Label
                    htmlFor="email"
                    className="text-xs text-muted-foreground"
                  >
                    Customer Email
                  </Label>
                  <Input
                    id="email"
                    type="email"
                    placeholder="customer@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleGrant()}
                    className="bg-background/50 border-border/60 h-9 focus-visible:ring-primary/40"
                  />
                </div>
                <div className="w-[140px] space-y-1.5">
                  <Label className="text-xs text-muted-foreground">
                    Trial Duration
                  </Label>
                  <Select value={days} onValueChange={setDays}>
                    <SelectTrigger className="bg-background/50 border-border/60 h-9 cursor-pointer">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="bg-card border-border/60">
                      <SelectItem value="3" className="cursor-pointer">3 days</SelectItem>
                      <SelectItem value="7" className="cursor-pointer">7 days</SelectItem>
                      <SelectItem value="14" className="cursor-pointer">14 days</SelectItem>
                      <SelectItem value="30" className="cursor-pointer">30 days</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="flex items-center gap-3">
                <Button
                  onClick={handleGrant}
                  disabled={granting || !email.trim()}
                  className="bg-primary hover:bg-primary/90 text-primary-foreground font-semibold h-9 px-5 cursor-pointer"
                >
                  {granting ? (
                    <span className="flex items-center gap-2">
                      <svg
                        className="animate-spin h-3.5 w-3.5"
                        viewBox="0 0 24 24"
                      >
                        <circle
                          className="opacity-25"
                          cx="12"
                          cy="12"
                          r="10"
                          stroke="currentColor"
                          strokeWidth="4"
                          fill="none"
                        />
                        <path
                          className="opacity-75"
                          fill="currentColor"
                          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                        />
                      </svg>
                      Granting...
                    </span>
                  ) : (
                    "Grant Demo Access"
                  )}
                </Button>

                <AnimatePresence>
                  {message && (
                    <motion.span
                      initial={{ opacity: 0, x: -8 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0 }}
                      className={`text-sm ${message.type === "success" ? "text-emerald-600" : "text-destructive"}`}
                    >
                      {message.text}
                    </motion.span>
                  )}
                </AnimatePresence>
              </div>
            </CardContent>
          </Card>
        </motion.div>

        {/* Demo Accounts */}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{
            duration: 0.4,
            delay: 0.1,
            ease: [0.16, 1, 0.3, 1],
          }}
        >
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-base font-bold tracking-tight flex items-center gap-2">
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="text-muted-foreground"
              >
                <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                <circle cx="9" cy="7" r="4" />
                <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
                <path d="M16 3.13a4 4 0 0 1 0 7.75" />
              </svg>
              Demo Accounts
            </h2>
            {!loadingAccounts && (
              <span className="text-xs text-muted-foreground">
                {activeCount} active &middot; {accounts.length} total
              </span>
            )}
          </div>

          {loadingAccounts ? (
            <div className="flex items-center justify-center py-12">
              <svg
                className="animate-spin h-5 w-5 text-muted-foreground"
                viewBox="0 0 24 24"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                  fill="none"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                />
              </svg>
            </div>
          ) : accounts.length === 0 ? (
            <Card className="border-border/30 bg-card/30">
              <CardContent className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                <svg
                  width="32"
                  height="32"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="mb-3 opacity-40"
                >
                  <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                  <circle cx="9" cy="7" r="4" />
                  <line x1="17" x2="23" y1="11" y2="11" />
                </svg>
                <p className="text-sm">No demo accounts yet</p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-2">
              {accounts.map((account, i) => (
                <motion.div
                  key={account.email}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{
                    duration: 0.3,
                    delay: i * 0.04,
                    ease: [0.16, 1, 0.3, 1],
                  }}
                >
                  <Card className="border-border/30 bg-card/40 hover:bg-card/60 transition-colors">
                    <CardContent className="flex items-center justify-between py-3 px-4">
                      <div className="flex items-center gap-4 min-w-0">
                        <div className="w-8 h-8 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center shrink-0">
                          <span className="text-xs font-bold text-primary uppercase">
                            {account.email[0]}
                          </span>
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-medium truncate">
                            {account.email}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {new Date(account.granted_at).toLocaleDateString(
                              "en-US",
                              {
                                month: "short",
                                day: "numeric",
                              }
                            )}{" "}
                            &rarr;{" "}
                            {new Date(
                              account.trial_ends_at
                            ).toLocaleDateString("en-US", {
                              month: "short",
                              day: "numeric",
                            })}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-3 shrink-0">
                        <div className="flex gap-1">
                          {account.modules.map((m) => (
                            <Badge
                              key={m.module}
                              variant="secondary"
                              className="text-[10px] px-1.5 py-0 font-medium"
                            >
                              {m.module}
                            </Badge>
                          ))}
                        </div>
                        <Badge
                          variant={account.expired ? "destructive" : "default"}
                          className={`text-[10px] px-1.5 py-0 font-semibold ${
                            account.expired
                              ? "bg-destructive/15 text-destructive border-0"
                              : "bg-emerald-500/15 text-emerald-600 border-0"
                          }`}
                        >
                          {account.expired ? "Expired" : "Active"}
                        </Badge>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleRevoke(account.email)}
                          disabled={revoking === account.email}
                          className="text-muted-foreground hover:text-destructive h-7 px-2 text-xs cursor-pointer"
                        >
                          {revoking === account.email ? (
                            <svg
                              className="animate-spin h-3 w-3"
                              viewBox="0 0 24 24"
                            >
                              <circle
                                className="opacity-25"
                                cx="12"
                                cy="12"
                                r="10"
                                stroke="currentColor"
                                strokeWidth="4"
                                fill="none"
                              />
                              <path
                                className="opacity-75"
                                fill="currentColor"
                                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                              />
                            </svg>
                          ) : (
                            "Revoke"
                          )}
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                </motion.div>
              ))}
            </div>
          )}
        </motion.div>
      </main>
    </div>
  );
}

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
