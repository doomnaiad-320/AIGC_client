"use client";

import type {
  AdminBillingOverview,
  AdminBillingPlan,
  AdminBillingPlanVersion,
  AdminUpdateBillingPlanDraft,
  BillingPlanCode,
} from "@loomic/shared";
import { AlertTriangle, Loader2, RefreshCw, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

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
  createAdminBillingPlanDraft,
  fetchAdminBillingPlans,
  publishAdminBillingPlan,
  updateAdminBillingPlanDraft,
} from "@/lib/admin-api";
import { cn } from "@/lib/utils";

type Props = { accessToken: string };
type ConfirmAction = "create" | "publish" | null;

const EMPTY_OVERVIEW: AdminBillingOverview = {
  workspaceCount: 0,
  paidWorkspaceCount: 0,
  coveredUserCount: 0,
  activeSubscriptionCount: 0,
  monthlyCreditsIssued: 0,
  monthlyCreditsConsumed: 0,
};

export function BillingPlansPanel({ accessToken }: Props) {
  const [plans, setPlans] = useState<AdminBillingPlan[]>([]);
  const [overview, setOverview] =
    useState<AdminBillingOverview>(EMPTY_OVERVIEW);
  const [selectedCode, setSelectedCode] = useState<BillingPlanCode>("free");
  const [form, setForm] = useState<AdminUpdateBillingPlanDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null);
  const [confirmReason, setConfirmReason] = useState("");

  const selectedPlan =
    plans.find((plan) => plan.code === selectedCode) ?? plans[0] ?? null;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchAdminBillingPlans(accessToken);
      setPlans(result.plans);
      setOverview(result.overview);
      setSelectedCode((current) =>
        result.plans.some((plan) => plan.code === current)
          ? current
          : (result.plans[0]?.code ?? "free"),
      );
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : "无法加载套餐配置。",
      );
    } finally {
      setLoading(false);
    }
  }, [accessToken]);

  useEffect(() => void load(), [load]);

  useEffect(() => {
    setForm(selectedPlan?.draft ? versionToForm(selectedPlan.draft) : null);
    setError(null);
  }, [selectedPlan?.draft]);

  const initialDraft = useMemo(
    () => (selectedPlan?.draft ? versionToForm(selectedPlan.draft) : null),
    [selectedPlan?.draft],
  );
  const dirty = Boolean(
    form &&
      initialDraft &&
      editableFingerprint(form) !== editableFingerprint(initialDraft),
  );
  const editorVersion = selectedPlan?.draft ?? selectedPlan?.published ?? null;

  async function saveDraft(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedPlan || !form) return;
    if (form.reason.trim().length < 3) {
      setError("请填写至少 3 个字的变更原因。该原因会进入审计日志。");
      return;
    }
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await updateAdminBillingPlanDraft(
        accessToken,
        selectedPlan.code,
        { ...form, reason: form.reason.trim() },
      );
      setPlans(result.plans);
      setSuccess(`${selectedPlan.nameZh}草稿已保存，尚未影响线上套餐。`);
    } catch (saveError) {
      setError(
        saveError instanceof Error ? saveError.message : "无法保存套餐草稿。",
      );
    } finally {
      setSaving(false);
    }
  }

  async function submitConfirmedAction(
    event: React.FormEvent<HTMLFormElement>,
  ) {
    event.preventDefault();
    if (!selectedPlan || !confirmAction || confirmReason.trim().length < 3) {
      setError("请填写至少 3 个字的操作原因。");
      return;
    }
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const result =
        confirmAction === "create"
          ? await createAdminBillingPlanDraft(accessToken, selectedPlan.code, {
              reason: confirmReason.trim(),
            })
          : await publishAdminBillingPlan(accessToken, selectedPlan.code, {
              reason: confirmReason.trim(),
            });
      setPlans(result.plans);
      setSuccess(
        confirmAction === "create"
          ? `${selectedPlan.nameZh}编辑草稿已创建。`
          : `${selectedPlan.nameZh}新版本已发布并开始作为运行时配置。`,
      );
      setConfirmAction(null);
      setConfirmReason("");
    } catch (actionError) {
      setError(
        actionError instanceof Error ? actionError.message : "套餐操作失败。",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="min-w-0">
      <header className="border-b px-5 py-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold">套餐与计费</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              管理套餐价格、点数额度和产品权益。所有修改先保存为草稿，发布后才会生效。
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void load()}
            disabled={loading}
          >
            <RefreshCw className={cn("size-4", loading && "animate-spin")} />
            刷新数据
          </Button>
        </div>

        <div className="mt-5 grid border-y sm:grid-cols-3 xl:grid-cols-6">
          <OverviewMetric label="套餐工作区" value={overview.workspaceCount} />
          <OverviewMetric
            label="付费工作区"
            value={overview.paidWorkspaceCount}
          />
          <OverviewMetric label="覆盖用户" value={overview.coveredUserCount} />
          <OverviewMetric
            label="有效订阅"
            value={overview.activeSubscriptionCount}
          />
          <OverviewMetric
            label="本月发放点数"
            value={overview.monthlyCreditsIssued}
          />
          <OverviewMetric
            label="本月消耗点数"
            value={overview.monthlyCreditsConsumed}
          />
        </div>
      </header>

      {error && (
        <Notice tone="error">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          {error}
        </Notice>
      )}
      {success && <Notice tone="success">{success}</Notice>}

      <section className="border-b" aria-label="套餐使用情况">
        <div className="grid sm:grid-cols-2 xl:grid-cols-4">
          {plans.map((plan) => (
            <button
              key={plan.code}
              type="button"
              onClick={() => {
                setSelectedCode(plan.code);
                setSuccess(null);
              }}
              className={cn(
                "min-h-32 border-b px-5 py-4 text-left transition-colors sm:border-r xl:border-b-0",
                selectedPlan?.code === plan.code
                  ? "bg-primary/[0.045] shadow-[inset_0_-2px_0_hsl(var(--primary))]"
                  : "hover:bg-muted/35",
              )}
            >
              <div className="flex items-center justify-between gap-3">
                <span className="font-medium">{plan.nameZh}</span>
                <VersionBadges draft={plan.draft} published={plan.published} />
              </div>
              <div className="mt-4 grid grid-cols-3 gap-3">
                <PlanMetric
                  label="工作区"
                  value={plan.statistics.workspaceCount}
                />
                <PlanMetric
                  label="用户"
                  value={plan.statistics.coveredUserCount}
                />
                <PlanMetric
                  label="有效订阅"
                  value={plan.statistics.activeSubscriptionCount}
                />
              </div>
            </button>
          ))}
        </div>
      </section>

      {loading && plans.length === 0 ? (
        <div className="flex min-h-80 items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          正在读取套餐配置...
        </div>
      ) : selectedPlan && editorVersion ? (
        <PlanEditor
          plan={selectedPlan}
          form={form ?? versionToForm(editorVersion)}
          editable={Boolean(selectedPlan.draft)}
          dirty={dirty}
          saving={saving}
          onFormChange={setForm}
          onReset={() =>
            setForm(
              selectedPlan.draft ? versionToForm(selectedPlan.draft) : null,
            )
          }
          onSave={saveDraft}
          onCreateDraft={() => {
            setConfirmReason("");
            setConfirmAction("create");
          }}
          onPublish={() => {
            setConfirmReason("");
            setConfirmAction("publish");
          }}
        />
      ) : null}

      <Dialog
        open={Boolean(confirmAction)}
        onOpenChange={(open) => !open && setConfirmAction(null)}
      >
        <DialogContent className="sm:max-w-md">
          <form onSubmit={submitConfirmedAction}>
            <DialogHeader>
              <DialogTitle>
                {confirmAction === "publish" ? "发布套餐版本" : "创建编辑草稿"}
              </DialogTitle>
              <DialogDescription>
                {confirmAction === "publish"
                  ? "发布后该版本不可修改，并将成为新的运行时套餐配置。"
                  : "系统会复制当前线上版本，创建一份可编辑的新草稿。"}
              </DialogDescription>
            </DialogHeader>
            <div className="py-5">
              <Label htmlFor="billing-confirm-reason">操作原因</Label>
              <Input
                id="billing-confirm-reason"
                className="mt-2"
                value={confirmReason}
                onChange={(event) => setConfirmReason(event.target.value)}
                placeholder="例如：根据新模型成本调整套餐额度"
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setConfirmAction(null)}
              >
                取消
              </Button>
              <Button type="submit" disabled={saving}>
                {saving && <Loader2 className="size-4 animate-spin" />}
                {confirmAction === "publish" ? "确认发布" : "创建草稿"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function PlanEditor({
  plan,
  form,
  editable,
  dirty,
  saving,
  onFormChange,
  onReset,
  onSave,
  onCreateDraft,
  onPublish,
}: {
  plan: AdminBillingPlan;
  form: AdminUpdateBillingPlanDraft;
  editable: boolean;
  dirty: boolean;
  saving: boolean;
  onFormChange: (form: AdminUpdateBillingPlanDraft) => void;
  onReset: () => void;
  onSave: (event: React.FormEvent<HTMLFormElement>) => void;
  onCreateDraft: () => void;
  onPublish: () => void;
}) {
  const display = plan.draft ?? plan.published;

  if (!display) {
    return (
      <div className="px-5 py-12 text-sm text-muted-foreground">
        该套餐还没有可用版本。
      </div>
    );
  }

  const draftForm = form;

  function setNumber(
    field: keyof Pick<
      AdminUpdateBillingPlanDraft,
      | "monthlyPriceMinor"
      | "annualPriceMinor"
      | "monthlySubscriptionCredits"
      | "dailyCredits"
    >,
    value: number,
  ) {
    onFormChange({ ...draftForm, [field]: value });
  }

  function setEntitlement<
    K extends keyof AdminUpdateBillingPlanDraft["entitlements"],
  >(field: K, value: AdminUpdateBillingPlanDraft["entitlements"][K]) {
    onFormChange({
      ...draftForm,
      entitlements: { ...draftForm.entitlements, [field]: value },
    });
  }

  return (
    <form onSubmit={onSave}>
      <PlanHeading plan={plan} display={display} editable={editable} />

      <fieldset disabled={!editable} className="disabled:opacity-75">
        <div className="grid gap-x-8 gap-y-8 px-5 py-6 xl:grid-cols-2">
          <FormSection
            title="价格与点数"
            description="用户购买价格和周期内可使用的基础点数。"
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                label="货币"
                value={form.currency}
                maxLength={3}
                onChange={(value) =>
                  onFormChange({ ...form, currency: value.toUpperCase() })
                }
              />
              <div className="hidden sm:block" />
              <MoneyField
                label="月付价格"
                valueMinor={form.monthlyPriceMinor}
                currency={form.currency}
                onChange={(value) => setNumber("monthlyPriceMinor", value)}
              />
              <MoneyField
                label="年付价格"
                valueMinor={form.annualPriceMinor}
                currency={form.currency}
                onChange={(value) => setNumber("annualPriceMinor", value)}
              />
              <NumberField
                label="每月订阅点数"
                value={form.monthlySubscriptionCredits}
                min={0}
                onChange={(value) =>
                  setNumber("monthlySubscriptionCredits", value)
                }
              />
              <NumberField
                label="每日赠送点数"
                value={form.dailyCredits}
                min={0}
                onChange={(value) => setNumber("dailyCredits", value)}
              />
            </div>
          </FormSection>

          <FormSection
            title="生成权益"
            description="限制生成任务的并发、质量、模型和排队等级。"
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <NumberField
                label="最大并发任务数"
                value={form.entitlements.maxConcurrentJobs}
                min={1}
                onChange={(value) =>
                  setEntitlement("maxConcurrentJobs", Math.max(1, value))
                }
              />
              <SelectField
                label="队列优先级"
                value={form.entitlements.queuePriority}
                options={[
                  ["standard", "标准"],
                  ["high", "高"],
                  ["highest", "最高"],
                ]}
                onChange={(value) =>
                  setEntitlement(
                    "queuePriority",
                    value as "standard" | "high" | "highest",
                  )
                }
              />
              <SelectField
                label="图片最高质量"
                value={form.entitlements.maxImageQuality}
                options={[
                  ["standard", "标准"],
                  ["hd", "高清"],
                  ["ultra", "超清"],
                ]}
                onChange={(value) =>
                  setEntitlement(
                    "maxImageQuality",
                    value as "standard" | "hd" | "ultra",
                  )
                }
              />
              <SelectField
                label="视频最高分辨率"
                value={form.entitlements.maxVideoResolution}
                options={[
                  ["720p", "720p"],
                  ["1080p", "1080p"],
                  ["4k", "4K"],
                ]}
                onChange={(value) =>
                  setEntitlement(
                    "maxVideoResolution",
                    value as "720p" | "1080p" | "4k",
                  )
                }
              />
              <div className="sm:col-span-2">
                <TextField
                  label="允许的模型组"
                  value={form.entitlements.allowedModelGroups.join(", ")}
                  placeholder="free, standard, advanced"
                  onChange={(value) =>
                    setEntitlement(
                      "allowedModelGroups",
                      value
                        .split(",")
                        .map((item) => item.trim())
                        .filter(Boolean),
                    )
                  }
                />
              </div>
            </div>
          </FormSection>

          <FormSection
            title="工作区权益"
            description="控制项目、品牌套件和团队成员的规模上限。"
          >
            <div className="grid gap-4 sm:grid-cols-3">
              <NumberField
                label="项目上限"
                value={form.entitlements.maxProjects}
                min={-1}
                helper="-1 表示不限"
                onChange={(value) => setEntitlement("maxProjects", value)}
              />
              <NumberField
                label="品牌套件上限"
                value={form.entitlements.maxBrandKits}
                min={-1}
                helper="-1 表示不限"
                onChange={(value) => setEntitlement("maxBrandKits", value)}
              />
              <NumberField
                label="团队席位上限"
                value={form.entitlements.maxTeamSeats}
                min={1}
                onChange={(value) =>
                  setEntitlement("maxTeamSeats", Math.max(1, value))
                }
              />
            </div>
          </FormSection>

          <FormSection
            title="附加权限"
            description="管理充值资格、内容水印和接口访问。"
          >
            <div className="divide-y rounded-md border">
              <ToggleField
                label="允许购买独立点数包"
                description="仅套餐仍有效时允许购买，充值点数不随套餐到期。"
                checked={form.topUpEligible}
                onChange={(checked) =>
                  onFormChange({ ...form, topUpEligible: checked })
                }
              />
              <ToggleField
                label="生成内容添加水印"
                description="开启后，该套餐生成的内容带平台水印。"
                checked={form.entitlements.watermark}
                onChange={(checked) => setEntitlement("watermark", checked)}
              />
              <ToggleField
                label="开放 API 权限"
                description="允许工作区通过开放接口使用生成能力。"
                checked={form.entitlements.apiEnabled}
                onChange={(checked) => setEntitlement("apiEnabled", checked)}
              />
            </div>
          </FormSection>
        </div>
      </fieldset>

      <div className="border-t bg-muted/20 px-5 py-5">
        {editable ? (
          <div className="grid gap-4 xl:grid-cols-[1fr_auto] xl:items-end">
            <div>
              <Label htmlFor={`billing-reason-${plan.code}`}>变更原因</Label>
              <Input
                id={`billing-reason-${plan.code}`}
                className="mt-2 max-w-2xl bg-background"
                value={form.reason}
                onChange={(event) =>
                  onFormChange({ ...form, reason: event.target.value })
                }
                placeholder="必填，例如：调整专业版点数以匹配当前模型成本"
              />
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={onReset}
                disabled={!dirty || saving}
              >
                <RotateCcw className="size-4" />
                撤销未保存修改
              </Button>
              <Button type="submit" disabled={!dirty || saving}>
                {saving && <Loader2 className="size-4 animate-spin" />}
                保存草稿
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={onPublish}
                disabled={dirty || saving}
              >
                发布版本
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-4">
            <p className="text-sm text-muted-foreground">
              当前展示的是线上已发布版本。创建草稿后即可直接编辑表单。
            </p>
            <Button type="button" onClick={onCreateDraft}>
              创建编辑草稿
            </Button>
          </div>
        )}
        {editable && (
          <p className="mt-2 text-xs text-muted-foreground">
            {dirty
              ? "存在未保存修改。请先保存草稿，再发布版本。"
              : "草稿已保存。发布前请再次核对价格、点数和权益。"}
          </p>
        )}
      </div>
    </form>
  );
}

function PlanHeading({
  plan,
  display,
  editable,
}: {
  plan: AdminBillingPlan;
  display: AdminBillingPlanVersion;
  editable: boolean;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4 border-b px-5 py-5">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-base font-semibold">{plan.nameZh}</h3>
          <VersionBadges draft={plan.draft} published={plan.published} />
        </div>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          {plan.descriptionZh || "暂无套餐说明。"}
        </p>
      </div>
      <div className="text-right text-xs text-muted-foreground">
        <div>{editable ? "正在编辑草稿" : "当前线上版本"}</div>
        <div className="mt-1 font-medium text-foreground">
          v{display.version}
        </div>
      </div>
    </div>
  );
}

function FormSection({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h4 className="text-sm font-semibold">{title}</h4>
      <p className="mt-1 text-xs text-muted-foreground">{description}</p>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function OverviewMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="border-b px-4 py-4 sm:border-r sm:last:border-r-0 xl:border-b-0">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums">
        {number(value)}
      </div>
    </div>
  );
}

function PlanMetric({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-sm font-semibold tabular-nums">
        {number(value)}
      </div>
    </div>
  );
}

function VersionBadges({
  draft,
  published,
}: {
  draft: AdminBillingPlanVersion | null;
  published: AdminBillingPlanVersion | null;
}) {
  return (
    <div className="flex flex-wrap justify-end gap-1.5 text-[11px]">
      {published && (
        <span className="rounded border border-emerald-600/30 bg-emerald-500/10 px-1.5 py-0.5 text-emerald-700">
          已发布 v{published.version}
        </span>
      )}
      {draft && (
        <span className="rounded border border-amber-600/30 bg-amber-500/10 px-1.5 py-0.5 text-amber-700">
          草稿 v{draft.version}
        </span>
      )}
    </div>
  );
}

function Notice({
  tone,
  children,
}: {
  tone: "error" | "success";
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "mx-5 mt-4 flex items-start gap-2 rounded-md border p-3 text-sm",
        tone === "error"
          ? "border-destructive/30 bg-destructive/5 text-destructive"
          : "border-emerald-600/30 bg-emerald-500/5 text-emerald-700",
      )}
    >
      {children}
    </div>
  );
}

function TextField({
  label,
  value,
  placeholder,
  maxLength,
  onChange,
}: {
  label: string;
  value: string;
  placeholder?: string;
  maxLength?: number;
  onChange: (value: string) => void;
}) {
  return (
    <div>
      <Label>{label}</Label>
      <Input
        className="mt-2"
        value={value}
        placeholder={placeholder}
        maxLength={maxLength}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

function MoneyField({
  label,
  valueMinor,
  currency,
  onChange,
}: {
  label: string;
  valueMinor: number;
  currency: string;
  onChange: (valueMinor: number) => void;
}) {
  return (
    <div>
      <Label>{label}</Label>
      <div className="relative mt-2">
        <Input
          type="number"
          min={0}
          step="0.01"
          className="pr-14 tabular-nums"
          value={(valueMinor / 100).toString()}
          onChange={(event) =>
            onChange(
              Math.max(0, Math.round((Number(event.target.value) || 0) * 100)),
            )
          }
        />
        <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted-foreground">
          {currency}
        </span>
      </div>
    </div>
  );
}

function NumberField({
  label,
  value,
  min,
  helper,
  onChange,
}: {
  label: string;
  value: number;
  min?: number;
  helper?: string;
  onChange: (value: number) => void;
}) {
  return (
    <div>
      <Label>{label}</Label>
      <Input
        type="number"
        className="mt-2 tabular-nums"
        min={min}
        value={value}
        onChange={(event) => onChange(Number(event.target.value) || 0)}
      />
      {helper && (
        <p className="mt-1 text-[11px] text-muted-foreground">{helper}</p>
      )}
    </div>
  );
}

function SelectField({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<[string, string]>;
  onChange: (value: string) => void;
}) {
  return (
    <div>
      <Label>{label}</Label>
      <select
        className="mt-2 h-9 w-full rounded-md border bg-background px-3 text-sm"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map(([id, text]) => (
          <option key={id} value={id}>
            {text}
          </option>
        ))}
      </select>
    </div>
  );
}

function ToggleField({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-4 px-4 py-3">
      <span>
        <span className="block text-sm font-medium">{label}</span>
        <span className="mt-0.5 block text-xs text-muted-foreground">
          {description}
        </span>
      </span>
      <input
        type="checkbox"
        className="size-4 shrink-0 accent-primary"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}

function versionToForm(
  version: AdminBillingPlanVersion,
): AdminUpdateBillingPlanDraft {
  return {
    currency: version.currency,
    monthlyPriceMinor: version.monthlyPriceMinor,
    annualPriceMinor: version.annualPriceMinor,
    monthlySubscriptionCredits: version.monthlySubscriptionCredits,
    dailyCredits: version.dailyCredits,
    topUpEligible: version.topUpEligible,
    entitlements: { ...version.entitlements },
    reason: "",
  };
}

function editableFingerprint(form: AdminUpdateBillingPlanDraft) {
  const { reason: _reason, ...editable } = form;
  return JSON.stringify(editable);
}

function number(value: number) {
  return new Intl.NumberFormat("zh-CN").format(value);
}
