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
  Plus,
  Rocket,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

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

type Props = { accessToken: string };

type Mutation = {
  action: "create" | "publish";
  plan: AdminBillingPlan;
} | null;

export function BillingPlansPanel({ accessToken }: Props) {
  const [plans, setPlans] = useState<AdminBillingPlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<AdminBillingPlan | null>(null);
  const [mutation, setMutation] = useState<Mutation>(null);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

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

  async function submitMutation(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!mutation || reason.trim().length < 3) {
      setError("请填写至少 3 个字的操作原因。");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result =
        mutation.action === "publish"
          ? await publishAdminBillingPlan(accessToken, mutation.plan.code, {
              reason: reason.trim(),
            })
          : await createAdminBillingPlanDraft(accessToken, mutation.plan.code, {
              reason: reason.trim(),
            });
      setPlans(result.plans);
      setMutation(null);
      setReason("");
    } catch (mutationError) {
      setError(
        mutationError instanceof Error
          ? mutationError.message
          : "套餐操作失败。",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-4">
        <div>
          <h2 className="text-sm font-semibold">套餐版本</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            价格、点数和权益以 PostgreSQL 中的已发布版本为准。
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void load()}
          disabled={loading}
        >
          {loading && (
            <Loader2 data-icon="inline-start" className="animate-spin" />
          )}
          刷新配置
        </Button>
      </div>

      {error && (
        <div className="m-4 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          {error}
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[1180px] text-left text-sm">
          <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
            <tr>
              <th className="px-5 py-3 font-medium">套餐</th>
              <th className="px-4 py-3 font-medium">版本状态</th>
              <th className="px-4 py-3 font-medium">月付 / 年付</th>
              <th className="px-4 py-3 font-medium">订阅点数</th>
              <th className="px-4 py-3 font-medium">每日赠送</th>
              <th className="px-4 py-3 font-medium">并发</th>
              <th className="px-4 py-3 font-medium">图片 / 视频</th>
              <th className="px-4 py-3 font-medium">充值资格</th>
              <th className="px-5 py-3 text-right font-medium">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {loading && plans.length === 0 ? (
              <tr>
                <td
                  colSpan={9}
                  className="px-5 py-12 text-center text-muted-foreground"
                >
                  正在加载套餐配置...
                </td>
              </tr>
            ) : (
              plans.map((plan) => {
                const display = plan.draft ?? plan.published;
                return (
                  <tr key={plan.id} className="align-top hover:bg-muted/20">
                    <td className="px-5 py-4">
                      <div className="font-medium">{plan.nameZh}</div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {plan.code}
                      </div>
                    </td>
                    <td className="px-4 py-4">
                      <VersionStatus
                        draft={plan.draft}
                        published={plan.published}
                      />
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
                      {display
                        ? `${imageLabel(display.entitlements.maxImageQuality)} / ${display.entitlements.maxVideoResolution}`
                        : "—"}
                    </td>
                    <td className="px-4 py-4">
                      {display?.topUpEligible ? "允许" : "不允许"}
                    </td>
                    <td className="px-5 py-4">
                      <div className="flex justify-end gap-2">
                        {plan.draft ? (
                          <>
                            <Button
                              size="icon"
                              variant="ghost"
                              title="编辑草稿"
                              aria-label={`编辑${plan.nameZh}草稿`}
                              onClick={() => setEditing(plan)}
                            >
                              <FilePenLine className="size-4" />
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              title="发布版本"
                              aria-label={`发布${plan.nameZh}版本`}
                              onClick={() => {
                                setMutation({ action: "publish", plan });
                                setReason("");
                              }}
                            >
                              <Rocket className="size-4" />
                            </Button>
                          </>
                        ) : plan.published ? (
                          <Button
                            size="icon"
                            variant="ghost"
                            title="创建新草稿"
                            aria-label={`为${plan.nameZh}创建新草稿`}
                            onClick={() => {
                              setMutation({ action: "create", plan });
                              setReason("");
                            }}
                          >
                            <Plus className="size-4" />
                          </Button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <EditPlanDialog
        accessToken={accessToken}
        plan={editing}
        onClose={() => setEditing(null)}
        onSaved={(nextPlans) => {
          setPlans(nextPlans);
          setEditing(null);
        }}
      />

      <Dialog
        open={Boolean(mutation)}
        onOpenChange={(open) => !open && setMutation(null)}
      >
        <DialogContent className="sm:max-w-md">
          <form onSubmit={submitMutation}>
            <DialogHeader>
              <DialogTitle>
                {mutation?.action === "publish" ? "发布套餐版本" : "创建新草稿"}
              </DialogTitle>
              <DialogDescription>
                {mutation?.action === "publish"
                  ? "发布后该版本不可修改。后续调整必须创建新草稿和新版本。"
                  : "从当前已发布版本复制配置，创建一个可编辑的新草稿。"}
              </DialogDescription>
            </DialogHeader>
            <div className="py-5">
              <Label htmlFor="billing-mutation-reason">操作原因</Label>
              <Input
                id="billing-mutation-reason"
                className="mt-2"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="例如：根据新模型成本调整套餐额度"
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setMutation(null)}
              >
                取消
              </Button>
              <Button type="submit" disabled={saving}>
                {saving && (
                  <Loader2 data-icon="inline-start" className="animate-spin" />
                )}
                确认{mutation?.action === "publish" ? "发布" : "创建"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function EditPlanDialog({
  accessToken,
  plan,
  onClose,
  onSaved,
}: {
  accessToken: string;
  plan: AdminBillingPlan | null;
  onClose: () => void;
  onSaved: (plans: AdminBillingPlan[]) => void;
}) {
  const draft = plan?.draft;
  const [form, setForm] = useState<AdminUpdateBillingPlanDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setForm(
      draft
        ? {
            currency: draft.currency,
            monthlyPriceMinor: draft.monthlyPriceMinor,
            annualPriceMinor: draft.annualPriceMinor,
            monthlySubscriptionCredits: draft.monthlySubscriptionCredits,
            dailyCredits: draft.dailyCredits,
            topUpEligible: draft.topUpEligible,
            entitlements: draft.entitlements,
            reason: "",
          }
        : null,
    );
    setError(null);
  }, [draft]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!plan || !form || form.reason.trim().length < 3) {
      setError("请填写至少 3 个字的变更原因。");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await updateAdminBillingPlanDraft(
        accessToken,
        plan.code,
        form,
      );
      onSaved(result.plans);
    } catch (saveError) {
      setError(
        saveError instanceof Error ? saveError.message : "无法保存套餐草稿。",
      );
    } finally {
      setSaving(false);
    }
  }

  function setNumber(
    field: keyof Pick<
      AdminUpdateBillingPlanDraft,
      | "monthlyPriceMinor"
      | "annualPriceMinor"
      | "monthlySubscriptionCredits"
      | "dailyCredits"
    >,
    value: string,
  ) {
    setForm((current) =>
      current
        ? { ...current, [field]: Math.max(0, Number(value) || 0) }
        : current,
    );
  }

  function setEntitlement<
    K extends keyof AdminUpdateBillingPlanDraft["entitlements"],
  >(field: K, value: AdminUpdateBillingPlanDraft["entitlements"][K]) {
    setForm((current) =>
      current
        ? {
            ...current,
            entitlements: { ...current.entitlements, [field]: value },
          }
        : current,
    );
  }

  return (
    <Dialog open={Boolean(plan)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        {form && (
          <form onSubmit={submit}>
            <DialogHeader>
              <DialogTitle>编辑{plan?.nameZh}草稿</DialogTitle>
              <DialogDescription>
                这里只修改草稿。保存后需要单独发布，运行时才会生效。
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-5 py-5 sm:grid-cols-2">
              <NumberField
                label="月付价格（最小货币单位）"
                value={form.monthlyPriceMinor}
                onChange={(value) => setNumber("monthlyPriceMinor", value)}
              />
              <NumberField
                label="年付价格（最小货币单位）"
                value={form.annualPriceMinor}
                onChange={(value) => setNumber("annualPriceMinor", value)}
              />
              <NumberField
                label="每月订阅点数"
                value={form.monthlySubscriptionCredits}
                onChange={(value) =>
                  setNumber("monthlySubscriptionCredits", value)
                }
              />
              <NumberField
                label="每日赠送点数"
                value={form.dailyCredits}
                onChange={(value) => setNumber("dailyCredits", value)}
              />
              <NumberField
                label="最大并发任务数"
                value={form.entitlements.maxConcurrentJobs}
                onChange={(value) =>
                  setEntitlement(
                    "maxConcurrentJobs",
                    Math.max(1, Number(value) || 1),
                  )
                }
              />
              <NumberField
                label="项目数量上限（-1 为不限）"
                value={form.entitlements.maxProjects}
                onChange={(value) =>
                  setEntitlement("maxProjects", Number(value) || 0)
                }
              />
              <NumberField
                label="品牌套件上限（-1 为不限）"
                value={form.entitlements.maxBrandKits}
                onChange={(value) =>
                  setEntitlement("maxBrandKits", Number(value) || 0)
                }
              />
              <NumberField
                label="团队席位上限"
                value={form.entitlements.maxTeamSeats}
                onChange={(value) =>
                  setEntitlement(
                    "maxTeamSeats",
                    Math.max(1, Number(value) || 1),
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
              <div>
                <Label htmlFor="billing-model-groups">允许的模型组</Label>
                <Input
                  id="billing-model-groups"
                  className="mt-2"
                  value={form.entitlements.allowedModelGroups.join(", ")}
                  onChange={(event) =>
                    setEntitlement(
                      "allowedModelGroups",
                      event.target.value
                        .split(",")
                        .map((item) => item.trim())
                        .filter(Boolean),
                    )
                  }
                />
              </div>
              <ToggleField
                label="允许购买独立点数包"
                checked={form.topUpEligible}
                onChange={(checked) =>
                  setForm((current) =>
                    current ? { ...current, topUpEligible: checked } : current,
                  )
                }
              />
              <ToggleField
                label="生成内容添加水印"
                checked={form.entitlements.watermark}
                onChange={(checked) => setEntitlement("watermark", checked)}
              />
              <ToggleField
                label="开放 API 权限"
                checked={form.entitlements.apiEnabled}
                onChange={(checked) => setEntitlement("apiEnabled", checked)}
              />
              <div className="sm:col-span-2">
                <Label htmlFor="billing-edit-reason">变更原因</Label>
                <Input
                  id="billing-edit-reason"
                  className="mt-2"
                  value={form.reason}
                  onChange={(event) =>
                    setForm({ ...form, reason: event.target.value })
                  }
                  placeholder="该原因会写入管理员审计日志"
                />
              </div>
            </div>
            {error && <p className="mb-4 text-sm text-destructive">{error}</p>}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                取消
              </Button>
              <Button type="submit" disabled={saving}>
                {saving && (
                  <Loader2 data-icon="inline-start" className="animate-spin" />
                )}
                保存草稿
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function VersionStatus({
  draft,
  published,
}: {
  draft: AdminBillingPlanVersion | null;
  published: AdminBillingPlanVersion | null;
}) {
  return (
    <div className="space-y-1 text-xs">
      {published && (
        <div>
          <span className="inline-flex rounded border border-emerald-600/30 bg-emerald-500/10 px-1.5 py-0.5 text-emerald-700">
            已发布 v{published.version}
          </span>
        </div>
      )}
      {draft && (
        <div>
          <span className="inline-flex rounded border border-amber-600/30 bg-amber-500/10 px-1.5 py-0.5 text-amber-700">
            草稿 v{draft.version}
          </span>
        </div>
      )}
    </div>
  );
}

function NumberField({
  label,
  value,
  onChange,
}: { label: string; value: number; onChange: (value: string) => void }) {
  return (
    <div>
      <Label>{label}</Label>
      <Input
        type="number"
        className="mt-2"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
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
  checked,
  onChange,
}: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <label className="flex h-9 items-center gap-2 self-end rounded-md border px-3 text-sm">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      {label}
    </label>
  );
}

function money(value: number, currency: string) {
  return new Intl.NumberFormat("zh-CN", { style: "currency", currency }).format(
    value / 100,
  );
}

function imageLabel(value: string) {
  return (
    ({ standard: "标准", hd: "高清", ultra: "超清" } as Record<string, string>)[
      value
    ] ?? value
  );
}
