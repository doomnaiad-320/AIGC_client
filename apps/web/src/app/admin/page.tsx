"use client";

import type {
  AdminAgentRun,
  AdminAuditEvent,
  AdminCreditTransaction,
  AdminJob,
  AdminOverview,
  AdminPasswordResetResponse,
  AdminUser,
  AdminUserDetail,
  AdminUserStatus,
  AdminWorkspace,
  AdminWorkspaceDetail,
} from "@loomic/shared";
import {
  Activity,
  ArrowLeft,
  BadgeAlert,
  Bot,
  Building2,
  Check,
  CircleDollarSign,
  ClipboardList,
  Coins,
  Copy,
  Database,
  Eye,
  KeyRound,
  Loader2,
  PauseCircle,
  Pencil,
  RefreshCw,
  Search,
  ShieldCheck,
  ShieldOff,
  Users,
  Workflow,
  X,
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
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
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
  fetchAdminWorkspaceDetail,
  fetchAdminWorkspaces,
  fetchPlatformAdmins,
  grantPlatformAdmin,
  issueAdminPasswordReset,
  revokePlatformAdmin,
  updateAdminUser,
  updateAdminUserStatus,
} from "@/lib/admin-api";
import { useAuth } from "@/lib/auth-context";
import { cn } from "@/lib/utils";

type AdminTab =
  | "users"
  | "workspaces"
  | "jobs"
  | "agent-runs"
  | "ledger"
  | "audit"
  | "platform-admins";

const tabs: Array<{
  id: AdminTab;
  label: string;
  description: string;
  icon: typeof Users;
}> = [
  {
    id: "users",
    label: "Users",
    description: "Manage accounts, workspace access, plans, and balances.",
    icon: Users,
  },
  {
    id: "workspaces",
    label: "Workspaces",
    description:
      "Review workspace ownership, members, projects, plans, and balances.",
    icon: Building2,
  },
  {
    id: "jobs",
    label: "Generation jobs",
    description: "Monitor queued work, execution status, and failures.",
    icon: Workflow,
  },
  {
    id: "agent-runs",
    label: "Agent runs",
    description: "Review agent sessions, models, threads, and runtime errors.",
    icon: Bot,
  },
  {
    id: "ledger",
    label: "Credit ledger",
    description: "Review grants, usage, refunds, and manual adjustments.",
    icon: Coins,
  },
  {
    id: "audit",
    label: "Audit log",
    description: "Track sensitive administrator actions and their targets.",
    icon: ClipboardList,
  },
  {
    id: "platform-admins",
    label: "Administrators",
    description:
      "Manage platform-level access separately from workspace roles.",
    icon: ShieldCheck,
  },
];

export default function AdminPage() {
  const { session, loading } = useAuth();
  const router = useRouter();
  const tokenRef = useRef(session?.access_token);
  tokenRef.current = session?.access_token;

  const [tab, setTab] = useState<AdminTab>("users");
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [workspaces, setWorkspaces] = useState<AdminWorkspace[]>([]);
  const [jobs, setJobs] = useState<AdminJob[]>([]);
  const [agentRuns, setAgentRuns] = useState<AdminAgentRun[]>([]);
  const [transactions, setTransactions] = useState<AdminCreditTransaction[]>(
    [],
  );
  const [events, setEvents] = useState<AdminAuditEvent[]>([]);
  const [platformAdmins, setPlatformAdmins] = useState<
    Awaited<ReturnType<typeof fetchPlatformAdmins>>["administrators"]
  >([]);
  const [search, setSearch] = useState("");
  const [userStatusFilter, setUserStatusFilter] = useState<
    AdminUserStatus | "all"
  >("all");
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
  const [selectedWorkspaceDetail, setSelectedWorkspaceDetail] =
    useState<AdminWorkspaceDetail | null>(null);
  const [loadingWorkspaceDetail, setLoadingWorkspaceDetail] = useState(false);
  const [workspaceDetailError, setWorkspaceDetailError] = useState<
    string | null
  >(null);
  const [editingUser, setEditingUser] = useState<AdminUser | null>(null);
  const [editDisplayName, setEditDisplayName] = useState("");
  const [editEmail, setEditEmail] = useState("");
  const [editReason, setEditReason] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const [statusUser, setStatusUser] = useState<AdminUser | null>(null);
  const [statusReason, setStatusReason] = useState("");
  const [statusError, setStatusError] = useState<string | null>(null);
  const [savingStatus, setSavingStatus] = useState(false);
  const [resetUser, setResetUser] = useState<AdminUser | null>(null);
  const [resetReason, setResetReason] = useState("");
  const [resetError, setResetError] = useState<string | null>(null);
  const [savingReset, setSavingReset] = useState(false);
  const [resetResult, setResetResult] =
    useState<AdminPasswordResetResponse | null>(null);
  const [adminMutationUser, setAdminMutationUser] = useState<AdminUser | null>(
    null,
  );
  const [adminMutationReason, setAdminMutationReason] = useState("");
  const [adminMutationError, setAdminMutationError] = useState<string | null>(
    null,
  );
  const [savingAdminMutation, setSavingAdminMutation] = useState(false);

  const load = useCallback(async (searchValue = "", statusValue = "all") => {
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
        workspacesData,
        jobsData,
        agentRunData,
        transactionData,
        eventData,
        platformAdminData,
      ] = await Promise.all([
        fetchAdminOverview(token),
        fetchAdminUsers(
          token,
          searchValue,
          statusValue === "all" ? "" : statusValue,
        ),
        fetchAdminWorkspaces(token),
        fetchAdminJobs(token),
        fetchAdminAgentRuns(token),
        fetchAdminTransactions(token),
        fetchAdminAuditEvents(token),
        fetchPlatformAdmins(token),
      ]);
      setOverview(overviewData.overview);
      setUsers(usersData.users);
      setWorkspaces(workspacesData.workspaces);
      setJobs(jobsData.jobs);
      setAgentRuns(agentRunData.runs);
      setTransactions(transactionData.transactions);
      setEvents(eventData.events);
      setPlatformAdmins(platformAdminData.administrators);
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
      if (session?.access_token) void load(search, userStatusFilter);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [load, search, session?.access_token, userStatusFilter]);

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
      workspaces: [],
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

  async function openWorkspaceDetail(workspace: AdminWorkspace) {
    const token = tokenRef.current;
    if (!token) return;
    setLoadingWorkspaceDetail(true);
    setWorkspaceDetailError(null);
    setSelectedWorkspaceDetail({ members: [], projects: [], workspace });
    try {
      const { detail } = await fetchAdminWorkspaceDetail(token, workspace.id);
      setSelectedWorkspaceDetail(detail);
    } catch (detailError) {
      setWorkspaceDetailError(
        detailError instanceof Error
          ? detailError.message
          : "Unable to load workspace detail.",
      );
    } finally {
      setLoadingWorkspaceDetail(false);
    }
  }

  function openEditUser(user: AdminUser) {
    setEditingUser(user);
    setEditDisplayName(user.displayName);
    setEditEmail(user.email);
    setEditReason("");
    setEditError(null);
  }

  function closeEditUser() {
    setEditingUser(null);
    setEditDisplayName("");
    setEditEmail("");
    setEditReason("");
    setEditError(null);
  }

  async function submitEditUser(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const token = tokenRef.current;
    const target = editingUser;
    if (!token || !target) return;
    if (editReason.trim().length < 3) {
      setEditError("Add a reason for this profile change.");
      return;
    }
    if (!editDisplayName.trim() && !editEmail.trim()) {
      setEditError("Enter a display name or email address.");
      return;
    }
    setSavingEdit(true);
    setEditError(null);
    try {
      const result = await updateAdminUser(token, target.id, {
        ...(editDisplayName.trim()
          ? { displayName: editDisplayName.trim() }
          : {}),
        ...(editEmail.trim() ? { email: editEmail.trim() } : {}),
        reason: editReason.trim(),
      });
      setSelectedUserDetail(result.detail);
      closeEditUser();
      await load(search, userStatusFilter);
    } catch (saveError) {
      setEditError(
        saveError instanceof Error
          ? saveError.message
          : "Unable to update this user.",
      );
    } finally {
      setSavingEdit(false);
    }
  }

  function openStatusUser(user: AdminUser) {
    setStatusUser(user);
    setStatusReason("");
    setStatusError(null);
  }

  function closeStatusUser() {
    setStatusUser(null);
    setStatusReason("");
    setStatusError(null);
  }

  async function submitUserStatus(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const token = tokenRef.current;
    const target = statusUser;
    if (!token || !target) return;
    if (statusReason.trim().length < 3) {
      setStatusError("Add a reason for this status change.");
      return;
    }
    setSavingStatus(true);
    setStatusError(null);
    try {
      const result = await updateAdminUserStatus(token, target.id, {
        reason: statusReason.trim(),
        status: target.status === "active" ? "suspended" : "active",
      });
      setSelectedUserDetail(result.detail);
      closeStatusUser();
      await load(search, userStatusFilter);
    } catch (saveError) {
      setStatusError(
        saveError instanceof Error
          ? saveError.message
          : "Unable to update this user status.",
      );
    } finally {
      setSavingStatus(false);
    }
  }

  function openResetUser(user: AdminUser) {
    setResetUser(user);
    setResetReason("");
    setResetError(null);
  }

  function closeResetUser() {
    setResetUser(null);
    setResetReason("");
    setResetError(null);
  }

  async function submitPasswordReset(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const token = tokenRef.current;
    const target = resetUser;
    if (!token || !target) return;
    if (resetReason.trim().length < 3) {
      setResetError("Add a reason for issuing this reset.");
      return;
    }
    setSavingReset(true);
    setResetError(null);
    try {
      const result = await issueAdminPasswordReset(token, target.id, {
        reason: resetReason.trim(),
      });
      closeResetUser();
      setResetResult(result);
      await load(search, userStatusFilter);
    } catch (saveError) {
      setResetError(
        saveError instanceof Error
          ? saveError.message
          : "Unable to issue a password reset.",
      );
    } finally {
      setSavingReset(false);
    }
  }

  function openPlatformAdminMutation(user: AdminUser) {
    setAdminMutationUser(user);
    setAdminMutationReason("");
    setAdminMutationError(null);
  }

  function closePlatformAdminMutation() {
    setAdminMutationUser(null);
    setAdminMutationReason("");
    setAdminMutationError(null);
  }

  async function submitPlatformAdminMutation(
    event: React.FormEvent<HTMLFormElement>,
  ) {
    event.preventDefault();
    const token = tokenRef.current;
    const target = adminMutationUser;
    if (!token || !target) return;
    if (adminMutationReason.trim().length < 3) {
      setAdminMutationError("Add a reason for this access change.");
      return;
    }
    setSavingAdminMutation(true);
    setAdminMutationError(null);
    try {
      const input = { reason: adminMutationReason.trim() };
      if (target.isPlatformAdmin) {
        await revokePlatformAdmin(token, target.id, input);
      } else {
        await grantPlatformAdmin(token, target.id, input);
      }
      closePlatformAdminMutation();
      await load(search, userStatusFilter);
      if (selectedUserDetail?.user.id === target.id) {
        const { detail } = await fetchAdminUserDetail(token, target.id);
        setSelectedUserDetail(detail);
      }
    } catch (saveError) {
      setAdminMutationError(
        saveError instanceof Error
          ? saveError.message
          : "Unable to update platform access.",
      );
    } finally {
      setSavingAdminMutation(false);
    }
  }

  function closeAdjustmentDialog() {
    setAdjustingUser(null);
    setAdjustmentAmount("");
    setAdjustmentReason("");
    setAdjustmentError(null);
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
      closeAdjustmentDialog();
      await load(search, userStatusFilter);
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

  const activeTab = tabs.find((item) => item.id === tab);

  return (
    <div className="min-h-screen bg-muted/30 text-foreground">
      <div className="flex min-h-screen">
        <aside className="hidden w-64 shrink-0 flex-col border-r bg-background px-3 py-4 lg:flex">
          <Link
            href="/admin"
            className="flex h-10 items-center gap-3 px-3"
            aria-label="Admin Console home"
          >
            <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <ShieldCheck className="size-4" />
            </span>
            <span className="text-sm font-semibold">Loomic Admin</span>
          </Link>
          <div className="mt-6 space-y-1">
            {tabs.map((item) => {
              const Icon = item.icon;
              const selected = tab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setTab(item.id)}
                  className={cn(
                    "flex h-9 w-full items-center gap-3 rounded-md px-3 text-left text-sm transition-colors",
                    selected
                      ? "bg-muted font-medium text-foreground"
                      : "text-muted-foreground hover:bg-muted/70 hover:text-foreground",
                  )}
                >
                  <Icon className="size-4" />
                  {item.label}
                </button>
              );
            })}
          </div>
          <div className="mt-auto border-t pt-3">
            <Link
              href="/home"
              className="flex h-9 items-center gap-2 rounded-md px-3 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <ArrowLeft className="size-4" />
              Return to workspace
            </Link>
          </div>
        </aside>

        <main className="mx-auto min-w-0 max-w-[1600px] flex-1 px-4 py-5 sm:px-6 lg:px-8">
          <header className="flex min-h-14 flex-wrap items-center justify-between gap-4 border-b pb-5">
            <div>
              <h1 className="text-xl font-semibold">
                {activeTab?.label ?? "Users"}
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">
                {activeTab?.description ??
                  "Manage accounts, workspace access, plans, and balances."}
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
                onClick={() => void load(search, userStatusFilter)}
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
            className="mt-4 flex gap-1 overflow-x-auto border-b lg:hidden"
            aria-label="Admin sections"
          >
            {tabs.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setTab(item.id)}
                  className={cn(
                    "flex h-10 shrink-0 items-center gap-2 border-b-2 px-3 text-sm",
                    tab === item.id
                      ? "border-foreground font-medium text-foreground"
                      : "border-transparent text-muted-foreground",
                  )}
                >
                  <Icon className="size-4" />
                  {item.label}
                </button>
              );
            })}
          </nav>

          {error && (
            <div
              className="mt-5 flex items-start gap-3 rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive"
              role="alert"
            >
              <BadgeAlert className="mt-0.5 size-4 shrink-0" />
              <div>{error}</div>
            </div>
          )}

          <section
            className="mt-6 grid grid-cols-2 gap-3 xl:grid-cols-4"
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

          <section className="mt-6 overflow-hidden rounded-lg border bg-background">
            {tab === "users" && (
              <UsersTable
                users={users}
                loading={loadingData}
                search={search}
                onSearchChange={setSearch}
                statusFilter={userStatusFilter}
                onStatusFilterChange={setUserStatusFilter}
                onView={(user) => void openUserDetail(user)}
                onAdjust={(user) => {
                  setAdjustmentError(null);
                  setAdjustingUser(user);
                }}
                onEdit={openEditUser}
                onStatus={openStatusUser}
                onReset={openResetUser}
                onAdmin={openPlatformAdminMutation}
              />
            )}
            {tab === "workspaces" && (
              <WorkspacesTable
                workspaces={workspaces}
                loading={loadingData}
                onView={(workspace) => void openWorkspaceDetail(workspace)}
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
            {tab === "platform-admins" && (
              <PlatformAdminsTable
                administrators={platformAdmins}
                loading={loadingData}
                onRevoke={(administrator) => {
                  const user = users.find(
                    (item) => item.id === administrator.userId,
                  );
                  openPlatformAdminMutation(
                    user ?? {
                      balance: 0,
                      createdAt: administrator.createdAt,
                      displayName: administrator.displayName,
                      email: administrator.email,
                      id: administrator.userId,
                      isPlatformAdmin: true,
                      lastSignInAt: null,
                      plan: "free",
                      status: "active",
                      statusChangedAt: null,
                      statusReason: null,
                      workspaceId: null,
                      workspaceName: null,
                    },
                  );
                }}
              />
            )}
          </section>
        </main>
      </div>

      <Dialog
        open={Boolean(adjustingUser)}
        onOpenChange={(open) => !open && closeAdjustmentDialog()}
      >
        <DialogContent className="gap-0 rounded-lg p-0 sm:max-w-lg">
          <form onSubmit={submitAdjustment}>
            <DialogHeader className="border-b px-6 py-5 pr-14">
              <DialogTitle>Adjust credits</DialogTitle>
              <DialogDescription>
                Create an audited balance adjustment for this user.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-5 px-6 py-5">
              <div className="flex items-center justify-between rounded-md border bg-muted/40 px-3 py-2.5">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">
                    {adjustingUser?.email}
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    Current balance
                  </div>
                </div>
                <div className="font-medium tabular-nums">
                  {adjustingUser?.balance.toLocaleString() ?? 0}
                </div>
              </div>
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
                <p
                  className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
                  role="alert"
                >
                  {adjustmentError}
                </p>
              )}
            </div>
            <DialogFooter className="mx-0 mb-0 mt-0 rounded-b-lg px-6 py-4">
              <Button
                type="button"
                variant="outline"
                onClick={closeAdjustmentDialog}
                disabled={savingAdjustment}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={savingAdjustment}>
                {savingAdjustment && (
                  <Loader2 data-icon="inline-start" className="animate-spin" />
                )}
                Apply adjustment
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <EditUserDialog
        user={editingUser}
        displayName={editDisplayName}
        email={editEmail}
        reason={editReason}
        error={editError}
        saving={savingEdit}
        onDisplayNameChange={setEditDisplayName}
        onEmailChange={setEditEmail}
        onReasonChange={setEditReason}
        onClose={closeEditUser}
        onSubmit={submitEditUser}
      />

      <UserStatusDialog
        user={statusUser}
        reason={statusReason}
        error={statusError}
        saving={savingStatus}
        onReasonChange={setStatusReason}
        onClose={closeStatusUser}
        onSubmit={submitUserStatus}
      />

      <PasswordResetDialog
        user={resetUser}
        reason={resetReason}
        error={resetError}
        saving={savingReset}
        onReasonChange={setResetReason}
        onClose={closeResetUser}
        onSubmit={submitPasswordReset}
      />

      <PasswordResetResultDialog
        result={resetResult}
        onClose={() => setResetResult(null)}
      />

      <PlatformAdminDialog
        user={adminMutationUser}
        reason={adminMutationReason}
        error={adminMutationError}
        saving={savingAdminMutation}
        onReasonChange={setAdminMutationReason}
        onClose={closePlatformAdminMutation}
        onSubmit={submitPlatformAdminMutation}
      />

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
        onEdit={openEditUser}
        onStatus={openStatusUser}
        onReset={openResetUser}
        onAdmin={openPlatformAdminMutation}
      />

      <WorkspaceDetailDialog
        detail={selectedWorkspaceDetail}
        error={workspaceDetailError}
        loading={loadingWorkspaceDetail}
        onClose={() => {
          setSelectedWorkspaceDetail(null);
          setWorkspaceDetailError(null);
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
    <div className="min-w-0 rounded-lg border bg-background p-4">
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <Icon
          className={cn(
            "size-3.5",
            alert ? "text-destructive" : "text-muted-foreground",
          )}
        />
        <span className="truncate">{label}</span>
      </div>
      <div className="mt-2 text-2xl font-semibold tabular-nums">
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
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold">{title}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>
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
  statusFilter,
  onStatusFilterChange,
  onView,
  onAdjust,
  onEdit,
  onStatus,
  onReset,
  onAdmin,
}: {
  users: AdminUser[];
  loading: boolean;
  search: string;
  onSearchChange: (value: string) => void;
  statusFilter: AdminUserStatus | "all";
  onStatusFilterChange: (value: AdminUserStatus | "all") => void;
  onView: (user: AdminUser) => void;
  onAdjust: (user: AdminUser) => void;
  onEdit: (user: AdminUser) => void;
  onStatus: (user: AdminUser) => void;
  onReset: (user: AdminUser) => void;
  onAdmin: (user: AdminUser) => void;
}) {
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold">All users</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Account, subscription, balance, and platform access.
          </p>
        </div>
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          <select
            aria-label="Filter users by status"
            className="h-9 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            onChange={(event) =>
              onStatusFilterChange(
                event.target.value as AdminUserStatus | "all",
              )
            }
            value={statusFilter}
          >
            <option value="all">All statuses</option>
            <option value="active">Active</option>
            <option value="suspended">Suspended</option>
            <option value="disabled">Disabled</option>
          </select>
          <div className="relative w-full sm:w-72">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              aria-label="Search users"
              className="pl-9"
              onChange={(event) => onSearchChange(event.target.value)}
              placeholder="Search name or email"
              value={search}
            />
          </div>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[980px] text-left text-sm">
          <thead className="border-b bg-muted/50 text-xs text-muted-foreground">
            <tr>
              <th className="px-5 py-3 font-medium">User</th>
              <th className="px-5 py-3 font-medium">Workspace</th>
              <th className="px-5 py-3 font-medium">Plan</th>
              <th className="px-5 py-3 font-medium">Balance</th>
              <th className="px-5 py-3 font-medium">Status</th>
              <th className="px-5 py-3 font-medium">Last sign-in</th>
              <th className="px-5 py-3 text-right font-medium">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {loading ? (
              <LoadingRows columns={7} />
            ) : users.length === 0 ? (
              <EmptyRow columns={7} label="No users match this search." />
            ) : (
              users.map((user) => (
                <tr key={user.id} className="hover:bg-muted/40">
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-3">
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold text-muted-foreground">
                        {initials(user.displayName, user.email)}
                      </span>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 font-medium">
                          <span className="truncate">{user.displayName}</span>
                          {user.isPlatformAdmin && (
                            <ShieldCheck
                              className="size-3.5 text-foreground"
                              aria-label="Platform admin"
                            />
                          )}
                        </div>
                        <div className="max-w-52 truncate text-xs text-muted-foreground">
                          {user.email}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="px-5 py-3 text-muted-foreground">
                    {user.workspaceName ?? "—"}
                  </td>
                  <td className="px-5 py-3">
                    <PlanBadge plan={user.plan} />
                  </td>
                  <td className="px-5 py-3 font-medium tabular-nums">
                    {user.balance.toLocaleString()}
                  </td>
                  <td className="px-5 py-3">
                    <UserStatusBadge status={user.status} />
                  </td>
                  <td className="px-5 py-3 text-muted-foreground">
                    {user.lastSignInAt
                      ? formatDate(user.lastSignInAt)
                      : "Never"}
                  </td>
                  <td className="px-5 py-3 text-right">
                    <div className="flex justify-end gap-1">
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        onClick={() => onView(user)}
                        aria-label="View user details"
                        title="View details"
                      >
                        <Eye />
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        onClick={() => onEdit(user)}
                        aria-label="Edit user"
                        title="Edit user"
                      >
                        <Pencil />
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        onClick={() => onStatus(user)}
                        aria-label={
                          user.status === "active"
                            ? "Suspend user"
                            : "Reactivate user"
                        }
                        title={
                          user.status === "active"
                            ? "Suspend user"
                            : "Reactivate user"
                        }
                      >
                        {user.status === "active" ? <PauseCircle /> : <Check />}
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        onClick={() => onReset(user)}
                        aria-label="Reset user password"
                        title="Reset password"
                      >
                        <KeyRound />
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        onClick={() => onAdmin(user)}
                        aria-label={
                          user.isPlatformAdmin
                            ? "Revoke platform administrator"
                            : "Grant platform administrator"
                        }
                        title={
                          user.isPlatformAdmin
                            ? "Revoke platform admin"
                            : "Grant platform admin"
                        }
                      >
                        {user.isPlatformAdmin ? <ShieldOff /> : <ShieldCheck />}
                      </Button>
                      {user.workspaceId ? (
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          onClick={() => onAdjust(user)}
                          aria-label="Adjust user credits"
                          title="Adjust credits"
                        >
                          <Coins />
                        </Button>
                      ) : (
                        <span className="px-2 text-xs text-muted-foreground">
                          —
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

function WorkspacesTable({
  workspaces,
  loading,
  onView,
}: {
  workspaces: AdminWorkspace[];
  loading: boolean;
  onView: (workspace: AdminWorkspace) => void;
}) {
  return (
    <TableFrame
      title="All workspaces"
      subtitle="Ownership, membership, projects, subscriptions, and balances."
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[900px] text-left text-sm">
          <thead className="border-b bg-muted/50 text-xs text-muted-foreground">
            <tr>
              <th className="px-5 py-3 font-medium">Workspace</th>
              <th className="px-5 py-3 font-medium">Owner</th>
              <th className="px-5 py-3 font-medium">Type</th>
              <th className="px-5 py-3 font-medium">Members</th>
              <th className="px-5 py-3 font-medium">Projects</th>
              <th className="px-5 py-3 font-medium">Plan</th>
              <th className="px-5 py-3 font-medium">Balance</th>
              <th className="px-5 py-3 text-right font-medium">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {loading ? (
              <LoadingRows columns={8} />
            ) : workspaces.length === 0 ? (
              <EmptyRow columns={8} label="No workspaces found." />
            ) : (
              workspaces.map((workspace) => (
                <tr key={workspace.id} className="hover:bg-muted/40">
                  <td className="px-5 py-3">
                    <div className="font-medium">{workspace.name}</div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      Created {formatDate(workspace.createdAt)}
                    </div>
                  </td>
                  <td className="px-5 py-3">
                    <div className="font-medium">
                      {workspace.ownerDisplayName}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {workspace.ownerEmail}
                    </div>
                  </td>
                  <td className="px-5 py-3 capitalize text-muted-foreground">
                    {workspace.type}
                  </td>
                  <td className="px-5 py-3 tabular-nums">
                    {workspace.memberCount}
                  </td>
                  <td className="px-5 py-3 tabular-nums">
                    {workspace.projectCount}
                  </td>
                  <td className="px-5 py-3">
                    <PlanBadge plan={workspace.plan} />
                  </td>
                  <td className="px-5 py-3 font-medium tabular-nums">
                    {workspace.balance.toLocaleString()}
                  </td>
                  <td className="px-5 py-3 text-right">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => onView(workspace)}
                    >
                      <Eye data-icon="inline-start" />
                      View
                    </Button>
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

type PlatformAdminRow = Awaited<
  ReturnType<typeof fetchPlatformAdmins>
>["administrators"][number];

function PlatformAdminsTable({
  administrators,
  loading,
  onRevoke,
}: {
  administrators: PlatformAdminRow[];
  loading: boolean;
  onRevoke: (administrator: PlatformAdminRow) => void;
}) {
  return (
    <TableFrame
      title="Platform administrators"
      subtitle="Platform access is separate from workspace owner and admin roles."
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[680px] text-left text-sm">
          <thead className="border-b bg-muted/50 text-xs text-muted-foreground">
            <tr>
              <th className="px-5 py-3 font-medium">Administrator</th>
              <th className="px-5 py-3 font-medium">Granted</th>
              <th className="px-5 py-3 font-medium">Granted by</th>
              <th className="px-5 py-3 text-right font-medium">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {loading ? (
              <LoadingRows columns={4} />
            ) : administrators.length === 0 ? (
              <EmptyRow columns={4} label="No platform administrators found." />
            ) : (
              administrators.map((administrator) => (
                <tr key={administrator.userId} className="hover:bg-muted/40">
                  <td className="px-5 py-3">
                    <div className="font-medium">
                      {administrator.displayName}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {administrator.email}
                    </div>
                  </td>
                  <td className="px-5 py-3 text-muted-foreground">
                    {formatDate(administrator.createdAt)}
                  </td>
                  <td className="px-5 py-3 text-muted-foreground">
                    {administrator.createdByEmail ?? "System"}
                  </td>
                  <td className="px-5 py-3 text-right">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => onRevoke(administrator)}
                    >
                      <ShieldOff data-icon="inline-start" />
                      Revoke
                    </Button>
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

function JobsTable({ jobs, loading }: { jobs: AdminJob[]; loading: boolean }) {
  return (
    <TableFrame
      title="Generation jobs"
      subtitle="Queue health and recent execution results."
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead className="border-b bg-muted/50 text-xs text-muted-foreground">
            <tr>
              <th className="px-5 py-3 font-medium">Status</th>
              <th className="px-5 py-3 font-medium">Type</th>
              <th className="px-5 py-3 font-medium">User</th>
              <th className="px-5 py-3 font-medium">Workspace</th>
              <th className="px-5 py-3 font-medium">Created</th>
              <th className="px-5 py-3 font-medium">Failure</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {loading ? (
              <LoadingRows columns={6} />
            ) : jobs.length === 0 ? (
              <EmptyRow columns={6} label="No generation jobs recorded yet." />
            ) : (
              jobs.map((job) => (
                <tr key={job.id} className="hover:bg-muted/40">
                  <td className="px-5 py-3">
                    <StatusBadge status={job.status} />
                  </td>
                  <td className="px-5 py-3 font-medium">
                    {job.jobType.replace(/_/g, " ")}
                  </td>
                  <td className="px-5 py-3 text-muted-foreground">
                    {job.userEmail ?? "—"}
                  </td>
                  <td className="px-5 py-3 text-muted-foreground">
                    {job.workspaceName ?? "—"}
                  </td>
                  <td className="px-5 py-3 text-muted-foreground">
                    {formatDate(job.createdAt)}
                  </td>
                  <td
                    className="max-w-64 truncate px-5 py-3 text-destructive"
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
          <thead className="border-b bg-muted/50 text-xs text-muted-foreground">
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
          <tbody className="divide-y">
            {loading ? (
              <LoadingRows columns={7} />
            ) : runs.length === 0 ? (
              <EmptyRow columns={7} label="No agent runs recorded yet." />
            ) : (
              runs.map((run) => (
                <tr key={run.id} className="hover:bg-muted/40">
                  <td className="px-5 py-3">
                    <StatusBadge status={run.status} />
                  </td>
                  <td className="px-5 py-3">
                    <div className="font-medium">
                      {run.sessionTitle ?? "Untitled session"}
                    </div>
                    <div className="max-w-56 truncate text-xs text-muted-foreground">
                      {run.threadId}
                    </div>
                  </td>
                  <td className="px-5 py-3 text-muted-foreground">
                    {run.userEmail ?? "—"}
                  </td>
                  <td className="px-5 py-3">
                    <div className="text-muted-foreground">
                      {run.workspaceName ?? "—"}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {run.projectName ?? run.canvasName ?? "—"}
                    </div>
                  </td>
                  <td className="px-5 py-3 text-muted-foreground">
                    {run.model ?? "—"}
                  </td>
                  <td className="px-5 py-3 text-muted-foreground">
                    {formatDate(run.createdAt)}
                  </td>
                  <td
                    className="max-w-72 truncate px-5 py-3 text-destructive"
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
          <thead className="border-b bg-muted/50 text-xs text-muted-foreground">
            <tr>
              <th className="px-5 py-3 font-medium">Type</th>
              <th className="px-5 py-3 font-medium">User</th>
              <th className="px-5 py-3 font-medium">Amount</th>
              <th className="px-5 py-3 font-medium">Balance after</th>
              <th className="px-5 py-3 font-medium">Reason</th>
              <th className="px-5 py-3 font-medium">Time</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {loading ? (
              <LoadingRows columns={6} />
            ) : transactions.length === 0 ? (
              <EmptyRow columns={6} label="No credit activity recorded yet." />
            ) : (
              transactions.map((item) => (
                <tr key={item.id} className="hover:bg-muted/40">
                  <td className="px-5 py-3">
                    <span className="capitalize text-muted-foreground">
                      {item.transactionType.replace(/_/g, " ")}
                    </span>
                  </td>
                  <td className="px-5 py-3 text-muted-foreground">
                    {item.userEmail ?? item.workspaceName ?? "—"}
                  </td>
                  <td
                    className={cn(
                      "px-5 py-3 font-semibold tabular-nums",
                      item.amount >= 0
                        ? "text-emerald-700"
                        : "text-destructive",
                    )}
                  >
                    {item.amount >= 0 ? "+" : ""}
                    {item.amount.toLocaleString()}
                  </td>
                  <td className="px-5 py-3 tabular-nums">
                    {item.balanceAfter.toLocaleString()}
                  </td>
                  <td
                    className="max-w-72 truncate px-5 py-3 text-muted-foreground"
                    title={item.description ?? undefined}
                  >
                    {item.description ?? "—"}
                  </td>
                  <td className="px-5 py-3 text-muted-foreground">
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
          <thead className="border-b bg-muted/50 text-xs text-muted-foreground">
            <tr>
              <th className="px-5 py-3 font-medium">Action</th>
              <th className="px-5 py-3 font-medium">Operator</th>
              <th className="px-5 py-3 font-medium">Target</th>
              <th className="px-5 py-3 font-medium">Details</th>
              <th className="px-5 py-3 font-medium">Time</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {loading ? (
              <LoadingRows columns={5} />
            ) : events.length === 0 ? (
              <EmptyRow
                columns={5}
                label="No administrator actions recorded yet."
              />
            ) : (
              events.map((event) => (
                <tr key={event.id} className="hover:bg-muted/40">
                  <td className="px-5 py-3 font-medium">{event.action}</td>
                  <td className="px-5 py-3 text-muted-foreground">
                    {event.actorEmail}
                  </td>
                  <td className="px-5 py-3 text-muted-foreground">
                    {event.targetEmail ?? event.workspaceName ?? "—"}
                  </td>
                  <td
                    className="max-w-72 truncate px-5 py-3 text-muted-foreground"
                    title={JSON.stringify(event.metadata)}
                  >
                    {auditSummary(event.metadata)}
                  </td>
                  <td className="px-5 py-3 text-muted-foreground">
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

function EditUserDialog({
  user,
  displayName,
  email,
  reason,
  error,
  saving,
  onDisplayNameChange,
  onEmailChange,
  onReasonChange,
  onClose,
  onSubmit,
}: {
  user: AdminUser | null;
  displayName: string;
  email: string;
  reason: string;
  error: string | null;
  saving: boolean;
  onDisplayNameChange: (value: string) => void;
  onEmailChange: (value: string) => void;
  onReasonChange: (value: string) => void;
  onClose: () => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <Dialog open={Boolean(user)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="gap-0 rounded-lg p-0 sm:max-w-lg">
        <form onSubmit={onSubmit}>
          <DialogHeader className="border-b px-6 py-5 pr-14">
            <DialogTitle>Edit user</DialogTitle>
            <DialogDescription>
              Update account identity details for {user?.email ?? "this user"}.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 px-6 py-5">
            <div className="space-y-2">
              <Label htmlFor="admin-edit-display-name">Display name</Label>
              <Input
                id="admin-edit-display-name"
                maxLength={80}
                onChange={(event) => onDisplayNameChange(event.target.value)}
                value={displayName}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="admin-edit-email">Email</Label>
              <Input
                id="admin-edit-email"
                maxLength={320}
                onChange={(event) => onEmailChange(event.target.value)}
                type="email"
                value={email}
              />
            </div>
            <ReasonField
              id="admin-edit-reason"
              value={reason}
              onChange={onReasonChange}
            />
            {error && <FormError message={error} />}
          </div>
          <DialogFooter className="mx-0 mb-0 mt-0 rounded-b-lg px-6 py-4">
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving && (
                <Loader2 data-icon="inline-start" className="animate-spin" />
              )}
              Save changes
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function UserStatusDialog({
  user,
  reason,
  error,
  saving,
  onReasonChange,
  onClose,
  onSubmit,
}: {
  user: AdminUser | null;
  reason: string;
  error: string | null;
  saving: boolean;
  onReasonChange: (value: string) => void;
  onClose: () => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
}) {
  const nextStatus = user?.status === "active" ? "suspend" : "reactivate";
  return (
    <Dialog open={Boolean(user)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="gap-0 rounded-lg p-0 sm:max-w-lg">
        <form onSubmit={onSubmit}>
          <DialogHeader className="border-b px-6 py-5 pr-14">
            <DialogTitle>
              {nextStatus === "suspend" ? "Suspend user" : "Reactivate user"}
            </DialogTitle>
            <DialogDescription>
              {nextStatus === "suspend"
                ? "This account will lose access immediately and cannot sign in."
                : "This account will be allowed to sign in again."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 px-6 py-5">
            <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
              <div className="font-medium">{user?.displayName}</div>
              <div className="text-xs text-muted-foreground">{user?.email}</div>
            </div>
            <ReasonField
              id="admin-status-reason"
              value={reason}
              onChange={onReasonChange}
            />
            {error && <FormError message={error} />}
          </div>
          <DialogFooter className="mx-0 mb-0 mt-0 rounded-b-lg px-6 py-4">
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant={nextStatus === "suspend" ? "destructive" : "default"}
              disabled={saving}
            >
              {saving && (
                <Loader2 data-icon="inline-start" className="animate-spin" />
              )}
              {nextStatus === "suspend" ? "Suspend user" : "Reactivate user"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function PasswordResetDialog({
  user,
  reason,
  error,
  saving,
  onReasonChange,
  onClose,
  onSubmit,
}: {
  user: AdminUser | null;
  reason: string;
  error: string | null;
  saving: boolean;
  onReasonChange: (value: string) => void;
  onClose: () => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <Dialog open={Boolean(user)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="gap-0 rounded-lg p-0 sm:max-w-lg">
        <form onSubmit={onSubmit}>
          <DialogHeader className="border-b px-6 py-5 pr-14">
            <DialogTitle>Reset password</DialogTitle>
            <DialogDescription>
              Issue a one-time reset token. The current password is never shown.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 px-6 py-5">
            <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
              <div className="font-medium">{user?.displayName}</div>
              <div className="text-xs text-muted-foreground">{user?.email}</div>
            </div>
            <ReasonField
              id="admin-reset-reason"
              value={reason}
              onChange={onReasonChange}
            />
            {error && <FormError message={error} />}
          </div>
          <DialogFooter className="mx-0 mb-0 mt-0 rounded-b-lg px-6 py-4">
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving && (
                <Loader2 data-icon="inline-start" className="animate-spin" />
              )}
              Issue reset token
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function PasswordResetResultDialog({
  result,
  onClose,
}: {
  result: AdminPasswordResetResponse | null;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  async function copyToken() {
    if (!result) return;
    await navigator.clipboard.writeText(result.resetToken);
    setCopied(true);
  }
  return (
    <Dialog open={Boolean(result)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="gap-0 rounded-lg p-0 sm:max-w-lg">
        <DialogHeader className="border-b px-6 py-5 pr-14">
          <DialogTitle>Reset token created</DialogTitle>
          <DialogDescription>
            This token is shown once and expires at{" "}
            {result ? formatDate(result.expiresAt) : "—"}.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 px-6 py-5">
          <Label htmlFor="admin-reset-token">One-time token</Label>
          <div className="flex gap-2">
            <Input
              id="admin-reset-token"
              readOnly
              value={result?.resetToken ?? ""}
            />
            <Button
              type="button"
              size="icon"
              variant="outline"
              onClick={() => void copyToken()}
              title="Copy reset token"
              aria-label="Copy reset token"
            >
              {copied ? <Check /> : <Copy />}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Deliver this token through your approved support channel. It cannot
            be recovered after closing this dialog.
          </p>
        </div>
        <DialogFooter className="mx-0 mb-0 mt-0 rounded-b-lg px-6 py-4">
          <Button type="button" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PlatformAdminDialog({
  user,
  reason,
  error,
  saving,
  onReasonChange,
  onClose,
  onSubmit,
}: {
  user: AdminUser | null;
  reason: string;
  error: string | null;
  saving: boolean;
  onReasonChange: (value: string) => void;
  onClose: () => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
}) {
  const revoke = user?.isPlatformAdmin ?? false;
  return (
    <Dialog open={Boolean(user)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="gap-0 rounded-lg p-0 sm:max-w-lg">
        <form onSubmit={onSubmit}>
          <DialogHeader className="border-b px-6 py-5 pr-14">
            <DialogTitle>
              {revoke ? "Revoke platform access" : "Grant platform access"}
            </DialogTitle>
            <DialogDescription>
              {revoke
                ? "This removes platform administrator access but keeps workspace permissions unchanged."
                : "This gives the user access to the platform administration console."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 px-6 py-5">
            <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
              <div className="font-medium">{user?.displayName}</div>
              <div className="text-xs text-muted-foreground">{user?.email}</div>
            </div>
            <ReasonField
              id="admin-platform-reason"
              value={reason}
              onChange={onReasonChange}
            />
            {error && <FormError message={error} />}
          </div>
          <DialogFooter className="mx-0 mb-0 mt-0 rounded-b-lg px-6 py-4">
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant={revoke ? "destructive" : "default"}
              disabled={saving}
            >
              {saving && (
                <Loader2 data-icon="inline-start" className="animate-spin" />
              )}
              {revoke ? "Revoke access" : "Grant access"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ReasonField({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>Reason</Label>
      <textarea
        id={id}
        className="flex min-h-24 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        maxLength={500}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Explain why this change is needed"
        value={value}
      />
    </div>
  );
}

function FormError({ message }: { message: string }) {
  return (
    <p
      className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
      role="alert"
    >
      {message}
    </p>
  );
}

function UserDetailDialog({
  detail,
  loading,
  error,
  onClose,
  onAdjust,
  onEdit,
  onStatus,
  onReset,
  onAdmin,
}: {
  detail: AdminUserDetail | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onAdjust: (user: AdminUser) => void;
  onEdit: (user: AdminUser) => void;
  onStatus: (user: AdminUser) => void;
  onReset: (user: AdminUser) => void;
  onAdmin: (user: AdminUser) => void;
}) {
  const user = detail?.user;

  return (
    <Sheet open={Boolean(detail)} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>User details</SheetTitle>
          <SheetDescription>
            {user
              ? `${user.displayName} · ${user.email}`
              : "Loading account, workspace, credits, and execution activity."}
          </SheetDescription>
        </SheetHeader>

        <SheetBody>
          {user && (
            <div className="grid grid-cols-2 gap-x-6 gap-y-5 border-b pb-6">
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
              <DetailTile label="Status">
                <UserStatusBadge status={user.status} />
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
              className="mt-5 flex items-start gap-3 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
              role="alert"
            >
              <BadgeAlert className="mt-0.5 size-4 shrink-0" />
              <div>{error}</div>
            </div>
          )}

          {loading && (
            <div
              className="mt-6 space-y-3"
              aria-label="Loading recent activity"
            >
              <div className="h-12 animate-pulse rounded-md bg-muted" />
              <div className="h-12 animate-pulse rounded-md bg-muted" />
              <div className="h-12 animate-pulse rounded-md bg-muted" />
            </div>
          )}

          {detail && !loading && (
            <div className="mt-6 space-y-6">
              <UserWorkspacesPanel workspaces={detail.workspaces} />
              <RecentTransactionsPanel
                transactions={detail.recentTransactions}
              />
              <RecentJobsPanel jobs={detail.recentJobs} />
              <RecentAgentRunsPanel runs={detail.recentAgentRuns} />
            </div>
          )}
        </SheetBody>

        <SheetFooter>
          {user && (
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => onEdit(user)}
              >
                <Pencil data-icon="inline-start" />
                Edit
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => onStatus(user)}
              >
                {user.status === "active" ? (
                  <PauseCircle data-icon="inline-start" />
                ) : (
                  <Check data-icon="inline-start" />
                )}
                {user.status === "active" ? "Suspend" : "Reactivate"}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => onReset(user)}
              >
                <KeyRound data-icon="inline-start" />
                Reset password
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => onAdmin(user)}
              >
                {user.isPlatformAdmin ? (
                  <ShieldOff data-icon="inline-start" />
                ) : (
                  <ShieldCheck data-icon="inline-start" />
                )}
                {user.isPlatformAdmin ? "Revoke admin" : "Grant admin"}
              </Button>
              {user.workspaceId && (
                <Button type="button" onClick={() => onAdjust(user)}>
                  <Coins data-icon="inline-start" />
                  Adjust credits
                </Button>
              )}
            </div>
          )}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

function UserWorkspacesPanel({
  workspaces,
}: {
  workspaces: AdminUserDetail["workspaces"];
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Workspaces</h3>
          <p className="text-xs text-muted-foreground">
            Every workspace this user can access, including their role and
            balance.
          </p>
        </div>
        <span className="text-xs tabular-nums text-muted-foreground">
          {workspaces.length}
        </span>
      </div>
      {workspaces.length === 0 ? (
        <div className="rounded-md border px-3 py-4 text-sm text-muted-foreground">
          No workspace memberships found.
        </div>
      ) : (
        <div className="divide-y rounded-md border">
          {workspaces.map((workspace) => (
            <div
              key={workspace.workspaceId}
              className="flex items-center justify-between gap-4 px-3 py-3"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <span className="truncate">{workspace.workspaceName}</span>
                  {workspace.isOwner && (
                    <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                      Owner
                    </span>
                  )}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                  <span className="capitalize">{workspace.workspaceType}</span>
                  <span aria-hidden="true">·</span>
                  <span className="capitalize">{workspace.role}</span>
                  <span aria-hidden="true">·</span>
                  <span>Joined {formatDate(workspace.joinedAt)}</span>
                </div>
              </div>
              <div className="flex shrink-0 items-end gap-3 text-right">
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    Plan
                  </div>
                  <PlanBadge plan={workspace.plan} />
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    Balance
                  </div>
                  <div className="mt-1 text-sm font-medium tabular-nums">
                    {workspace.balance.toLocaleString()}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function WorkspaceDetailDialog({
  detail,
  loading,
  error,
  onClose,
}: {
  detail: AdminWorkspaceDetail | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
}) {
  const workspace = detail?.workspace;

  return (
    <Sheet open={Boolean(detail)} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>Workspace details</SheetTitle>
          <SheetDescription>
            {workspace
              ? `${workspace.name} · ${workspace.ownerEmail}`
              : "Loading ownership, membership, projects, plan, and balance."}
          </SheetDescription>
        </SheetHeader>
        <SheetBody>
          {workspace && (
            <div className="grid grid-cols-2 gap-x-6 gap-y-5 border-b pb-6">
              <DetailTile label="Type">
                <span className="capitalize">{workspace.type}</span>
              </DetailTile>
              <DetailTile label="Plan">
                <PlanBadge plan={workspace.plan} />
              </DetailTile>
              <DetailTile label="Owner">
                <span className="truncate">{workspace.ownerDisplayName}</span>
              </DetailTile>
              <DetailTile label="Balance">
                <span className="tabular-nums">
                  {workspace.balance.toLocaleString()}
                </span>
              </DetailTile>
              <DetailTile label="Members">{workspace.memberCount}</DetailTile>
              <DetailTile label="Projects">{workspace.projectCount}</DetailTile>
              <DetailTile label="Created">
                {formatDate(workspace.createdAt)}
              </DetailTile>
              <DetailTile label="Workspace ID">
                <span className="truncate text-xs">{workspace.id}</span>
              </DetailTile>
            </div>
          )}

          {error && (
            <div
              className="mt-5 flex items-start gap-3 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
              role="alert"
            >
              <BadgeAlert className="mt-0.5 size-4 shrink-0" />
              <div>{error}</div>
            </div>
          )}

          {loading && (
            <div
              className="mt-6 space-y-3"
              aria-label="Loading workspace detail"
            >
              <div className="h-12 animate-pulse rounded-md bg-muted" />
              <div className="h-12 animate-pulse rounded-md bg-muted" />
            </div>
          )}

          {detail && !loading && (
            <div className="mt-6 space-y-6">
              <section className="space-y-3">
                <div className="flex items-baseline justify-between gap-3">
                  <h3 className="text-sm font-semibold">Members</h3>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {detail.members.length}
                  </span>
                </div>
                {detail.members.length === 0 ? (
                  <div className="rounded-md border px-3 py-4 text-sm text-muted-foreground">
                    No members found.
                  </div>
                ) : (
                  <div className="divide-y rounded-md border">
                    {detail.members.map((member) => (
                      <div
                        key={member.userId}
                        className="flex items-center justify-between gap-4 px-3 py-3"
                      >
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium">
                            {member.displayName}
                          </div>
                          <div className="truncate text-xs text-muted-foreground">
                            {member.email}
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <UserStatusBadge status={member.status} />
                          <span className="rounded bg-muted px-2 py-1 text-xs font-medium capitalize">
                            {member.role}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <section className="space-y-3">
                <div className="flex items-baseline justify-between gap-3">
                  <h3 className="text-sm font-semibold">Projects</h3>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {detail.projects.length}
                  </span>
                </div>
                {detail.projects.length === 0 ? (
                  <div className="rounded-md border px-3 py-4 text-sm text-muted-foreground">
                    No projects found.
                  </div>
                ) : (
                  <div className="divide-y rounded-md border">
                    {detail.projects.map((project) => (
                      <div
                        key={project.id}
                        className="flex items-center justify-between gap-4 px-3 py-3"
                      >
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium">
                            {project.name}
                          </div>
                          <div className="truncate text-xs text-muted-foreground">
                            {project.slug} · {formatDate(project.createdAt)}
                          </div>
                        </div>
                        <div className="shrink-0 text-xs text-muted-foreground">
                          {project.canvasCount}{" "}
                          {project.canvasCount === 1 ? "canvas" : "canvases"}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>
          )}
        </SheetBody>
      </SheetContent>
    </Sheet>
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
    <div className="min-w-0">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="mt-1 min-w-0 text-sm font-medium text-foreground">
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
    <section className="min-w-0">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">{title}</h3>
      </div>
      <div className="mt-2 divide-y rounded-md border">
        {children.length > 0 ? (
          children
        ) : (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
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
            <span className="capitalize text-muted-foreground">
              {item.transactionType.replace(/_/g, " ")}
            </span>
            <span
              className={cn(
                "font-semibold tabular-nums",
                item.amount >= 0 ? "text-emerald-700" : "text-destructive",
              )}
            >
              {item.amount >= 0 ? "+" : ""}
              {item.amount.toLocaleString()}
            </span>
          </div>
          <div className="mt-1 truncate text-xs text-muted-foreground">
            {item.description ?? "No reason recorded"}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
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
          <div className="mt-1 text-xs text-muted-foreground">
            {formatDate(job.createdAt)}
          </div>
          {(job.errorCode || job.errorMessage) && (
            <div
              className="mt-1 truncate text-xs text-destructive"
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
          <div className="mt-1 truncate text-xs text-muted-foreground">
            {run.model ?? "No model"} · {run.threadId}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            {formatDate(run.createdAt)}
            {run.completedAt
              ? ` · Completed ${formatDate(run.completedAt)}`
              : ""}
          </div>
          {(run.errorCode || run.errorMessage) && (
            <div
              className="mt-1 truncate text-xs text-destructive"
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
    <span className="inline-flex rounded-md border bg-muted/50 px-2 py-0.5 text-xs font-medium capitalize text-foreground">
      {plan}
    </span>
  );
}
function StatusBadge({ status }: { status: string }) {
  const tone =
    status === "succeeded" || status === "completed"
      ? "border-transparent bg-emerald-100 text-emerald-800"
      : status === "failed" || status === "dead_letter"
        ? "border-transparent bg-red-100 text-red-800"
        : status === "running"
          ? "border-transparent bg-blue-100 text-blue-800"
          : "border-transparent bg-muted text-muted-foreground";
  return (
    <span
      className={`inline-flex rounded-md border px-2 py-0.5 text-xs font-medium capitalize ${tone}`}
    >
      {status.replace(/_/g, " ")}
    </span>
  );
}

function UserStatusBadge({ status }: { status: AdminUserStatus }) {
  const tone =
    status === "active"
      ? "border-transparent bg-emerald-100 text-emerald-800"
      : status === "suspended"
        ? "border-transparent bg-amber-100 text-amber-800"
        : "border-transparent bg-red-100 text-red-800";
  return (
    <span
      className={`inline-flex rounded-md border px-2 py-0.5 text-xs font-medium capitalize ${tone}`}
    >
      {status}
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
            <div className="h-4 animate-pulse rounded bg-muted" />
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
        className="px-5 py-12 text-center text-sm text-muted-foreground"
      >
        <Database className="mx-auto mb-3 size-5 text-muted-foreground/60" />
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
    <div className="flex min-h-screen items-center justify-center bg-muted/30">
      <div className="flex items-center gap-3 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        Loading Admin Console
      </div>
    </div>
  );
}
function AccessDenied() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 p-6">
      <div className="w-full max-w-md rounded-lg border bg-background p-6 shadow-sm">
        <span className="flex size-10 items-center justify-center rounded-md bg-destructive/10 text-destructive">
          <ShieldCheck className="size-5" />
        </span>
        <h1 className="mt-5 text-xl font-semibold">
          Administrator access required
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
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
