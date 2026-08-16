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
  SubscriptionPlan,
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
  CreditCard,
  Database,
  Eye,
  KeyRound,
  Landmark,
  Loader2,
  PackageOpen,
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
import { BillingPlansPanel } from "./billing-plans-panel";
import { PaymentProvidersPanel } from "./payment-providers-panel";
import { TopUpPacksPanel } from "./top-up-packs-panel";

type AdminTab =
  | "users"
  | "workspaces"
  | "jobs"
  | "agent-runs"
  | "ledger"
  | "billing"
  | "top-up-packs"
  | "payment-providers"
  | "audit"
  | "platform-admins";

type AdminTabItem = {
  id: AdminTab;
  label: string;
  description: string;
  icon: typeof Users;
};

const menuGroups: Array<{
  id: string;
  label: string;
  items: AdminTabItem[];
}> = [
  {
    id: "organization",
    label: "用户与组织",
    items: [
      {
        id: "users",
        label: "用户管理",
        description: "管理用户账号、工作区权限、套餐与点数余额。",
        icon: Users,
      },
      {
        id: "workspaces",
        label: "工作区管理",
        description: "查看工作区归属、成员、项目、套餐与点数余额。",
        icon: Building2,
      },
    ],
  },
  {
    id: "operations",
    label: "运行监控",
    items: [
      {
        id: "jobs",
        label: "生成任务",
        description: "监控任务队列、执行状态与失败原因。",
        icon: Workflow,
      },
      {
        id: "agent-runs",
        label: "智能体运行",
        description: "查看智能体会话、模型、线程与运行错误。",
        icon: Bot,
      },
    ],
  },
  {
    id: "commerce",
    label: "计费与支付",
    items: [
      {
        id: "ledger",
        label: "点数流水",
        description: "查看点数发放、消耗、退还与人工加点记录。",
        icon: Coins,
      },
      {
        id: "billing",
        label: "套餐与计费",
        description: "设置套餐价格、点数、并发与版本化权益。",
        icon: CreditCard,
      },
      {
        id: "top-up-packs",
        label: "点数包",
        description: "配置点数、USD 标价、DuluPay 实收价和可购买套餐。",
        icon: PackageOpen,
      },
      {
        id: "payment-providers",
        label: "支付配置",
        description: "管理 DuluPay 商户、RSA 密钥、支付方式和回调安全。",
        icon: Landmark,
      },
    ],
  },
  {
    id: "governance",
    label: "安全与治理",
    items: [
      {
        id: "audit",
        label: "审计日志",
        description: "追踪管理员的敏感操作及其操作对象。",
        icon: ClipboardList,
      },
      {
        id: "platform-admins",
        label: "平台管理员",
        description: "单独管理平台级权限，与工作区角色明确区分。",
        icon: ShieldCheck,
      },
    ],
  },
];

const tabs = menuGroups.flatMap((group) => group.items);

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
  const [editPlan, setEditPlan] = useState<SubscriptionPlan>("free");
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
          : "无法加载管理后台数据。",
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
          : "无法加载用户详情。",
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
          : "无法加载工作区详情。",
      );
    } finally {
      setLoadingWorkspaceDetail(false);
    }
  }

  function openEditUser(user: AdminUser) {
    setEditingUser(user);
    setEditDisplayName(user.displayName);
    setEditEmail(user.email);
    setEditPlan(user.plan);
    setEditReason("");
    setEditError(null);
  }

  function closeEditUser() {
    setEditingUser(null);
    setEditDisplayName("");
    setEditEmail("");
    setEditPlan("free");
    setEditReason("");
    setEditError(null);
  }

  async function submitEditUser(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const token = tokenRef.current;
    const target = editingUser;
    if (!token || !target) return;
    if (editReason.trim().length < 3) {
      setEditError("请填写本次资料变更的原因。");
      return;
    }
    const profileChanged =
      editDisplayName.trim() !== target.displayName ||
      editEmail.trim().toLowerCase() !== target.email.toLowerCase();
    const planChanged = editPlan !== target.plan;
    if (!profileChanged && !planChanged) {
      setEditError("请至少修改一项用户资料或套餐。");
      return;
    }
    setSavingEdit(true);
    setEditError(null);
    try {
      const result = await updateAdminUser(token, target.id, {
        ...(profileChanged
          ? {
              displayName: editDisplayName.trim(),
              email: editEmail.trim(),
            }
          : {}),
        ...(planChanged ? { plan: editPlan } : {}),
        reason: editReason.trim(),
      });
      setSelectedUserDetail(result.detail);
      closeEditUser();
      await load(search, userStatusFilter);
    } catch (saveError) {
      setEditError(
        saveError instanceof Error ? saveError.message : "无法更新该用户。",
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
      setStatusError("请填写本次状态变更的原因。");
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
        saveError instanceof Error ? saveError.message : "无法更新该用户状态。",
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
      setResetError("请填写发起密码重置的原因。");
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
        saveError instanceof Error ? saveError.message : "无法发起密码重置。",
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
      setAdminMutationError("请填写本次权限变更的原因。");
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
          : "无法更新平台管理权限。",
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
    if (!Number.isInteger(amount) || amount < 1 || amount > 500_000) {
      setAdjustmentError("请输入 1 至 500,000 之间的整数。");
      return;
    }
    if (adjustmentReason.trim().length < 3) {
      setAdjustmentError("请填写本次增加点数的原因。");
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
        idempotencyKey: crypto.randomUUID(),
      });
      closeAdjustmentDialog();
      await load(search, userStatusFilter);
      if (selectedUserDetail?.user.id === adjustedUser.id) {
        const { detail } = await fetchAdminUserDetail(token, adjustedUser.id);
        setSelectedUserDetail(detail);
      }
    } catch (saveError) {
      setAdjustmentError(
        saveError instanceof Error ? saveError.message : "无法增加点数。",
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
            aria-label="管理后台首页"
          >
            <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <ShieldCheck className="size-4" />
            </span>
            <span className="text-sm font-semibold">Loomic 管理后台</span>
          </Link>
          <nav className="mt-6 space-y-5" aria-label="管理后台栏目">
            {menuGroups.map((group) => (
              <section key={group.id} aria-labelledby={`admin-nav-${group.id}`}>
                <h2
                  id={`admin-nav-${group.id}`}
                  className="px-3 text-xs font-medium text-muted-foreground"
                >
                  {group.label}
                </h2>
                <div className="mt-2 ml-3 space-y-1 border-l pl-2">
                  {group.items.map((item) => {
                    const Icon = item.icon;
                    const selected = tab === item.id;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => setTab(item.id)}
                        aria-current={selected ? "page" : undefined}
                        className={cn(
                          "flex h-9 w-full items-center gap-3 rounded-md px-3 text-left text-sm transition-colors",
                          selected
                            ? "bg-muted font-medium text-foreground"
                            : "text-muted-foreground hover:bg-muted/70 hover:text-foreground",
                        )}
                      >
                        <Icon className="size-4 shrink-0" />
                        {item.label}
                      </button>
                    );
                  })}
                </div>
              </section>
            ))}
          </nav>
          <div className="mt-auto border-t pt-3">
            <Link
              href="/home"
              className="flex h-9 items-center gap-2 rounded-md px-3 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <ArrowLeft className="size-4" />
              返回工作台
            </Link>
          </div>
        </aside>

        <main className="mx-auto min-w-0 max-w-[1600px] flex-1 px-4 py-5 sm:px-6 lg:px-8">
          <header className="flex min-h-14 flex-wrap items-center justify-between gap-4 border-b pb-5">
            <div>
              <h1 className="text-xl font-semibold">
                {activeTab?.label ?? "用户管理"}
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">
                {activeTab?.description ??
                  "管理用户账号、工作区权限、套餐与点数余额。"}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Link href="/home" className="lg:hidden">
                <Button variant="outline" size="sm">
                  <ArrowLeft data-icon="inline-start" />
                  工作台
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
                刷新
              </Button>
            </div>
          </header>

          <div className="mt-4 lg:hidden">
            <Label htmlFor="admin-section" className="sr-only">
              管理后台栏目
            </Label>
            <select
              id="admin-section"
              value={tab}
              onChange={(event) => setTab(event.target.value as AdminTab)}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {menuGroups.map((group) => (
                <optgroup key={group.id} label={group.label}>
                  {group.items.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>

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
            aria-label="平台概览"
          >
            <Stat label="用户总数" value={overview?.totalUsers} icon={Users} />
            <Stat
              label="进行中的任务"
              value={overview?.activeJobs}
              icon={Activity}
            />
            <Stat
              label="失败任务 · 24 小时"
              value={overview?.failedJobs24h}
              icon={BadgeAlert}
              alert
            />
            <Stat
              label="人工加点 · 24 小时"
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
            {tab === "billing" && session?.access_token && (
              <BillingPlansPanel accessToken={session.access_token} />
            )}
            {tab === "top-up-packs" && session?.access_token && (
              <TopUpPacksPanel accessToken={session.access_token} />
            )}
            {tab === "payment-providers" && session?.access_token && (
              <PaymentProvidersPanel accessToken={session.access_token} />
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
              <DialogTitle>增加点数</DialogTitle>
              <DialogDescription>
                为该用户增加点数，并创建一笔可审计的余额流水。
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-5 px-6 py-5">
              <div className="flex items-center justify-between rounded-md border bg-muted/40 px-3 py-2.5">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">
                    {adjustingUser?.email}
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    当前余额
                  </div>
                </div>
                <div className="font-medium tabular-nums">
                  {adjustingUser?.balance.toLocaleString() ?? 0}
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="admin-credit-amount">增加数量</Label>
                <Input
                  id="admin-credit-amount"
                  inputMode="numeric"
                  max="500000"
                  min="1"
                  onChange={(event) => setAdjustmentAmount(event.target.value)}
                  placeholder="例如 500"
                  type="number"
                  value={adjustmentAmount}
                />
                <p className="text-xs text-muted-foreground">
                  请输入 1 至 500,000 之间的整数。
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="admin-credit-reason">调整原因</Label>
                <textarea
                  id="admin-credit-reason"
                  className="flex min-h-24 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                  maxLength={500}
                  onChange={(event) => setAdjustmentReason(event.target.value)}
                  placeholder="请说明本次增加点数的原因"
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
                取消
              </Button>
              <Button type="submit" disabled={savingAdjustment}>
                {savingAdjustment && (
                  <Loader2 data-icon="inline-start" className="animate-spin" />
                )}
                确认增加
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <EditUserDialog
        user={editingUser}
        displayName={editDisplayName}
        email={editEmail}
        plan={editPlan}
        reason={editReason}
        error={editError}
        saving={savingEdit}
        onDisplayNameChange={setEditDisplayName}
        onEmailChange={setEditEmail}
        onPlanChange={setEditPlan}
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
}) {
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold">全部用户</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            查看账号、套餐、余额与平台权限。
          </p>
        </div>
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          <select
            aria-label="按状态筛选用户"
            className="h-9 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            onChange={(event) =>
              onStatusFilterChange(
                event.target.value as AdminUserStatus | "all",
              )
            }
            value={statusFilter}
          >
            <option value="all">全部状态</option>
            <option value="active">正常</option>
            <option value="suspended">已暂停</option>
            <option value="disabled">已禁用</option>
          </select>
          <div className="relative w-full sm:w-72">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              aria-label="搜索用户"
              className="pl-9"
              onChange={(event) => onSearchChange(event.target.value)}
              placeholder="搜索用户名或邮箱"
              value={search}
            />
          </div>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[980px] text-left text-sm">
          <thead className="border-b bg-muted/50 text-xs text-muted-foreground">
            <tr>
              <th className="px-5 py-3 font-medium">用户</th>
              <th className="px-5 py-3 font-medium">工作区</th>
              <th className="px-5 py-3 font-medium">套餐</th>
              <th className="px-5 py-3 font-medium">点数余额</th>
              <th className="px-5 py-3 font-medium">状态</th>
              <th className="px-5 py-3 font-medium">最近登录</th>
              <th className="px-5 py-3 text-right font-medium">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {loading ? (
              <LoadingRows columns={7} />
            ) : users.length === 0 ? (
              <EmptyRow columns={7} label="没有符合条件的用户。" />
            ) : (
              users.map((user) => (
                <tr key={user.id} className="hover:bg-muted/40">
                  <td className="px-5 py-3">
                    <button
                      type="button"
                      className="flex max-w-full items-center gap-3 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => onView(user)}
                      aria-label={`查看 ${user.displayName} 的详情`}
                    >
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold text-muted-foreground">
                        {initials(user.displayName, user.email)}
                      </span>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 font-medium">
                          <span className="truncate">{user.displayName}</span>
                          {user.isPlatformAdmin && (
                            <ShieldCheck
                              className="size-3.5 text-foreground"
                              aria-label="平台管理员"
                            />
                          )}
                        </div>
                        <div className="max-w-52 truncate text-xs text-muted-foreground">
                          {user.email}
                        </div>
                      </div>
                    </button>
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
                      : "从未登录"}
                  </td>
                  <td className="px-5 py-3 text-right">
                    <div className="flex justify-end gap-1.5">
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        onClick={() => onEdit(user)}
                        aria-label="编辑用户"
                        title="编辑用户"
                      >
                        <Pencil />
                      </Button>
                      {user.workspaceId ? (
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          onClick={() => onAdjust(user)}
                          aria-label="增加用户点数"
                          title="增加点数"
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
      title="全部工作区"
      subtitle="查看归属、成员、项目、套餐与点数余额。"
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[900px] text-left text-sm">
          <thead className="border-b bg-muted/50 text-xs text-muted-foreground">
            <tr>
              <th className="px-5 py-3 font-medium">工作区</th>
              <th className="px-5 py-3 font-medium">所有者</th>
              <th className="px-5 py-3 font-medium">类型</th>
              <th className="px-5 py-3 font-medium">成员数</th>
              <th className="px-5 py-3 font-medium">项目数</th>
              <th className="px-5 py-3 font-medium">套餐</th>
              <th className="px-5 py-3 font-medium">点数余额</th>
              <th className="px-5 py-3 text-right font-medium">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {loading ? (
              <LoadingRows columns={8} />
            ) : workspaces.length === 0 ? (
              <EmptyRow columns={8} label="暂无工作区。" />
            ) : (
              workspaces.map((workspace) => (
                <tr key={workspace.id} className="hover:bg-muted/40">
                  <td className="px-5 py-3">
                    <div className="font-medium">{workspace.name}</div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      创建于 {formatDate(workspace.createdAt)}
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
                    {workspaceTypeLabel(workspace.type)}
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
                      查看
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
      title="平台管理员"
      subtitle="平台权限与工作区所有者、管理员角色相互独立。"
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[680px] text-left text-sm">
          <thead className="border-b bg-muted/50 text-xs text-muted-foreground">
            <tr>
              <th className="px-5 py-3 font-medium">管理员</th>
              <th className="px-5 py-3 font-medium">授权时间</th>
              <th className="px-5 py-3 font-medium">授权人</th>
              <th className="px-5 py-3 text-right font-medium">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {loading ? (
              <LoadingRows columns={4} />
            ) : administrators.length === 0 ? (
              <EmptyRow columns={4} label="暂无平台管理员。" />
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
                    {administrator.createdByEmail ?? "系统"}
                  </td>
                  <td className="px-5 py-3 text-right">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => onRevoke(administrator)}
                    >
                      <ShieldOff data-icon="inline-start" />
                      撤销权限
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
    <TableFrame title="生成任务" subtitle="查看队列运行状况与近期执行结果。">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead className="border-b bg-muted/50 text-xs text-muted-foreground">
            <tr>
              <th className="px-5 py-3 font-medium">状态</th>
              <th className="px-5 py-3 font-medium">任务类型</th>
              <th className="px-5 py-3 font-medium">用户</th>
              <th className="px-5 py-3 font-medium">工作区</th>
              <th className="px-5 py-3 font-medium">创建时间</th>
              <th className="px-5 py-3 font-medium">失败原因</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {loading ? (
              <LoadingRows columns={6} />
            ) : jobs.length === 0 ? (
              <EmptyRow columns={6} label="暂无生成任务记录。" />
            ) : (
              jobs.map((job) => (
                <tr key={job.id} className="hover:bg-muted/40">
                  <td className="px-5 py-3">
                    <StatusBadge status={job.status} />
                  </td>
                  <td className="px-5 py-3 font-medium">
                    {jobTypeLabel(job.jobType)}
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
      title="智能体运行"
      subtitle="查看会话级智能体的执行状态、模型、线程与错误。"
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[920px] text-left text-sm">
          <thead className="border-b bg-muted/50 text-xs text-muted-foreground">
            <tr>
              <th className="px-5 py-3 font-medium">状态</th>
              <th className="px-5 py-3 font-medium">会话</th>
              <th className="px-5 py-3 font-medium">用户</th>
              <th className="px-5 py-3 font-medium">工作区</th>
              <th className="px-5 py-3 font-medium">模型</th>
              <th className="px-5 py-3 font-medium">创建时间</th>
              <th className="px-5 py-3 font-medium">错误</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {loading ? (
              <LoadingRows columns={7} />
            ) : runs.length === 0 ? (
              <EmptyRow columns={7} label="暂无智能体运行记录。" />
            ) : (
              runs.map((run) => (
                <tr key={run.id} className="hover:bg-muted/40">
                  <td className="px-5 py-3">
                    <StatusBadge status={run.status} />
                  </td>
                  <td className="px-5 py-3">
                    <div className="font-medium">
                      {run.sessionTitle ?? "未命名会话"}
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
      title="点数流水"
      subtitle="仅追加记录点数发放、消耗、退还与人工加点。"
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[780px] text-left text-sm">
          <thead className="border-b bg-muted/50 text-xs text-muted-foreground">
            <tr>
              <th className="px-5 py-3 font-medium">类型</th>
              <th className="px-5 py-3 font-medium">用户</th>
              <th className="px-5 py-3 font-medium">变动点数</th>
              <th className="px-5 py-3 font-medium">变动后余额</th>
              <th className="px-5 py-3 font-medium">原因</th>
              <th className="px-5 py-3 font-medium">时间</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {loading ? (
              <LoadingRows columns={6} />
            ) : transactions.length === 0 ? (
              <EmptyRow columns={6} label="暂无点数流水。" />
            ) : (
              transactions.map((item) => (
                <tr key={item.id} className="hover:bg-muted/40">
                  <td className="px-5 py-3">
                    <span className="capitalize text-muted-foreground">
                      {transactionTypeLabel(item.transactionType)}
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
      title="管理员审计日志"
      subtitle="所有敏感操作均记录操作者、操作对象与上下文。"
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead className="border-b bg-muted/50 text-xs text-muted-foreground">
            <tr>
              <th className="px-5 py-3 font-medium">操作</th>
              <th className="px-5 py-3 font-medium">操作者</th>
              <th className="px-5 py-3 font-medium">操作对象</th>
              <th className="px-5 py-3 font-medium">详情</th>
              <th className="px-5 py-3 font-medium">时间</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {loading ? (
              <LoadingRows columns={5} />
            ) : events.length === 0 ? (
              <EmptyRow columns={5} label="暂无管理员操作记录。" />
            ) : (
              events.map((event) => (
                <tr key={event.id} className="hover:bg-muted/40">
                  <td className="px-5 py-3 font-medium">
                    {auditActionLabel(event.action)}
                  </td>
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
  plan,
  reason,
  error,
  saving,
  onDisplayNameChange,
  onEmailChange,
  onPlanChange,
  onReasonChange,
  onClose,
  onSubmit,
}: {
  user: AdminUser | null;
  displayName: string;
  email: string;
  plan: SubscriptionPlan;
  reason: string;
  error: string | null;
  saving: boolean;
  onDisplayNameChange: (value: string) => void;
  onEmailChange: (value: string) => void;
  onPlanChange: (value: SubscriptionPlan) => void;
  onReasonChange: (value: string) => void;
  onClose: () => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <Dialog open={Boolean(user)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="gap-0 rounded-lg p-0 sm:max-w-lg">
        <form onSubmit={onSubmit}>
          <DialogHeader className="border-b px-6 py-5 pr-14">
            <DialogTitle>编辑用户</DialogTitle>
            <DialogDescription>
              更新 {user?.email ?? "该用户"} 的账号资料。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 px-6 py-5">
            <div className="space-y-2">
              <Label htmlFor="admin-edit-display-name">用户名</Label>
              <Input
                id="admin-edit-display-name"
                maxLength={80}
                onChange={(event) => onDisplayNameChange(event.target.value)}
                value={displayName}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="admin-edit-email">邮箱</Label>
              <Input
                id="admin-edit-email"
                maxLength={320}
                onChange={(event) => onEmailChange(event.target.value)}
                type="email"
                value={email}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="admin-edit-plan">套餐分组</Label>
              <select
                id="admin-edit-plan"
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                onChange={(event) =>
                  onPlanChange(event.target.value as SubscriptionPlan)
                }
                value={plan}
              >
                <option value="free">免费版 · 每日 50 点</option>
                <option value="starter">入门版 · 每月 1,200 点</option>
                <option value="pro">专业版 · 每月 5,000 点</option>
                <option value="ultra">旗舰版 · 每月 15,000 点</option>
                <option value="business">企业版 · 每月 50,000 点</option>
              </select>
              <p className="text-xs text-muted-foreground">
                修改套餐只调整功能分组，不会自动增加或扣除点数。有效在线订阅需在支付平台变更。
              </p>
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
              取消
            </Button>
            <Button type="submit" disabled={saving}>
              {saving && (
                <Loader2 data-icon="inline-start" className="animate-spin" />
              )}
              保存修改
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
              {nextStatus === "suspend" ? "暂停用户" : "恢复用户"}
            </DialogTitle>
            <DialogDescription>
              {nextStatus === "suspend"
                ? "该账号将立即失去访问权限，且无法继续登录。"
                : "该账号将恢复登录与访问权限。"}
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
              取消
            </Button>
            <Button
              type="submit"
              variant={nextStatus === "suspend" ? "destructive" : "default"}
              disabled={saving}
            >
              {saving && (
                <Loader2 data-icon="inline-start" className="animate-spin" />
              )}
              {nextStatus === "suspend" ? "暂停用户" : "恢复用户"}
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
            <DialogTitle>重置密码</DialogTitle>
            <DialogDescription>
              生成一次性密码重置令牌，系统不会显示用户当前密码。
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
              取消
            </Button>
            <Button type="submit" disabled={saving}>
              {saving && (
                <Loader2 data-icon="inline-start" className="animate-spin" />
              )}
              生成重置令牌
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
          <DialogTitle>重置令牌已生成</DialogTitle>
          <DialogDescription>
            该令牌仅显示一次，将于 {result ? formatDate(result.expiresAt) : "—"}{" "}
            失效。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 px-6 py-5">
          <Label htmlFor="admin-reset-token">一次性令牌</Label>
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
              title="复制重置令牌"
              aria-label="复制重置令牌"
            >
              {copied ? <Check /> : <Copy />}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            请通过已批准的客服渠道传递此令牌。关闭弹窗后将无法再次查看。
          </p>
        </div>
        <DialogFooter className="mx-0 mb-0 mt-0 rounded-b-lg px-6 py-4">
          <Button type="button" onClick={onClose}>
            完成
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
              {revoke ? "撤销平台管理权限" : "授予平台管理权限"}
            </DialogTitle>
            <DialogDescription>
              {revoke
                ? "撤销平台管理员权限，不会改变其工作区权限。"
                : "授予该用户访问平台管理后台的权限。"}
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
              取消
            </Button>
            <Button
              type="submit"
              variant={revoke ? "destructive" : "default"}
              disabled={saving}
            >
              {saving && (
                <Loader2 data-icon="inline-start" className="animate-spin" />
              )}
              {revoke ? "撤销权限" : "授予权限"}
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
      <Label htmlFor={id}>操作原因</Label>
      <textarea
        id={id}
        className="flex min-h-24 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        maxLength={500}
        onChange={(event) => onChange(event.target.value)}
        placeholder="请说明本次操作的原因"
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
}: {
  detail: AdminUserDetail | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onAdjust: (user: AdminUser) => void;
  onEdit: (user: AdminUser) => void;
}) {
  const user = detail?.user;

  return (
    <Sheet open={Boolean(detail)} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>用户详情</SheetTitle>
          <SheetDescription>
            {user
              ? `${user.displayName} · ${user.email}`
              : "正在加载账号、工作区、点数与执行记录。"}
          </SheetDescription>
        </SheetHeader>

        <SheetBody>
          {user && (
            <div className="grid grid-cols-2 gap-x-6 gap-y-5 border-b pb-6">
              <DetailTile label="套餐">
                <PlanBadge plan={user.plan} />
              </DetailTile>
              <DetailTile label="点数余额">
                <span className="tabular-nums">
                  {user.balance.toLocaleString()}
                </span>
              </DetailTile>
              <DetailTile label="工作区">
                <span className="truncate">{user.workspaceName ?? "—"}</span>
              </DetailTile>
              <DetailTile label="访问权限">
                <span className="inline-flex items-center gap-1">
                  {user.isPlatformAdmin && <ShieldCheck className="size-3.5" />}
                  {user.isPlatformAdmin ? "平台管理员" : "工作区用户"}
                </span>
              </DetailTile>
              <DetailTile label="状态">
                <UserStatusBadge status={user.status} />
              </DetailTile>
              <DetailTile label="注册时间">
                {formatDate(user.createdAt)}
              </DetailTile>
              <DetailTile label="最近登录">
                {user.lastSignInAt ? formatDate(user.lastSignInAt) : "从未登录"}
              </DetailTile>
              <DetailTile label="用户 ID">
                <span className="truncate text-xs">{user.id}</span>
              </DetailTile>
              <DetailTile label="工作区 ID">
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
            <div className="mt-6 space-y-3" aria-label="正在加载近期活动">
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
                编辑资料
              </Button>
              {user.workspaceId && (
                <Button type="button" onClick={() => onAdjust(user)}>
                  <Coins data-icon="inline-start" />
                  增加点数
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
          <h3 className="text-sm font-semibold">工作区</h3>
          <p className="text-xs text-muted-foreground">
            查看该用户可访问的全部工作区、角色与点数余额。
          </p>
        </div>
        <span className="text-xs tabular-nums text-muted-foreground">
          {workspaces.length}
        </span>
      </div>
      {workspaces.length === 0 ? (
        <div className="rounded-md border px-3 py-4 text-sm text-muted-foreground">
          暂无工作区成员关系。
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
                      所有者
                    </span>
                  )}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                  <span>{workspaceTypeLabel(workspace.workspaceType)}</span>
                  <span aria-hidden="true">·</span>
                  <span>{workspaceRoleLabel(workspace.role)}</span>
                  <span aria-hidden="true">·</span>
                  <span>加入于 {formatDate(workspace.joinedAt)}</span>
                </div>
              </div>
              <div className="flex shrink-0 items-end gap-3 text-right">
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    套餐
                  </div>
                  <PlanBadge plan={workspace.plan} />
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    点数余额
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
          <SheetTitle>工作区详情</SheetTitle>
          <SheetDescription>
            {workspace
              ? `${workspace.name} · ${workspace.ownerEmail}`
              : "正在加载归属、成员、项目、套餐与点数余额。"}
          </SheetDescription>
        </SheetHeader>
        <SheetBody>
          {workspace && (
            <div className="grid grid-cols-2 gap-x-6 gap-y-5 border-b pb-6">
              <DetailTile label="类型">
                <span>{workspaceTypeLabel(workspace.type)}</span>
              </DetailTile>
              <DetailTile label="套餐">
                <PlanBadge plan={workspace.plan} />
              </DetailTile>
              <DetailTile label="所有者">
                <span className="truncate">{workspace.ownerDisplayName}</span>
              </DetailTile>
              <DetailTile label="点数余额">
                <span className="tabular-nums">
                  {workspace.balance.toLocaleString()}
                </span>
              </DetailTile>
              <DetailTile label="成员数">{workspace.memberCount}</DetailTile>
              <DetailTile label="项目数">{workspace.projectCount}</DetailTile>
              <DetailTile label="创建时间">
                {formatDate(workspace.createdAt)}
              </DetailTile>
              <DetailTile label="工作区 ID">
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
            <div className="mt-6 space-y-3" aria-label="正在加载工作区详情">
              <div className="h-12 animate-pulse rounded-md bg-muted" />
              <div className="h-12 animate-pulse rounded-md bg-muted" />
            </div>
          )}

          {detail && !loading && (
            <div className="mt-6 space-y-6">
              <section className="space-y-3">
                <div className="flex items-baseline justify-between gap-3">
                  <h3 className="text-sm font-semibold">成员</h3>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {detail.members.length}
                  </span>
                </div>
                {detail.members.length === 0 ? (
                  <div className="rounded-md border px-3 py-4 text-sm text-muted-foreground">
                    暂无成员。
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
                            {workspaceRoleLabel(member.role)}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <section className="space-y-3">
                <div className="flex items-baseline justify-between gap-3">
                  <h3 className="text-sm font-semibold">项目</h3>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {detail.projects.length}
                  </span>
                </div>
                {detail.projects.length === 0 ? (
                  <div className="rounded-md border px-3 py-4 text-sm text-muted-foreground">
                    暂无项目。
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
                          {project.canvasCount} 个画布
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
    <DetailPanel title="点数流水" emptyLabel="暂无近期点数记录。">
      {transactions.map((item) => (
        <div key={item.id} className="px-4 py-3 text-sm">
          <div className="flex items-start justify-between gap-3">
            <span className="capitalize text-muted-foreground">
              {transactionTypeLabel(item.transactionType)}
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
            {item.description ?? "未记录原因"}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            余额 {item.balanceAfter.toLocaleString()} ·{" "}
            {formatDate(item.createdAt)}
          </div>
        </div>
      ))}
    </DetailPanel>
  );
}

function RecentJobsPanel({ jobs }: { jobs: AdminJob[] }) {
  return (
    <DetailPanel title="生成任务" emptyLabel="暂无近期生成任务。">
      {jobs.map((job) => (
        <div key={job.id} className="px-4 py-3 text-sm">
          <div className="flex items-start justify-between gap-3">
            <span className="font-medium capitalize">
              {jobTypeLabel(job.jobType)}
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
    <DetailPanel title="智能体运行" emptyLabel="暂无近期智能体运行记录。">
      {runs.map((run) => (
        <div key={run.id} className="px-4 py-3 text-sm">
          <div className="flex items-start justify-between gap-3">
            <span className="min-w-0 truncate font-medium">
              {run.sessionTitle ?? "未命名会话"}
            </span>
            <StatusBadge status={run.status} />
          </div>
          <div className="mt-1 truncate text-xs text-muted-foreground">
            {run.model ?? "未指定模型"} · {run.threadId}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            {formatDate(run.createdAt)}
            {run.completedAt ? ` · 完成于 ${formatDate(run.completedAt)}` : ""}
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
      {planLabel(plan)}
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
      {statusLabel(status)}
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
      {userStatusLabel(status)}
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
  return new Intl.DateTimeFormat("zh-CN", {
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
    ? `${amount >= 0 ? "+" : ""}${amount} 点${typeof reason === "string" ? ` · ${reason}` : ""}`
    : typeof reason === "string"
      ? reason
      : "已记录";
}

function planLabel(plan: string) {
  return (
    (
      {
        free: "免费版",
        starter: "入门版",
        pro: "专业版",
        ultra: "旗舰版",
        business: "企业版",
      } as Record<string, string>
    )[plan] ?? "其他套餐"
  );
}

function statusLabel(status: string) {
  return (
    (
      {
        queued: "排队中",
        running: "运行中",
        succeeded: "已完成",
        completed: "已完成",
        failed: "失败",
        dead_letter: "已终止",
        canceled: "已取消",
        canceling: "取消中",
      } as Record<string, string>
    )[status] ?? "未知状态"
  );
}

function userStatusLabel(status: AdminUserStatus) {
  return {
    active: "正常",
    suspended: "已暂停",
    disabled: "已禁用",
  }[status];
}

function workspaceTypeLabel(type: string) {
  return (
    ({ personal: "个人", team: "团队" } as Record<string, string>)[type] ??
    "其他"
  );
}

function workspaceRoleLabel(role: string) {
  return (
    (
      { owner: "所有者", admin: "管理员", member: "成员" } as Record<
        string,
        string
      >
    )[role] ?? "成员"
  );
}

function jobTypeLabel(type: string) {
  return (
    (
      {
        image_generation: "图片生成",
        video_generation: "视频生成",
      } as Record<string, string>
    )[type] ?? "其他任务"
  );
}

function transactionTypeLabel(type: string) {
  return (
    (
      {
        subscription_grant: "套餐发放",
        daily_grant: "每日发放",
        purchase: "购买点数",
        generation_deduct: "生成扣除",
        generation_refund: "生成退还",
        admin_adjustment: "人工加点",
        bonus: "奖励点数",
      } as Record<string, string>
    )[type] ?? "其他变动"
  );
}

function auditActionLabel(action: string) {
  return (
    (
      {
        "user.profile_updated": "更新用户资料",
        "user.status_updated": "更新用户状态",
        "user.password_reset_issued": "生成密码重置令牌",
        "platform_admin.granted": "授予平台管理员权限",
        "platform_admin.revoked": "撤销平台管理员权限",
        "credits.adjusted": "人工增加点数",
      } as Record<string, string>
    )[action] ?? "其他管理员操作"
  );
}

function AdminLoading() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30">
      <div className="flex items-center gap-3 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        正在加载管理后台
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
        <h1 className="mt-5 text-xl font-semibold">需要平台管理员权限</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          该账号可以使用创作工作台，但没有平台运营管理权限。
        </p>
        <Link href="/home" className="mt-6 inline-flex">
          <Button>
            <ArrowLeft data-icon="inline-start" />
            返回工作台
          </Button>
        </Link>
      </div>
    </div>
  );
}
