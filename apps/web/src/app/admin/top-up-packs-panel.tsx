"use client";

import type {
  AdminSaveTopUpPackDraft,
  AdminTopUpPack,
  AdminTopUpPackVersion,
} from "@loomic/shared";
import {
  AlertTriangle,
  FilePenLine,
  Loader2,
  PackagePlus,
  RefreshCw,
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
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  fetchAdminTopUpPacks,
  publishAdminTopUpPack,
  saveAdminTopUpPackDraft,
} from "@/lib/admin-api";
import { cn } from "@/lib/utils";

type Props = { accessToken: string };

type PackForm = {
  code: string;
  credits: string;
  descriptionZh: string;
  dulupayAmount: string;
  minimumPlanCode: "pro" | "team";
  nameZh: string;
  price: string;
  reason: string;
  sortOrder: string;
};

const emptyForm: PackForm = {
  code: "",
  credits: "",
  descriptionZh: "",
  dulupayAmount: "",
  minimumPlanCode: "pro",
  nameZh: "",
  price: "",
  reason: "",
  sortOrder: "0",
};

export function TopUpPacksPanel({ accessToken }: Props) {
  const [packs, setPacks] = useState<AdminTopUpPack[]>([]);
  const [editingCode, setEditingCode] = useState<string | null>(null);
  const [form, setForm] = useState<PackForm | null>(null);
  const [publishingPack, setPublishingPack] = useState<AdminTopUpPack | null>(
    null,
  );
  const [publishReason, setPublishReason] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchAdminTopUpPacks(accessToken);
      setPacks(result.packs);
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : "无法加载点数包配置。",
      );
    } finally {
      setLoading(false);
    }
  }, [accessToken]);

  useEffect(() => void load(), [load]);

  function openNew() {
    setEditingCode(null);
    setForm({ ...emptyForm });
    setError(null);
    setSuccess(null);
  }

  function openEditor(pack: AdminTopUpPack) {
    const version = pack.draft ?? pack.published;
    if (!version) return;
    setEditingCode(pack.code);
    setForm(versionToForm(version));
    setError(null);
    setSuccess(null);
  }

  function closeEditor() {
    if (saving) return;
    setEditingCode(null);
    setForm(null);
  }

  async function saveDraft(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!form) return;
    try {
      const input = formToInput(form);
      setSaving(true);
      setError(null);
      setSuccess(null);
      const result = await saveAdminTopUpPackDraft(accessToken, input);
      setPacks(result.packs);
      const saved = result.packs.find((pack) => pack.code === input.code);
      setEditingCode(input.code);
      if (saved?.draft) setForm(versionToForm(saved.draft));
      setSuccess(`${input.nameZh}已保存为草稿，发布前不会影响用户购买。`);
    } catch (saveError) {
      setError(
        saveError instanceof Error ? saveError.message : "无法保存点数包草稿。",
      );
    } finally {
      setSaving(false);
    }
  }

  async function publishDraft(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!publishingPack) return;
    if (publishReason.trim().length < 3) {
      setError("请填写至少 3 个字的发布原因。该原因会进入审计日志。");
      return;
    }
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await publishAdminTopUpPack(
        accessToken,
        publishingPack.code,
        { reason: publishReason.trim() },
      );
      setPacks(result.packs);
      setPublishingPack(null);
      setPublishReason("");
      if (editingCode === publishingPack.code) closeEditor();
      setSuccess(
        `${displayVersion(publishingPack)?.nameZh ?? publishingPack.code}已发布。`,
      );
    } catch (publishError) {
      setError(
        publishError instanceof Error
          ? publishError.message
          : "无法发布点数包。",
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
            <h2 className="text-base font-semibold">点数包</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              配置永久有效的点数包。USD 是商品标价，DuluPay 使用单独的 CNY
              实收价。
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void load()}
              disabled={loading}
            >
              <RefreshCw className={cn("size-4", loading && "animate-spin")} />
              刷新
            </Button>
            <Button size="sm" onClick={openNew}>
              <PackagePlus className="size-4" />
              新建点数包
            </Button>
          </div>
        </div>
      </header>

      {error ? (
        <Notice tone="error">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          {error}
        </Notice>
      ) : null}
      {success ? <Notice tone="success">{success}</Notice> : null}

      <section className="overflow-x-auto" aria-label="点数包列表">
        <table className="w-full min-w-[940px] text-left text-sm">
          <thead className="border-b bg-muted/35 text-xs text-muted-foreground">
            <tr>
              <th className="px-5 py-3 font-medium">点数包</th>
              <th className="px-4 py-3 font-medium">点数</th>
              <th className="px-4 py-3 font-medium">USD 标价</th>
              <th className="px-4 py-3 font-medium">DuluPay 实收</th>
              <th className="px-4 py-3 font-medium">最低套餐</th>
              <th className="px-4 py-3 font-medium">版本状态</th>
              <th className="px-5 py-3 text-right font-medium">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {loading && packs.length === 0 ? (
              <tr>
                <td
                  colSpan={7}
                  className="px-5 py-12 text-center text-muted-foreground"
                >
                  正在读取点数包配置...
                </td>
              </tr>
            ) : packs.length === 0 ? (
              <tr>
                <td
                  colSpan={7}
                  className="px-5 py-12 text-center text-muted-foreground"
                >
                  尚未创建点数包。
                </td>
              </tr>
            ) : (
              packs.map((pack) => {
                const version = displayVersion(pack);
                return (
                  <tr key={pack.code} className="hover:bg-muted/20">
                    <td className="px-5 py-4">
                      <div className="font-medium">
                        {version?.nameZh ?? pack.code}
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {pack.code}
                      </div>
                    </td>
                    <td className="px-4 py-4 tabular-nums">
                      {version?.credits.toLocaleString() ?? "-"}
                    </td>
                    <td className="px-4 py-4 tabular-nums">
                      {version ? money(version.priceMinor, "USD") : "-"}
                    </td>
                    <td className="px-4 py-4 tabular-nums">
                      {version?.providerPrice
                        ? money(version.providerPrice.amountMinor, "CNY")
                        : "未配置"}
                    </td>
                    <td className="px-4 py-4">
                      {version?.minimumPlanCode === "team"
                        ? "团队版"
                        : "专业版"}
                    </td>
                    <td className="px-4 py-4">
                      <VersionBadges pack={pack} />
                    </td>
                    <td className="px-5 py-4">
                      <div className="flex justify-end gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => openEditor(pack)}
                        >
                          <FilePenLine className="size-4" />
                          编辑
                        </Button>
                        {pack.draft ? (
                          <Button
                            size="sm"
                            disabled={!isSellable(pack.draft)}
                            title={
                              isSellable(pack.draft)
                                ? "发布点数包"
                                : "请先配置 USD 标价和 DuluPay 实收价"
                            }
                            onClick={() => {
                              setPublishingPack(pack);
                              setPublishReason("");
                              setError(null);
                            }}
                          >
                            <Rocket className="size-4" />
                            发布
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
      </section>

      <Sheet
        open={Boolean(form)}
        onOpenChange={(open) => !open && closeEditor()}
      >
        <SheetContent>
          <form className="flex min-h-0 flex-1 flex-col" onSubmit={saveDraft}>
            <SheetHeader>
              <SheetTitle>
                {editingCode ? "编辑点数包草稿" : "新建点数包"}
              </SheetTitle>
              <SheetDescription>
                保存后生成草稿版本，只有发布操作会改变用户可购买的配置。
              </SheetDescription>
            </SheetHeader>
            <SheetBody className="space-y-5">
              {form ? (
                <PackFields
                  form={form}
                  codeLocked={Boolean(editingCode)}
                  onChange={setForm}
                />
              ) : null}
              {error ? (
                <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                  {error}
                </p>
              ) : null}
            </SheetBody>
            <SheetFooter>
              <Button
                type="button"
                variant="outline"
                onClick={closeEditor}
                disabled={saving}
              >
                取消
              </Button>
              <Button type="submit" disabled={saving}>
                {saving ? <Loader2 className="animate-spin" /> : null}保存草稿
              </Button>
            </SheetFooter>
          </form>
        </SheetContent>
      </Sheet>

      <Dialog
        open={Boolean(publishingPack)}
        onOpenChange={(open) => !open && setPublishingPack(null)}
      >
        <DialogContent className="sm:max-w-md">
          <form onSubmit={publishDraft}>
            <DialogHeader>
              <DialogTitle>发布点数包版本</DialogTitle>
              <DialogDescription>
                发布后，旧版本会自动归档，用户将立即看到新价格和点数。
              </DialogDescription>
            </DialogHeader>
            <div className="my-4 space-y-2">
              <Label htmlFor="topup-publish-reason">发布原因</Label>
              <textarea
                id="topup-publish-reason"
                className="flex min-h-24 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                maxLength={500}
                value={publishReason}
                onChange={(event) => setPublishReason(event.target.value)}
                placeholder="说明本次发布内容"
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setPublishingPack(null)}
                disabled={saving}
              >
                取消
              </Button>
              <Button type="submit" disabled={saving}>
                {saving ? <Loader2 className="animate-spin" /> : <Rocket />}
                确认发布
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function PackFields({
  form,
  codeLocked,
  onChange,
}: {
  form: PackForm;
  codeLocked: boolean;
  onChange: (form: PackForm) => void;
}) {
  const update = <K extends keyof PackForm>(key: K, value: PackForm[K]) =>
    onChange({ ...form, [key]: value });
  return (
    <>
      <Field
        label="点数包代码"
        htmlFor="topup-code"
        hint="小写字母开头，可使用数字、下划线和短横线。"
      >
        <Input
          id="topup-code"
          disabled={codeLocked}
          value={form.code}
          onChange={(event) => update("code", event.target.value.toLowerCase())}
          placeholder="pro_5000"
        />
      </Field>
      <Field label="名称" htmlFor="topup-name">
        <Input
          id="topup-name"
          value={form.nameZh}
          onChange={(event) => update("nameZh", event.target.value)}
          placeholder="5,000 点数包"
        />
      </Field>
      <Field label="说明" htmlFor="topup-description">
        <textarea
          id="topup-description"
          className="flex min-h-20 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          maxLength={500}
          value={form.descriptionZh}
          onChange={(event) => update("descriptionZh", event.target.value)}
          placeholder="向用户说明适用场景"
        />
      </Field>
      <div className="grid grid-cols-2 gap-4">
        <Field label="点数" htmlFor="topup-credits">
          <Input
            id="topup-credits"
            min="1"
            step="1"
            type="number"
            value={form.credits}
            onChange={(event) => update("credits", event.target.value)}
          />
        </Field>
        <Field label="排序" htmlFor="topup-sort">
          <Input
            id="topup-sort"
            step="1"
            type="number"
            value={form.sortOrder}
            onChange={(event) => update("sortOrder", event.target.value)}
          />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <Field
          label="USD 标价"
          htmlFor="topup-usd"
          hint="用于全球商品目录展示。"
        >
          <Input
            id="topup-usd"
            min="0.01"
            step="0.01"
            type="number"
            value={form.price}
            onChange={(event) => update("price", event.target.value)}
            placeholder="9.99"
          />
        </Field>
        <Field
          label="DuluPay CNY 实收"
          htmlFor="topup-cny"
          hint="实际支付和对账金额。"
        >
          <Input
            id="topup-cny"
            min="0.01"
            step="0.01"
            type="number"
            value={form.dulupayAmount}
            onChange={(event) => update("dulupayAmount", event.target.value)}
            placeholder="69.00"
          />
        </Field>
      </div>
      <Field label="最低套餐" htmlFor="topup-min-plan">
        <select
          id="topup-min-plan"
          className="flex h-8 w-full rounded-md border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          value={form.minimumPlanCode}
          onChange={(event) =>
            update("minimumPlanCode", event.target.value as "pro" | "team")
          }
        >
          <option value="pro">专业版及以上</option>
          <option value="team">团队版及以上</option>
        </select>
      </Field>
      <Field
        label="变更原因"
        htmlFor="topup-reason"
        hint="必填，将记录在管理员审计日志。"
      >
        <textarea
          id="topup-reason"
          className="flex min-h-24 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          maxLength={500}
          value={form.reason}
          onChange={(event) => update("reason", event.target.value)}
          placeholder="说明创建或调整点数包的原因"
        />
      </Field>
    </>
  );
}

function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function formToInput(form: PackForm): AdminSaveTopUpPackDraft {
  if (!/^[a-z][a-z0-9_-]{1,49}$/.test(form.code.trim()))
    throw new Error("点数包代码格式不正确。");
  if (!form.nameZh.trim()) throw new Error("请填写点数包名称。");
  if (form.reason.trim().length < 3)
    throw new Error("请填写至少 3 个字的变更原因。");
  const credits = Number(form.credits);
  const sortOrder = Number(form.sortOrder);
  if (!Number.isInteger(credits) || credits <= 0)
    throw new Error("点数必须是正整数。");
  if (!Number.isInteger(sortOrder)) throw new Error("排序必须是整数。");
  return {
    code: form.code.trim(),
    nameZh: form.nameZh.trim(),
    descriptionZh: form.descriptionZh.trim(),
    credits,
    currency: "USD",
    priceMinor: toMinorUnits(form.price, "USD"),
    minimumPlanCode: form.minimumPlanCode,
    sortOrder,
    dulupayAmountMinor: toMinorUnits(form.dulupayAmount, "CNY"),
    reason: form.reason.trim(),
  };
}

function versionToForm(version: AdminTopUpPackVersion): PackForm {
  return {
    code: version.code,
    nameZh: version.nameZh,
    descriptionZh: version.descriptionZh,
    credits: String(version.credits),
    price: minorToInput(version.priceMinor),
    dulupayAmount: minorToInput(version.providerPrice?.amountMinor ?? 0),
    minimumPlanCode: version.minimumPlanCode,
    sortOrder: String(version.sortOrder),
    reason: "",
  };
}

function displayVersion(pack: AdminTopUpPack) {
  return pack.draft ?? pack.published;
}
function isSellable(version: AdminTopUpPackVersion) {
  return version.priceMinor > 0 && Boolean(version.providerPrice?.amountMinor);
}
function minorToInput(value: number) {
  return (value / 100).toFixed(2);
}
function toMinorUnits(value: string, currency: string) {
  const normalized = value.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(normalized))
    throw new Error(`${currency} 金额格式不正确。`);
  const [whole, fraction = ""] = normalized.split(".");
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(amount) || amount <= 0)
    throw new Error(`${currency} 金额必须大于 0。`);
  return amount;
}
function money(value: number, currency: "USD" | "CNY") {
  return new Intl.NumberFormat("zh-CN", { style: "currency", currency }).format(
    value / 100,
  );
}

function VersionBadges({ pack }: { pack: AdminTopUpPack }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {pack.published ? (
        <span className="rounded-md bg-emerald-500/10 px-2 py-1 text-xs font-medium text-emerald-700 dark:text-emerald-400">
          线上 v{pack.published.version}
        </span>
      ) : null}
      {pack.draft ? (
        <span className="rounded-md bg-amber-500/10 px-2 py-1 text-xs font-medium text-amber-700 dark:text-amber-400">
          草稿 v{pack.draft.version}
        </span>
      ) : null}
    </div>
  );
}

function Notice({
  tone,
  children,
}: { tone: "error" | "success"; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "flex items-start gap-2 border-b px-5 py-3 text-sm",
        tone === "error"
          ? "border-destructive/20 bg-destructive/5 text-destructive"
          : "border-emerald-500/20 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400",
      )}
    >
      {children}
    </div>
  );
}
