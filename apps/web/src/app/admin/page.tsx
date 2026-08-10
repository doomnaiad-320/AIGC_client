"use client";

import type {
  AdminAgentRun,
  AdminAuditEvent,
  AdminCreditTransaction,
  AdminJob,
  AdminOverview,
  AdminUser,
  AdminUserDetail,
} from "@loomic/shared";
import {
  Activity,
  ArrowLeft,
  BadgeAlert,
  Bot,
  ChevronRight,
  CircleDollarSign,
  ClipboardList,
  Coins,
  Database,
  Loader2,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Users,
  Workflow,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  adjustAdminCredits,
  fetchAdminAgentRuns,
  fetchAdminAuditEvents,
  fetchAdminJobs,
  fetchAdminMe,
  fetchAdminOverview,
  fetchAdminTransactions,
  fetchAdminUserDetail,
  fetchAdminUsers,
} from "@/lib/admin-api";
import { useAuth } from "@/lib/auth-context";

type AdminTab = "users" | "jobs" | "agent-runs" | "ledger" | "audit";

const tabs: Array<{ id: AdminTab; label: string; icon: typeof Users }> = [
  { id: "users", label: "Users", icon: Users },
  { id: "jobs", label: "Jobs", icon: Workflow },
  { id: "agent-runs", label: "Agent runs", icon: Bot },
  { id: "ledger", label: "Credit ledger", icon: Coins },
  { id: "audit", label: "Audit log", icon: ClipboardList },
];

export default function AdminPage() {
  const { session, loading } = useAuth();
  const router = useRouter();
  const tokenRef = useRef(session?.access_token);
  tokenRef.current = session?.access_token;

  const [tab, setTab] = useState<AdminTab>("users");
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [jobs, setJobs] = useState<AdminJob[]>([]);
  const [agentRuns, setAgentRuns] = useState<AdminAgentRun[]>([]);
  const [transactions, setTransactions] = useState<AdminCreditTransaction[]>(
    [],
  );
  const [events, setEvents] = useState<AdminAuditEvent[]>([]);
  const [search, setSearch] = useState("");
  const [loadingData, setLoadingData] = useState(true);
  const [accessDenied, setAccessDenied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adjustingUser, setAdjustingUser] = useState<AdminUser | null>(null);
  const [adjustmentAmount, setAdjustmentAmount] = useState("");
  const [adjustmentReason, setAdjustmentReason] = useState("");
  const [adjustmentError, setAdjustmentError] = useState<string | null>(null);
  const [savingAdjustment, setSavingAdjustment] = useState(false);
  const [selectedUserDetail, setSelectedUserDetail] =
    useState<AdminUserDetail | null>(null);
  const [loadingUserDetail, setLoadingUserDetail] = useState(false);
  const [userDetailError, setUserDetailError] = useState<string | null>(null);

  const load = useCallback(async (searchValue = "") => {
    const token = tokenRef.current;
    if (!token) return;

    setLoadingData(true);
    setError(null);
    try {
      const access = await fetchAdminMe(token);
      if (!access.isPlatformAdmin) {
        setAccessDenied(true);
        return;
      }
      setAccessDenied(false);
      const [
        overviewData,
        usersData,
        jobsData,
        agentRunData,
        transactionData,
        eventData,
      ] = await Promise.all([
        fetchAdminOverview(token),
        fetchAdminUsers(token, searchValue),
        fetchAdminJobs(token),
        fetchAdminAgentRuns(token),
        fetchAdminTransactions(token),
        fetchAdminAuditEvents(token),
      ]);
      setOverview(overviewData.overview);
      setUsers(usersData.users);
      setJobs(jobsData.jobs);
      setAgentRuns(agentRunData.runs);
      setTransactions(transactionData.transactions);
      setEvents(eventData.events);
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Unable to load admin data.",
      );
    } finally {
      setLoadingData(false);
    }
  }, []);

  useEffect(() => {
    if (!loading && !session) {
      router.replace("/login");
    }
  }, [loading, router, session]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (session?.access_token) void load(search);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [load, search, session?.access_token]);

  async function openUserDetail(user: AdminUser) {
    const token = tokenRef.current;
    if (!token) return;
    setLoadingUserDetail(true);
    setUserDetailError(null);
    setSelectedUserDetail({
      recentAgentRuns: [],
      recentJobs: [],
      recentTransactions: [],
      user,
    });
    try {
      const { detail } = await fetchAdminUserDetail(token, user.id);
      setSelectedUserDetail(detail);
    } catch (detailError) {
      setUserDetailError(
        detailError instanceof Error
          ? detailError.message
          : "Unable to load user detail.",
      );
    } finally {
      setLoadingUserDetail(false);
    }
  }

  async function submitAdjustment(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const token = tokenRef.current;
    const adjustedUser = adjustingUser;
    const workspaceId = adjustedUser?.workspaceId;
    if (!token || !adjustedUser || !workspaceId) return;

    const amount = Number(adjustmentAmount);
    if (!Number.isInteger(amount) || amount === 0) {
      setAdjustmentError("Enter a whole-number adjustment that is not zero.");
      return;
    }
    if (adjustmentReason.trim().length < 3) {
      setAdjustmentError("Add a short reason for this adjustment.");
      return;
    }

    setSavingAdjustment(true);
    setAdjustmentError(null);
    try {
      await adjustAdminCredits(token, {
        workspaceId,
        targetUserId: adjustedUser.id,
        amount,
        reason: adjustmentReason.trim(),
      });
      setAdjustingUser(null);
      setAdjustmentAmount("");
      setAdjustmentReason("");
      await load(search);
      if (selectedUserDetail?.user.id === adjustedUser.id) {
        const { detail } = await fetchAdminUserDetail(token, adjustedUser.id);
        setSelectedUserDetail(detail);
      }
    } catch (saveError) {
      setAdjustmentError(
        saveError instanceof Error
          ? saveError.message
          : "Unable to adjust credits.",
      );
    } finally {
      setSavingAdjustment(false);
    }
  }

  if (loading || (!session && !accessDenied)) {
    return <AdminLoading />;
  }

  if (accessDenied) {
    return <AccessDenied />;
  }

  return (
    <div className="min-h-screen bg-[#f4f7f6] text-[#17211e]">
      <div className="mx-auto flex min-h-screen max-w-[1680px]">
        <aside className="hidden w-60 shrink-0 flex-col border-r border-[#d9e2dd] bg-[#17211e] px-4 py-5 text-[#dce7e0] lg:flex">
          <Link
            href="/admin"
            className="flex items-center gap-3 px-2 py-2"
            aria-label="Admin Console home"
          >
            <span className="flex size-8 items-center justify-center rounded-md bg-[#d2efdf] text-[#17211e]">
              <ShieldCheck className="size-4" />
            </span>
            <span className="text-sm font-semibold text-white">
              Admin Console
            </span>
          </Link>
          <div className="mt-10 space-y-1">
            {tabs.map((item) => {
              const Icon = item.icon;
              const selected = tab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setTab(item.id)}
                  className={`flex h-10 w-full items-center gap-3 rounded-md px-3 text-left text-sm transition-colors ${
                    selected
                      ? "bg-[#294238] text-white"
                      : "text-[#b5c6bc] hover:bg-[#20362d] hover:text-white"
                  }`}
                >
                  <Icon className="size-4" />
                  {item.label}
                </button>
              );
            })}
          </div>
          <div className="mt-auto border-t border-[#365247] pt-4">
            <Link
              href="/home"
              className="flex h-9 items-center gap-2 px-3 text-sm text-[#b5c6bc] hover:text-white"
            >
              <ArrowLeft className="size-4" />
              Return to workspace
            </Link>
          </div>
        </aside>

        <main className="min-w-0 flex-1 px-4 py-4 sm:px-6 sm:py-6 lg:px-10 lg:py-8">
          <header className="flex flex-wrap items-start justify-between gap-4 border-b border-[#d9e2dd] pb-5">
            <div>
              <div className="flex items-center gap-2 text-xs font-medium text-[#477462]">
                <span className="size-1.5 rounded-full bg-[#24916a]" />
                Platform operations
              </div>
              <h1 className="mt-2 text-2xl font-semibold sm:text-3xl">
                Admin Console
              </h1>
              <p className="mt-1 text-sm text-[#64736c]">
                Users, credit activity, job health, and operator actions.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Link href="/home" className="lg:hidden">
                <Button variant="outline" size="sm">
                  <ArrowLeft data-icon="inline-start" />
                  Workspace
                </Button>
              </Link>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void load(search)}
                disabled={loadingData}
              >
                <RefreshCw
                  data-icon="inline-start"
                  className={loadingData ? "animate-spin" : undefined}
                />
                Refresh
              </Button>
            </div>
          </header>

          <nav
            className="mt-4 flex gap-1 overflow-x-auto border-b border-[#d9e2dd] lg:hidden"
            aria-label="Admin sections"
          >
            {tabs.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setTab(item.id)}
                  className={`flex h-10 shrink-0 items-center gap-2 border-b-2 px-3 text-sm ${
                    tab === item.id
                      ? "border-[#24916a] text-[#17211e]"
                      : "border-transparent text-[#64736c]"
                  }`}
                >
                  <Icon className="size-4" />
                  {item.label}
                </button>
              );
            })}
          </nav>

          {error && (
            <div
              className="mt-5 flex items-start gap-3 border border-[#e9bebe] bg-[#fff7f6] p-4 text-sm text-[#8e2f2b]"
              role="alert"
            >
              <BadgeAlert className="mt-0.5 size-4 shrink-0" />
              <div>{error}</div>
            </div>
          )}

          <section
            className="mt-6 grid grid-cols-2 border border-[#d9e2dd] bg-white sm:grid-cols-4"
            aria-label="Platform overview"
          >
            <Stat
              label="Total users"
              value={overview?.totalUsers}
              icon={Users}
            />
            <Stat
              label="Active jobs"
              value={overview?.activeJobs}
              icon={Activity}
            />
            <Stat
              label="Failures · 24h"
              value={overview?.failedJobs24h}
              icon={BadgeAlert}
              alert
            />
            <Stat
              label="Adjustments · 24h"
              value={overview?.adjustments24h}
              icon={CircleDollarSign}
            />
          </section>

          <section className="mt-6 border border-[#d9e2dd] bg-white">
            {tab === "users" && (
              <UsersTable
                users={users}
                loading={loadingData}
                search={search}
                onSearchChange={setSearch}
                onView={(user) => void openUserDetail(user)}
                onAdjust={(user) => {
                  setAdjustmentError(null);
                  setAdjustingUser(user);
                }}
              />
            )}
            {tab === "jobs" && <JobsTable jobs={jobs} loading={loadingData} />}
            {tab === "agent-runs" && (
              <AgentRunsTable runs={agentRuns} loading={loadingData} />
            )}
            {tab === "ledger" && (
              <LedgerTable transactions={transactions} loading={loadingData} />
            )}
            {tab === "audit" && (
              <AuditTable events={events} loading={loadingData} />
            )}
          </section>
        </main>
      </div>

      <Dialog
        open={Boolean(adjustingUser)}
        onOpenChange={(open) => !open && setAdjustingUser(null)}
      >
        <DialogContent className="max-w-md">
          <form onSubmit={submitAdjustment}>
            <DialogHeader>
              <DialogTitle>Adjust credits</DialogTitle>
              <DialogDescription>
                {adjustingUser?.email} · Current balance:{" "}
                {adjustingUser?.balance.toLocaleString() ?? 0}
              </DialogDescription>
            </DialogHeader>
            <div className="mt-5 space-y-4">
              <div className="space-y-2">
                <Label htmlFor="admin-credit-amount">Credit adjustment</Label>
                <Input
                  id="admin-credit-amount"
                  inputMode="numeric"
                  max="500000"
                  min="-500000"
                  onChange={(event) => setAdjustmentAmount(event.target.value)}
                  placeholder="e.g. 500 or -100"
                  type="number"
                  value={adjustmentAmount}
                />
                <p className="text-xs text-muted-foreground">
                  Use a positive value to grant credits or a negative value to
                  deduct them.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="admin-credit-reason">Reason</Label>
                <textarea
                  id="admin-credit-reason"
                  className="flex min-h-24 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                  maxLength={500}
                  onChange={(event) => setAdjustmentReason(event.target.value)}
                  placeholder="Explain why this adjustment is needed"
                  value={adjustmentReason}
                />
              </div>
              {adjustmentError && (
                <p className="text-sm text-destructive" role="alert">
                  {adjustmentError}
                </p>
              )}
            </div>
            <DialogFooter className="mt-6">
              <Button type="submit" disabled={savingAdjustment}>
                {savingAdjustment && (
                  <Loader2 data-icon="inline-start" className="animate-spin" />
                )}
                Save adjustment
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <UserDetailDialog
        detail={selectedUserDetail}
        error={userDetailError}
        loading={loadingUserDetail}
        onClose={() => {
          setSelectedUserDetail(null);
          setUserDetailError(null);
        }}
        onAdjust={(user) => {
          setAdjustmentError(null);
          setAdjustingUser(user);
        }}
      />
    </div>
  );
}

function Stat({
  label,
  value,
  icon: Icon,
  alert = false,
}: {
  label: string;
  value: number | undefined;
  icon: typeof Users;
  alert?: boolean;
}) {
  return (
    <div className="min-w-0 border-b border-[#d9e2dd] p-4 last:border-b-0 sm:border-b-0 sm:border-r sm:last:border-r-0">
      <div className="flex items-center gap-2 text-xs text-[#64736c]">
        <Icon
          className={`size-3.5 ${alert ? "text-[#c65349]" : "text-[#477462]"}`}
        />
        <span className="truncate">{label}</span>
      </div>
      <div className="mt-3 text-2xl font-semibold tabular-nums">
        {value?.toLocaleString() ?? "—"}
      </div>
    </div>
  );
}

function TableFrame({
  title,
  subtitle,
  children,
}: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-[#d9e2dd] px-4 py-4 sm:px-5">
        <div>
          <h2 className="text-base font-semibold">{title}</h2>
          <p className="mt-1 text-sm text-[#64736c]">{subtitle}</p>
        </div>
      </div>
      {children}
    </>
  );
}

function UsersTable({
  users,
  loading,
  search,
  onSearchChange,
  onView,
  onAdjust,
}: {
  users: AdminUser[];
  loading: boolean;
  search: string;
  onSearchChange: (value: string) => void;
  onView: (user: AdminUser) => void;
  onAdjust: (user: AdminUser) => void;
}) {
  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-[#d9e2dd] px-4 py-4 sm:px-5">
        <div>
          <h2 className="text-base font-semibold">Users</h2>
          <p className="mt-1 text-sm text-[#64736c]">
            Account, subscription, balance, and platform access.
          </p>
        </div>
        <div className="relative w-full sm:w-72">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[#75847c]" />
          <Input
            aria-label="Search users"
            className="pl-9"
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Search name or email"
            value={search}
          />
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[840px] text-left text-sm">
          <thead className="border-b border-[#d9e2dd] bg-[#edf3f0] text-xs text-[#526259]">
            <tr>
              <th className="px-5 py-3 font-medium">User</th>
              <th className="px-5 py-3 font-medium">Workspace</th>
              <th className="px-5 py-3 font-medium">Plan</th>
              <th className="px-5 py-3 font-medium">Balance</th>
              <th className="px-5 py-3 font-medium">Last sign-in</th>
              <th className="px-5 py-3 text-right font-medium">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#e4ebe7]">
            {loading ? (
              <LoadingRows columns={6} />
            ) : users.length === 0 ? (
              <EmptyRow columns={6} label="No users match this search." />
            ) : (
              users.map((user) => (
                <tr key={user.id} className="hover:bg-[#f7faf8]">
                  <td className="px-5 py-3.5">
                    <div className="flex items-center gap-3">
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[#dceee5] text-xs font-semibold text-[#285b47]">
                        {initials(user.displayName, user.email)}
                      </span>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 font-medium">
                          <span className="truncate">{user.displayName}</span>
                          {user.isPlatformAdmin && (
                            <ShieldCheck
                              className="size-3.5 text-[#24855f]"
                              aria-label="Platform admin"
                            />
                          )}
                        </div>
                        <div className="max-w-52 truncate text-xs text-[#64736c]">
                          {user.email}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="px-5 py-3.5 text-[#526259]">
                    {user.workspaceName ?? "—"}
                  </td>
                  <td className="px-5 py-3.5">
                    <PlanBadge plan={user.plan} />
                  </td>
                  <td className="px-5 py-3.5 font-medium tabular-nums">
                    {user.balance.toLocaleString()}
                  </td>
                  <td className="px-5 py-3.5 text-[#64736c]">
                    {user.lastSignInAt
                      ? formatDate(user.lastSignInAt)
                      : "Never"}
                  </td>
                  <td className="px-5 py-3.5 text-right">
                    <div className="flex justify-end gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => onView(user)}
                      >
                        Details
                        <ChevronRight data-icon="inline-end" />
                      </Button>
                      {user.workspaceId ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => onAdjust(user)}
                        >
                          <Coins data-icon="inline-start" />
                          Adjust
                        </Button>
                      ) : (
                        <span className="text-xs text-[#8a9890]">
                          No workspace
                        </span>
                      )}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

function JobsTable({ jobs, loading }: { jobs: AdminJob[]; loading: boolean }) {
  return (
    <TableFrame
      title="Generation jobs"
      subtitle="Queue health and recent execution results."
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead className="border-b border-[#d9e2dd] bg-[#edf3f0] text-xs text-[#526259]">
            <tr>
              <th className="px-5 py-3 font-medium">Status</th>
              <th className="px-5 py-3 font-medium">Type</th>
              <th className="px-5 py-3 font-medium">User</th>
              <th className="px-5 py-3 font-medium">Workspace</th>
              <th className="px-5 py-3 font-medium">Created</th>
              <th className="px-5 py-3 font-medium">Failure</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#e4ebe7]">
            {loading ? (
              <LoadingRows columns={6} />
            ) : jobs.length === 0 ? (
              <EmptyRow columns={6} label="No generation jobs recorded yet." />
            ) : (
              jobs.map((job) => (
                <tr key={job.id} className="hover:bg-[#f7faf8]">
                  <td className="px-5 py-3.5">
                    <StatusBadge status={job.status} />
                  </td>
                  <td className="px-5 py-3.5 font-medium">
                    {job.jobType.replace(/_/g, " ")}
                  </td>
                  <td className="px-5 py-3.5 text-[#526259]">
                    {job.userEmail ?? "—"}
                  </td>
                  <td className="px-5 py-3.5 text-[#526259]">
                    {job.workspaceName ?? "—"}
                  </td>
                  <td className="px-5 py-3.5 text-[#64736c]">
                    {formatDate(job.createdAt)}
                  </td>
                  <td
                    className="max-w-64 truncate px-5 py-3.5 text-[#a0463f]"
                    title={job.errorMessage ?? undefined}
                  >
                    {job.errorCode ?? "—"}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </TableFrame>
  );
}

function AgentRunsTable({
  runs,
  loading,
}: {
  runs: AdminAgentRun[];
  loading: boolean;
}) {
  return (
    <TableFrame
      title="Agent runs"
      subtitle="Conversation-level agent execution status, model, thread, and errors."
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[920px] text-left text-sm">
          <thead className="border-b border-[#d9e2dd] bg-[#edf3f0] text-xs text-[#526259]">
            <tr>
              <th className="px-5 py-3 font-medium">Status</th>
              <th className="px-5 py-3 font-medium">Session</th>
              <th className="px-5 py-3 font-medium">User</th>
              <th className="px-5 py-3 font-medium">Workspace</th>
              <th className="px-5 py-3 font-medium">Model</th>
              <th className="px-5 py-3 font-medium">Created</th>
              <th className="px-5 py-3 font-medium">Error</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#e4ebe7]">
            {loading ? (
              <LoadingRows columns={7} />
            ) : runs.length === 0 ? (
              <EmptyRow columns={7} label="No agent runs recorded yet." />
            ) : (
              runs.map((run) => (
                <tr key={run.id} className="hover:bg-[#f7faf8]">
                  <td className="px-5 py-3.5">
                    <StatusBadge status={run.status} />
                  </td>
                  <td className="px-5 py-3.5">
                    <div className="font-medium">
                      {run.sessionTitle ?? "Untitled session"}
                    </div>
                    <div className="max-w-56 truncate text-xs text-[#64736c]">
                      {run.threadId}
                    </div>
                  </td>
                  <td className="px-5 py-3.5 text-[#526259]">
                    {run.userEmail ?? "—"}
                  </td>
                  <td className="px-5 py-3.5">
                    <div className="text-[#526259]">
                      {run.workspaceName ?? "—"}
                    </div>
                    <div className="text-xs text-[#8a9890]">
                      {run.projectName ?? run.canvasName ?? "—"}
                    </div>
                  </td>
                  <td className="px-5 py-3.5 text-[#526259]">
                    {run.model ?? "—"}
                  </td>
                  <td className="px-5 py-3.5 text-[#64736c]">
                    {formatDate(run.createdAt)}
                  </td>
                  <td
                    className="max-w-72 truncate px-5 py-3.5 text-[#a0463f]"
                    title={run.errorMessage ?? undefined}
                  >
                    {run.errorCode ?? "—"}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </TableFrame>
  );
}

function LedgerTable({
  transactions,
  loading,
}: { transactions: AdminCreditTransaction[]; loading: boolean }) {
  return (
    <TableFrame
      title="Credit ledger"
      subtitle="Append-only record of grants, usage, refunds, and adjustments."
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[780px] text-left text-sm">
          <thead className="border-b border-[#d9e2dd] bg-[#edf3f0] text-xs text-[#526259]">
            <tr>
              <th className="px-5 py-3 font-medium">Type</th>
              <th className="px-5 py-3 font-medium">User</th>
              <th className="px-5 py-3 font-medium">Amount</th>
              <th className="px-5 py-3 font-medium">Balance after</th>
              <th className="px-5 py-3 font-medium">Reason</th>
              <th className="px-5 py-3 font-medium">Time</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#e4ebe7]">
            {loading ? (
              <LoadingRows columns={6} />
            ) : transactions.length === 0 ? (
              <EmptyRow columns={6} label="No credit activity recorded yet." />
            ) : (
              transactions.map((item) => (
                <tr key={item.id} className="hover:bg-[#f7faf8]">
                  <td className="px-5 py-3.5">
                    <span className="capitalize text-[#426457]">
                      {item.transactionType.replace(/_/g, " ")}
                    </span>
                  </td>
                  <td className="px-5 py-3.5 text-[#526259]">
                    {item.userEmail ?? item.workspaceName ?? "—"}
                  </td>
                  <td
                    className={`px-5 py-3.5 font-semibold tabular-nums ${item.amount >= 0 ? "text-[#16835e]" : "text-[#b44d45]"}`}
                  >
                    {item.amount >= 0 ? "+" : ""}
                    {item.amount.toLocaleString()}
                  </td>
                  <td className="px-5 py-3.5 tabular-nums">
                    {item.balanceAfter.toLocaleString()}
                  </td>
                  <td
                    className="max-w-72 truncate px-5 py-3.5 text-[#64736c]"
                    title={item.description ?? undefined}
                  >
                    {item.description ?? "—"}
                  </td>
                  <td className="px-5 py-3.5 text-[#64736c]">
                    {formatDate(item.createdAt)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </TableFrame>
  );
}

function AuditTable({
  events,
  loading,
}: { events: AdminAuditEvent[]; loading: boolean }) {
  return (
    <TableFrame
      title="Operator audit log"
      subtitle="Every sensitive console action is recorded with actor and target context."
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead className="border-b border-[#d9e2dd] bg-[#edf3f0] text-xs text-[#526259]">
            <tr>
              <th className="px-5 py-3 font-medium">Action</th>
              <th className="px-5 py-3 font-medium">Operator</th>
              <th className="px-5 py-3 font-medium">Target</th>
              <th className="px-5 py-3 font-medium">Details</th>
              <th className="px-5 py-3 font-medium">Time</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#e4ebe7]">
            {loading ? (
              <LoadingRows columns={5} />
            ) : events.length === 0 ? (
              <EmptyRow
                columns={5}
                label="No administrator actions recorded yet."
              />
            ) : (
              events.map((event) => (
                <tr key={event.id} className="hover:bg-[#f7faf8]">
                  <td className="px-5 py-3.5 font-medium">{event.action}</td>
                  <td className="px-5 py-3.5 text-[#526259]">
                    {event.actorEmail}
                  </td>
                  <td className="px-5 py-3.5 text-[#526259]">
                    {event.targetEmail ?? event.workspaceName ?? "—"}
                  </td>
                  <td
                    className="max-w-72 truncate px-5 py-3.5 text-[#64736c]"
                    title={JSON.stringify(event.metadata)}
                  >
                    {auditSummary(event.metadata)}
                  </td>
                  <td className="px-5 py-3.5 text-[#64736c]">
                    {formatDate(event.createdAt)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </TableFrame>
  );
}

function UserDetailDialog({
  detail,
  loading,
  error,
  onClose,
  onAdjust,
}: {
  detail: AdminUserDetail | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onAdjust: (user: AdminUser) => void;
}) {
  const user = detail?.user;

  return (
    <Dialog open={Boolean(detail)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[88vh] max-w-5xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>User detail</DialogTitle>
          <DialogDescription>
            {user
              ? `${user.displayName} · ${user.email}`
              : "Loading account, workspace, credits, and execution activity."}
          </DialogDescription>
        </DialogHeader>

        {user && (
          <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <DetailTile label="Plan">
              <PlanBadge plan={user.plan} />
            </DetailTile>
            <DetailTile label="Balance">
              <span className="tabular-nums">
                {user.balance.toLocaleString()}
              </span>
            </DetailTile>
            <DetailTile label="Workspace">
              <span className="truncate">{user.workspaceName ?? "—"}</span>
            </DetailTile>
            <DetailTile label="Access">
              <span className="inline-flex items-center gap-1">
                {user.isPlatformAdmin && <ShieldCheck className="size-3.5" />}
                {user.isPlatformAdmin ? "Platform admin" : "Workspace user"}
              </span>
            </DetailTile>
            <DetailTile label="Registered">
              {formatDate(user.createdAt)}
            </DetailTile>
            <DetailTile label="Last sign-in">
              {user.lastSignInAt ? formatDate(user.lastSignInAt) : "Never"}
            </DetailTile>
            <DetailTile label="User ID">
              <span className="truncate text-xs">{user.id}</span>
            </DetailTile>
            <DetailTile label="Workspace ID">
              <span className="truncate text-xs">
                {user.workspaceId ?? "—"}
              </span>
            </DetailTile>
          </div>
        )}

        {error && (
          <div
            className="mt-5 flex items-start gap-3 border border-[#e9bebe] bg-[#fff7f6] p-3 text-sm text-[#8e2f2b]"
            role="alert"
          >
            <BadgeAlert className="mt-0.5 size-4 shrink-0" />
            <div>{error}</div>
          </div>
        )}

        {loading && (
          <div className="mt-5 flex items-center gap-2 text-sm text-[#64736c]">
            <Loader2 className="size-4 animate-spin text-[#24855f]" />
            Loading recent activity
          </div>
        )}

        {detail && !loading && (
          <div className="mt-5 grid gap-4 xl:grid-cols-3">
            <RecentTransactionsPanel transactions={detail.recentTransactions} />
            <RecentJobsPanel jobs={detail.recentJobs} />
            <RecentAgentRunsPanel runs={detail.recentAgentRuns} />
          </div>
        )}

        <DialogFooter className="mt-6">
          <Button type="button" variant="outline" onClick={onClose}>
            Close
          </Button>
          {user?.workspaceId && (
            <Button type="button" onClick={() => onAdjust(user)}>
              <Coins data-icon="inline-start" />
              Adjust credits
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DetailTile({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0 border border-[#d9e2dd] bg-[#f8fbf9] p-3">
      <div className="text-xs font-medium uppercase tracking-wide text-[#64736c]">
        {label}
      </div>
      <div className="mt-2 min-w-0 text-sm font-medium text-[#17211e]">
        {children}
      </div>
    </div>
  );
}

function DetailPanel({
  title,
  emptyLabel,
  children,
}: {
  title: string;
  emptyLabel: string;
  children: React.ReactNode[];
}) {
  return (
    <section className="min-w-0 border border-[#d9e2dd]">
      <div className="border-b border-[#d9e2dd] bg-[#edf3f0] px-4 py-3">
        <h3 className="text-sm font-semibold">{title}</h3>
      </div>
      <div className="divide-y divide-[#e4ebe7]">
        {children.length > 0 ? (
          children
        ) : (
          <div className="px-4 py-8 text-center text-sm text-[#64736c]">
            {emptyLabel}
          </div>
        )}
      </div>
    </section>
  );
}

function RecentTransactionsPanel({
  transactions,
}: {
  transactions: AdminCreditTransaction[];
}) {
  return (
    <DetailPanel title="Credit ledger" emptyLabel="No recent credit activity.">
      {transactions.map((item) => (
        <div key={item.id} className="px-4 py-3 text-sm">
          <div className="flex items-start justify-between gap-3">
            <span className="capitalize text-[#426457]">
              {item.transactionType.replace(/_/g, " ")}
            </span>
            <span
              className={`font-semibold tabular-nums ${item.amount >= 0 ? "text-[#16835e]" : "text-[#b44d45]"}`}
            >
              {item.amount >= 0 ? "+" : ""}
              {item.amount.toLocaleString()}
            </span>
          </div>
          <div className="mt-1 truncate text-xs text-[#64736c]">
            {item.description ?? "No reason recorded"}
          </div>
          <div className="mt-1 text-xs text-[#8a9890]">
            Balance {item.balanceAfter.toLocaleString()} ·{" "}
            {formatDate(item.createdAt)}
          </div>
        </div>
      ))}
    </DetailPanel>
  );
}

function RecentJobsPanel({ jobs }: { jobs: AdminJob[] }) {
  return (
    <DetailPanel
      title="Generation jobs"
      emptyLabel="No recent generation jobs."
    >
      {jobs.map((job) => (
        <div key={job.id} className="px-4 py-3 text-sm">
          <div className="flex items-start justify-between gap-3">
            <span className="font-medium capitalize">
              {job.jobType.replace(/_/g, " ")}
            </span>
            <StatusBadge status={job.status} />
          </div>
          <div className="mt-1 text-xs text-[#64736c]">
            {formatDate(job.createdAt)}
          </div>
          {(job.errorCode || job.errorMessage) && (
            <div
              className="mt-1 truncate text-xs text-[#a0463f]"
              title={job.errorMessage ?? undefined}
            >
              {job.errorCode ?? job.errorMessage}
            </div>
          )}
        </div>
      ))}
    </DetailPanel>
  );
}

function RecentAgentRunsPanel({ runs }: { runs: AdminAgentRun[] }) {
  return (
    <DetailPanel title="Agent runs" emptyLabel="No recent agent runs.">
      {runs.map((run) => (
        <div key={run.id} className="px-4 py-3 text-sm">
          <div className="flex items-start justify-between gap-3">
            <span className="min-w-0 truncate font-medium">
              {run.sessionTitle ?? "Untitled session"}
            </span>
            <StatusBadge status={run.status} />
          </div>
          <div className="mt-1 truncate text-xs text-[#64736c]">
            {run.model ?? "No model"} · {run.threadId}
          </div>
          <div className="mt-1 text-xs text-[#8a9890]">
            {formatDate(run.createdAt)}
            {run.completedAt
              ? ` · Completed ${formatDate(run.completedAt)}`
              : ""}
          </div>
          {(run.errorCode || run.errorMessage) && (
            <div
              className="mt-1 truncate text-xs text-[#a0463f]"
              title={run.errorMessage ?? undefined}
            >
              {run.errorCode ?? run.errorMessage}
            </div>
          )}
        </div>
      ))}
    </DetailPanel>
  );
}

function PlanBadge({ plan }: { plan: string }) {
  return (
    <span className="inline-flex rounded-full border border-[#cfe1d7] bg-[#f2faf5] px-2 py-0.5 text-xs font-medium capitalize text-[#32634e]">
      {plan}
    </span>
  );
}
function StatusBadge({ status }: { status: string }) {
  const tone =
    status === "succeeded" || status === "completed"
      ? "border-[#b9e2cd] bg-[#edf9f1] text-[#22754e]"
      : status === "failed" || status === "dead_letter"
        ? "border-[#ecc7c4] bg-[#fff4f3] text-[#a8443c]"
        : status === "running"
          ? "border-[#bfdaea] bg-[#f0f8fc] text-[#2e6c91]"
          : "border-[#dfd8c3] bg-[#fbf8ef] text-[#806d34]";
  return (
    <span
      className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium capitalize ${tone}`}
    >
      {status.replace(/_/g, " ")}
    </span>
  );
}
function LoadingRows({ columns }: { columns: number }) {
  const skeletonRows = ["a", "b", "c", "d", "e"];

  return (
    <>
      {skeletonRows.map((rowId) => (
        <tr key={rowId}>
          <td colSpan={columns} className="px-5 py-4">
            <div className="h-4 animate-pulse bg-[#edf3f0]" />
          </td>
        </tr>
      ))}
    </>
  );
}
function EmptyRow({ columns, label }: { columns: number; label: string }) {
  return (
    <tr>
      <td
        colSpan={columns}
        className="px-5 py-12 text-center text-sm text-[#64736c]"
      >
        <Database className="mx-auto mb-3 size-5 text-[#9daaa3]" />
        {label}
      </td>
    </tr>
  );
}
function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
function initials(name: string, email: string) {
  return (name || email).trim().slice(0, 2).toUpperCase();
}
function auditSummary(metadata: Record<string, unknown>) {
  const amount = metadata.amount;
  const reason = metadata.reason;
  return typeof amount === "number"
    ? `${amount >= 0 ? "+" : ""}${amount} credits${typeof reason === "string" ? ` · ${reason}` : ""}`
    : "Recorded";
}

function AdminLoading() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[#f4f7f6]">
      <div className="flex items-center gap-3 text-sm text-[#526259]">
        <Loader2 className="size-4 animate-spin text-[#24855f]" />
        Loading Admin Console
      </div>
    </div>
  );
}
function AccessDenied() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[#f4f7f6] p-6">
      <div className="w-full max-w-md border border-[#d9e2dd] bg-white p-6">
        <span className="flex size-10 items-center justify-center rounded-md bg-[#fff0ee] text-[#b44d45]">
          <ShieldCheck className="size-5" />
        </span>
        <h1 className="mt-5 text-xl font-semibold">
          Administrator access required
        </h1>
        <p className="mt-2 text-sm text-[#64736c]">
          This account can use the creative workspace but does not have platform
          operations access.
        </p>
        <Link href="/home" className="mt-6 inline-flex">
          <Button>
            <ArrowLeft data-icon="inline-start" />
            Return to workspace
          </Button>
        </Link>
      </div>
    </div>
  );
}
