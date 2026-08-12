"use client";

import type {
  AdminBillingPlan,
  AdminBillingPlanVersion,
  AdminUpdateBillingPlanDraft,
} from "@loomic/shared";
import {
  AlertTriangle,
  FilePenLine,
  Loader2,
  RefreshCw,
  Rocket,
  RotateCcw,
} from "lucide-react";
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
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  createAdminBillingPlanDraft,
  fetchAdminBillingPlans,
  publishAdminBillingPlan,
  updateAdminBillingPlanDraft,
} from "@/lib/admin-api";
import { cn } from "@/lib/utils";

type Props = { accessToken: string };

export function BillingPlansPanel({ accessToken }: Props) {
  const [plans, setPlans] = useState<AdminBillingPlan[]>([]);
  const [editingPlan, setEditingPlan] = useState<AdminBillingPlan | null>(null);
  const [form, setForm] = useState<AdminUpdateBillingPlanDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [publishingPlan, setPublishingPlan] = useState<AdminBillingPlan | null>(
    null,
  );
  const [publishReason, setPublishReason] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchAdminBillingPlans(accessToken);
      setPlans(result.plans);
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : "无法加载套餐配置。",
      );
    } finally {
      setLoading(false);
    }
  }, [accessToken]);

  useEffect(() => void load(), [load]);

  const initialDraft = useMemo(() => {
    const version = editingPlan?.draft ?? editingPlan?.published;
    return version ? versionToForm(version) : null;
  }, [editingPlan?.draft, editingPlan?.published]);
  const dirty = Boolean(
    form &&
      initialDraft &&
      editableFingerprint(form) !== editableFingerprint(initialDraft),
  );

  function openEditor(plan: AdminBillingPlan) {
    setError(null);
    setSuccess(null);
    const version = plan.draft ?? plan.published;
    if (!version) return;
    setEditingPlan(plan);
    setForm(versionToForm(version));
  }

  function closeEditor() {
    setEditingPlan(null);
    setForm(null);
  }

  function openPublish(plan: AdminBillingPlan) {
    if (!plan.draft) return;
    setError(null);
    setSuccess(null);
    setPublishingPlan(plan);
    setPublishReason("");
  }

  async function saveDraft(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editingPlan || !form) return;
    if (form.reason.trim().length < 3) {
      setError("请填写至少 3 个字的变更原因。该原因会进入审计日志。");
      return;
    }
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      let currentPlan = editingPlan;
      if (!currentPlan.draft) {
        const draftResult = await createAdminBillingPlanDraft(
          accessToken,
          currentPlan.code,
          { reason: form.reason.trim() },
        );
        const createdPlan = draftResult.plans.find(
          (plan) => plan.code === currentPlan.code,
        );
        if (!createdPlan?.draft) {
          throw new Error("无法创建套餐编辑草稿。");
        }
        currentPlan = createdPlan;
        setPlans(draftResult.plans);
      }

      const result = await updateAdminBillingPlanDraft(
        accessToken,
        currentPlan.code,
        { ...form, reason: form.reason.trim() },
      );
      setPlans(result.plans);
      const nextPlan = result.plans.find(
        (plan) => plan.code === currentPlan.code,
      );
      if (nextPlan?.draft) {
        setEditingPlan(nextPlan);
        setForm(versionToForm(nextPlan.draft));
      }
      setSuccess(`${currentPlan.nameZh}配置已保存为草稿，尚未影响线上套餐。`);
    } catch (saveError) {
      setError(
        saveError instanceof Error ? saveError.message : "无法保存套餐草稿。",
      );
    } finally {
      setSaving(false);
    }
  }

  async function publishDraft(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!publishingPlan || publishReason.trim().length < 3) {
      setError("请填写至少 3 个字的发布原因。该原因会进入审计日志。");
      return;
    }
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await publishAdminBillingPlan(
        accessToken,
        publishingPlan.code,
        { reason: publishReason.trim() },
      );
      setPlans(result.plans);
      if (editingPlan?.code === publishingPlan.code) {
        closeEditor();
      }
      setPublishingPlan(null);
      setPublishReason("");
      setSuccess(`${publishingPlan.nameZh}已发布，新配置现在开始生效。`);
    } catch (publishError) {
      setError(
        publishError instanceof Error
          ? publishError.message
          : "无法发布套餐版本。",
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
      </header>

      {error && (
        <Notice tone="error">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          {error}
        </Notice>
      )}
      {success && <Notice tone="success">{success}</Notice>}

      <section aria-label="套餐列表" className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead className="border-b bg-muted/35 text-xs text-muted-foreground">
            <tr>
              <th className="px-5 py-3 font-medium">套餐</th>
              <th className="px-4 py-3 font-medium">月付 / 年付</th>
              <th className="px-4 py-3 font-medium">订阅点数</th>
              <th className="px-4 py-3 font-medium">每日赠送</th>
              <th className="px-4 py-3 font-medium">最大并发</th>
              <th className="px-4 py-3 font-medium">版本状态</th>
              <th className="px-5 py-3 text-right font-medium">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {loading && plans.length === 0 ? (
              <tr>
                <td
                  colSpan={7}
                  className="px-5 py-12 text-center text-muted-foreground"
                >
                  正在读取套餐配置...
                </td>
              </tr>
            ) : (
              plans.map((plan) => {
                const display = plan.draft ?? plan.published;
                return (
                  <tr key={plan.id} className="hover:bg-muted/20">
                    <td className="px-5 py-4">
                      <div className="font-medium">{plan.nameZh}</div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {plan.code}
                      </div>
                    </td>
                    <td className="px-4 py-4 tabular-nums">
                      {display
                        ? `${money(display.monthlyPriceMinor, display.currency)} / ${money(display.annualPriceMinor, display.currency)}`
                        : "—"}
                    </td>
                    <td className="px-4 py-4 tabular-nums">
                      {display?.monthlySubscriptionCredits.toLocaleString() ??
                        "—"}
                    </td>
                    <td className="px-4 py-4 tabular-nums">
                      {display?.dailyCredits.toLocaleString() ?? "—"}
                    </td>
                    <td className="px-4 py-4 tabular-nums">
                      {display?.entitlements.maxConcurrentJobs ?? "—"}
                    </td>
                    <td className="px-4 py-4">
                      <VersionBadges
                        draft={plan.draft}
                        published={plan.published}
                      />
                    </td>
                    <td className="px-5 py-4">
                      <div className="flex justify-end gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => openEditor(plan)}
                        >
                          <FilePenLine className="size-4" />
                          编辑
                        </Button>
                        {plan.draft && (
                          <Button
                            type="button"
                            size="sm"
                            onClick={() => openPublish(plan)}
                          >
                            <Rocket className="size-4" />
                            发布
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </section>

      <Dialog
        open={Boolean(publishingPlan)}
        onOpenChange={(open) => !open && setPublishingPlan(null)}
      >
        <DialogContent className="sm:max-w-md">
          <form onSubmit={publishDraft}>
            <DialogHeader>
              <DialogTitle>发布{publishingPlan?.nameZh}版本</DialogTitle>
              <DialogDescription>
                发布后该草稿将成为线上生效版本，后续修改需要创建新的草稿。
              </DialogDescription>
            </DialogHeader>
            <div className="py-5">
              <Label htmlFor="billing-publish-reason">发布原因</Label>
              <Input
                id="billing-publish-reason"
                className="mt-2"
                value={publishReason}
                onChange={(event) => setPublishReason(event.target.value)}
                placeholder="例如：完成本轮套餐权益调整"
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setPublishingPlan(null)}
              >
                取消
              </Button>
              <Button type="submit" disabled={saving}>
                {saving && <Loader2 className="size-4 animate-spin" />}
                确认发布
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Sheet
        open={Boolean(editingPlan)}
        onOpenChange={(open) => !open && closeEditor()}
      >
        <SheetContent className="max-w-3xl">
          {editingPlan && form && (
            <>
              <SheetHeader>
                <SheetTitle>编辑{editingPlan.nameZh}</SheetTitle>
                <SheetDescription>
                  修改内容会先保存为草稿，不会直接改变线上已发布版本。
                </SheetDescription>
              </SheetHeader>
              <SheetBody>
                <PlanEditor
                  plan={editingPlan}
                  form={form}
                  dirty={dirty}
                  saving={saving}
                  onFormChange={setForm}
                  onSave={saveDraft}
                />
              </SheetBody>
              <div className="flex shrink-0 items-center justify-end gap-2 border-t bg-muted/30 px-5 py-3">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    if (editingPlan.draft) {
                      setForm(versionToForm(editingPlan.draft));
                    }
                  }}
                  disabled={!dirty || saving}
                >
                  <RotateCcw className="size-4" />
                  撤销修改
                </Button>
                <Button
                  type="submit"
                  form={`billing-plan-form-${editingPlan.code}`}
                  disabled={!dirty || saving}
                >
                  {saving && <Loader2 className="size-4 animate-spin" />}
                  保存草稿
                </Button>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function PlanEditor({
  plan,
  form,
  dirty,
  saving,
  onFormChange,
  onSave,
}: {
  plan: AdminBillingPlan;
  form: AdminUpdateBillingPlanDraft;
  dirty: boolean;
  saving: boolean;
  onFormChange: (form: AdminUpdateBillingPlanDraft) => void;
  onSave: (event: React.FormEvent<HTMLFormElement>) => void;
}) {
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
    <form
      id={`billing-plan-form-${plan.code}`}
      onSubmit={onSave}
      className="space-y-8"
    >
      <div className="grid gap-x-8 gap-y-8 xl:grid-cols-2">
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
      <div>
        <Label htmlFor={`billing-reason-${plan.code}`}>变更原因</Label>
        <Input
          id={`billing-reason-${plan.code}`}
          className="mt-2 bg-background"
          value={form.reason}
          onChange={(event) =>
            onFormChange({ ...form, reason: event.target.value })
          }
          placeholder="必填，例如：调整专业版点数以匹配当前模型成本"
        />
        <p className="mt-2 text-xs text-muted-foreground">
          {dirty
            ? "存在未保存修改。请填写原因后保存草稿。"
            : "草稿已保存。修改字段后可再次保存。"}
        </p>
      </div>
    </form>
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

function money(value: number, currency: string) {
  return new Intl.NumberFormat("zh-CN", { style: "currency", currency }).format(
    value / 100,
  );
}
