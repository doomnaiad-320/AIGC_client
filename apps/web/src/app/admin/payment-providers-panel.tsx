"use client";

import type { AdminPaymentProviderConfig, PaymentMethod } from "@loomic/shared";
import {
  AlertTriangle,
  CheckCircle2,
  KeyRound,
  Loader2,
  PlugZap,
  RefreshCw,
  Save,
  ShieldAlert,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  fetchAdminPaymentProvider,
  testAdminPaymentProvider,
  updateAdminPaymentProvider,
} from "@/lib/admin-api";
import { cn } from "@/lib/utils";

type Props = { accessToken: string };
type ProviderForm = {
  enabled: boolean;
  apiBaseUrl: string;
  merchantId: string;
  merchantPrivateKey: string;
  platformPublicKey: string;
  allowedMethods: PaymentMethod[];
  callbackToleranceSeconds: string;
  reason: string;
};

export function PaymentProvidersPanel({ accessToken }: Props) {
  const [config, setConfig] = useState<AdminPaymentProviderConfig | null>(null);
  const [form, setForm] = useState<ProviderForm | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{
    merchantStatus: number;
    payStatus: number;
  } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchAdminPaymentProvider(accessToken);
      setConfig(result.config);
      setForm(toForm(result.config));
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : "无法加载支付配置。",
      );
    } finally {
      setLoading(false);
    }
  }, [accessToken]);
  useEffect(() => void load(), [load]);

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!form) return;
    if (form.reason.trim().length < 3) {
      setError("请填写至少 3 个字的变更原因。");
      return;
    }
    if (form.allowedMethods.length === 0) {
      setError("至少启用一种支付方式。");
      return;
    }
    const tolerance = Number(form.callbackToleranceSeconds);
    if (!Number.isInteger(tolerance) || tolerance < 60 || tolerance > 604800) {
      setError("回调时间容差必须是 60 至 604800 秒之间的整数。");
      return;
    }
    setSaving(true);
    setError(null);
    setSuccess(null);
    setTestResult(null);
    try {
      const result = await updateAdminPaymentProvider(accessToken, {
        enabled: form.enabled,
        apiBaseUrl: form.apiBaseUrl.trim(),
        merchantId: form.merchantId.trim(),
        ...(form.merchantPrivateKey.trim()
          ? { merchantPrivateKey: form.merchantPrivateKey.trim() }
          : {}),
        platformPublicKey: form.platformPublicKey.trim(),
        allowedMethods: form.allowedMethods,
        callbackToleranceSeconds: tolerance,
        reason: form.reason.trim(),
      });
      setConfig(result.config);
      setForm(toForm(result.config));
      setSuccess("DuluPay 配置已保存，敏感凭据已加密写入 PostgreSQL。");
    } catch (saveError) {
      setError(
        saveError instanceof Error ? saveError.message : "无法保存支付配置。",
      );
    } finally {
      setSaving(false);
    }
  }

  async function testConnection() {
    setTesting(true);
    setError(null);
    setSuccess(null);
    setTestResult(null);
    try {
      const result = await testAdminPaymentProvider(accessToken);
      setTestResult(result);
    } catch (testError) {
      setError(
        testError instanceof Error
          ? testError.message
          : "DuluPay 连接测试失败。",
      );
    } finally {
      setTesting(false);
    }
  }

  const update = <K extends keyof ProviderForm>(
    key: K,
    value: ProviderForm[K],
  ) => form && setForm({ ...form, [key]: value });
  const toggleMethod = (method: PaymentMethod) =>
    form &&
    update(
      "allowedMethods",
      form.allowedMethods.includes(method)
        ? form.allowedMethods.filter((item) => item !== method)
        : [...form.allowedMethods, method],
    );

  return (
    <div className="min-w-0">
      <header className="border-b px-5 py-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold">支付配置</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              配置 DuluPay 商户、RSA 密钥、支付方式和回调安全策略。
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void load()}
            disabled={loading}
          >
            <RefreshCw className={cn("size-4", loading && "animate-spin")} />
            刷新
          </Button>
        </div>
      </header>

      {!config?.encryptionReady && !loading ? (
        <Notice tone="warning">
          <ShieldAlert className="mt-0.5 size-4 shrink-0" />
          <div>
            <div className="font-medium">支付密钥加密尚未就绪</div>
            <div className="mt-1 text-muted-foreground">
              请在服务端设置独立的
              PAYMENT_CONFIG_ENCRYPTION_KEY，之后才能保存商户私钥并启用支付。
            </div>
          </div>
        </Notice>
      ) : null}
      {error ? (
        <Notice tone="error">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          {error}
        </Notice>
      ) : null}
      {success ? (
        <Notice tone="success">
          <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
          {success}
        </Notice>
      ) : null}

      {loading || !form ? (
        <div className="px-5 py-12 text-center text-sm text-muted-foreground">
          正在读取支付配置...
        </div>
      ) : (
        <form onSubmit={save}>
          <div className="grid gap-6 px-5 py-6 xl:grid-cols-[minmax(0,1fr)_320px]">
            <div className="space-y-5">
              <div className="flex items-center justify-between rounded-md border px-4 py-3">
                <div>
                  <div className="text-sm font-medium">启用 DuluPay</div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    关闭后用户端不会展示任何点数包。
                  </div>
                </div>
                <label className="inline-flex cursor-pointer items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="size-4 accent-foreground"
                    checked={form.enabled}
                    onChange={(event) =>
                      update("enabled", event.target.checked)
                    }
                  />
                  <span>{form.enabled ? "已启用" : "已停用"}</span>
                </label>
              </div>
              <Field label="API Base URL" htmlFor="dulupay-url">
                <Input
                  id="dulupay-url"
                  type="url"
                  value={form.apiBaseUrl}
                  onChange={(event) => update("apiBaseUrl", event.target.value)}
                />
              </Field>
              <Field label="Merchant ID" htmlFor="dulupay-merchant">
                <Input
                  id="dulupay-merchant"
                  value={form.merchantId}
                  onChange={(event) => update("merchantId", event.target.value)}
                  placeholder="DuluPay 商户号"
                />
              </Field>
              <Field
                label="商户 RSA 私钥"
                htmlFor="dulupay-private"
                hint={
                  config?.hasMerchantPrivateKey
                    ? "私钥已配置。留空将保留原值，填写内容会替换原私钥。"
                    : "首次启用支付前必须填写。接口不会回显已保存的私钥。"
                }
              >
                <textarea
                  id="dulupay-private"
                  className="flex min-h-32 w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                  autoComplete="off"
                  spellCheck={false}
                  value={form.merchantPrivateKey}
                  onChange={(event) =>
                    update("merchantPrivateKey", event.target.value)
                  }
                  placeholder="-----BEGIN PRIVATE KEY-----"
                />
              </Field>
              <Field
                label="DuluPay 平台 RSA 公钥"
                htmlFor="dulupay-public"
                hint="用于验证下单响应和异步回调签名。"
              >
                <textarea
                  id="dulupay-public"
                  className="flex min-h-32 w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                  spellCheck={false}
                  value={form.platformPublicKey}
                  onChange={(event) =>
                    update("platformPublicKey", event.target.value)
                  }
                  placeholder="-----BEGIN PUBLIC KEY-----"
                />
              </Field>
            </div>
            <div className="space-y-5">
              <section className="rounded-md border p-4">
                <h3 className="text-sm font-medium">可用支付方式</h3>
                <div className="mt-3 space-y-2">
                  <MethodCheckbox
                    label="支付宝"
                    checked={form.allowedMethods.includes("alipay")}
                    onChange={() => toggleMethod("alipay")}
                  />
                  <MethodCheckbox
                    label="微信支付"
                    checked={form.allowedMethods.includes("wxpay")}
                    onChange={() => toggleMethod("wxpay")}
                  />
                </div>
              </section>
              <Field
                label="回调时间容差（秒）"
                htmlFor="dulupay-tolerance"
                hint="建议 300 秒。超出时间窗口的回调会被拒绝。"
              >
                <Input
                  id="dulupay-tolerance"
                  min="60"
                  max="604800"
                  step="1"
                  type="number"
                  value={form.callbackToleranceSeconds}
                  onChange={(event) =>
                    update("callbackToleranceSeconds", event.target.value)
                  }
                />
              </Field>
              <Field
                label="变更原因"
                htmlFor="dulupay-reason"
                hint="必填，将记录在管理员审计日志。"
              >
                <textarea
                  id="dulupay-reason"
                  className="flex min-h-24 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                  maxLength={500}
                  value={form.reason}
                  onChange={(event) => update("reason", event.target.value)}
                  placeholder="说明本次支付配置变更"
                />
              </Field>
              <section className="rounded-md border bg-muted/20 p-4">
                <div className="flex items-center gap-2">
                  <KeyRound className="size-4" />
                  <h3 className="text-sm font-medium">凭据状态</h3>
                </div>
                <dl className="mt-3 space-y-2 text-xs">
                  <StatusRow
                    label="商户私钥"
                    value={config?.hasMerchantPrivateKey ? "已配置" : "未配置"}
                    ok={Boolean(config?.hasMerchantPrivateKey)}
                  />
                  <StatusRow
                    label="加密密钥"
                    value={config?.encryptionReady ? "已就绪" : "未就绪"}
                    ok={Boolean(config?.encryptionReady)}
                  />
                  <StatusRow
                    label="渠道状态"
                    value={config?.enabled ? "已启用" : "已停用"}
                    ok={Boolean(config?.enabled)}
                  />
                </dl>
              </section>
              {testResult ? (
                <section className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-4 text-sm">
                  <div className="flex items-center gap-2 font-medium text-emerald-700 dark:text-emerald-400">
                    <CheckCircle2 className="size-4" />
                    连接测试完成
                  </div>
                  <div className="mt-2 text-xs text-muted-foreground">
                    商户状态：{testResult.merchantStatus} · 支付状态：
                    {testResult.payStatus}
                  </div>
                </section>
              ) : null}
            </div>
          </div>
          <div className="flex flex-wrap justify-end gap-2 border-t bg-muted/20 px-5 py-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => void testConnection()}
              disabled={
                testing ||
                saving ||
                !config?.hasMerchantPrivateKey ||
                !config?.encryptionReady
              }
            >
              {testing ? <Loader2 className="animate-spin" /> : <PlugZap />}
              测试连接
            </Button>
            <Button type="submit" disabled={saving || !config?.encryptionReady}>
              {saving ? <Loader2 className="animate-spin" /> : <Save />}保存配置
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

function toForm(config: AdminPaymentProviderConfig): ProviderForm {
  return {
    enabled: config.enabled,
    apiBaseUrl: config.apiBaseUrl,
    merchantId: config.merchantId ?? "",
    merchantPrivateKey: "",
    platformPublicKey: config.platformPublicKey ?? "",
    allowedMethods: config.allowedMethods,
    callbackToleranceSeconds: String(config.callbackToleranceSeconds),
    reason: "",
  };
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
      {hint ? (
        <p className="text-xs leading-5 text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}
function MethodCheckbox({
  label,
  checked,
  onChange,
}: { label: string; checked: boolean; onChange: () => void }) {
  return (
    <label className="flex cursor-pointer items-center justify-between rounded-md border px-3 py-2.5 text-sm">
      <span>{label}</span>
      <input
        type="checkbox"
        className="size-4 accent-foreground"
        checked={checked}
        onChange={onChange}
      />
    </label>
  );
}
function StatusRow({
  label,
  value,
  ok,
}: { label: string; value: string; ok: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd
        className={
          ok
            ? "font-medium text-emerald-700 dark:text-emerald-400"
            : "font-medium text-amber-700 dark:text-amber-400"
        }
      >
        {value}
      </dd>
    </div>
  );
}
function Notice({
  tone,
  children,
}: { tone: "error" | "success" | "warning"; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "flex items-start gap-2 border-b px-5 py-3 text-sm",
        tone === "error"
          ? "border-destructive/20 bg-destructive/5 text-destructive"
          : tone === "success"
            ? "border-emerald-500/20 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400"
            : "border-amber-500/20 bg-amber-500/5 text-amber-800 dark:text-amber-300",
      )}
    >
      {children}
    </div>
  );
}
