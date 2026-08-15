"use client";

import type {
  PaymentMethod,
  TopUpOrderStatus,
  TopUpPack,
} from "@loomic/shared";
import {
  AlertTriangle,
  CheckCircle2,
  Coins,
  Loader2,
  RefreshCw,
  ShieldCheck,
  WalletCards,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth-context";
import {
  createTopUpCheckout,
  fetchTopUpOrder,
  fetchTopUpPacks,
} from "@/lib/top-up-payments-api";
import { cn } from "@/lib/utils";

const pendingOrderKey = "loomic:pending-topup-order";

export function TopUpPacksSection({ currentPlan }: { currentPlan: string }) {
  const { session } = useAuth();
  const tokenRef = useRef(session?.access_token);
  tokenRef.current = session?.access_token;
  const [packs, setPacks] = useState<TopUpPack[]>([]);
  const [selectedCode, setSelectedCode] = useState<string | null>(null);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("alipay");
  const [loading, setLoading] = useState(true);
  const [checkingOut, setCheckingOut] = useState(false);
  const [order, setOrder] = useState<TopUpOrderStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const token = tokenRef.current;
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const result = await fetchTopUpPacks(token);
      setPacks(result.packs);
      setSelectedCode((current) =>
        current && result.packs.some((pack) => pack.code === current)
          ? current
          : (result.packs[0]?.code ?? null),
      );
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : "无法加载点数包。",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (session?.access_token) void load();
  }, [load, session?.access_token]);

  const pollOrder = useCallback(async (orderId: string) => {
    const token = tokenRef.current;
    if (!token) return;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const result = await fetchTopUpOrder(token, orderId);
      setOrder(result);
      if (result.status === "paid") {
        sessionStorage.removeItem(pendingOrderKey);
        window.dispatchEvent(new Event("loomic:credits-changed"));
        return;
      }
      if (!["pending", "failed"].includes(result.status)) return;
      await wait(2000);
    }
  }, []);

  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const orderId =
      query.get("order") ?? sessionStorage.getItem(pendingOrderKey);
    if (!orderId || !session?.access_token) return;
    void pollOrder(orderId).catch((pollError) =>
      setError(
        pollError instanceof Error ? pollError.message : "无法确认支付状态。",
      ),
    );
  }, [pollOrder, session?.access_token]);

  const selectedPack = useMemo(
    () => packs.find((pack) => pack.code === selectedCode) ?? null,
    [packs, selectedCode],
  );
  useEffect(() => {
    if (selectedPack && !selectedPack.paymentMethods.includes(paymentMethod)) {
      setPaymentMethod(selectedPack.paymentMethods[0] ?? "alipay");
    }
  }, [paymentMethod, selectedPack]);

  const eligible = selectedPack
    ? planRank(currentPlan) >= planRank(selectedPack.minimumPlanCode)
    : false;

  async function checkout() {
    const token = tokenRef.current;
    if (!token || !selectedPack) return;
    setCheckingOut(true);
    setError(null);
    setOrder(null);
    try {
      const result = await createTopUpCheckout(token, {
        packCode: selectedPack.code,
        paymentMethod,
        idempotencyKey: crypto.randomUUID(),
      });
      sessionStorage.setItem(pendingOrderKey, result.orderId);
      if (result.status === "paid") {
        await pollOrder(result.orderId);
        return;
      }
      const url = new URL(result.payInfo);
      if (url.protocol !== "https:" && url.protocol !== "http:") {
        throw new Error("支付渠道返回了不可用的收银台地址。");
      }
      window.location.assign(url.toString());
    } catch (checkoutError) {
      setError(
        checkoutError instanceof Error
          ? checkoutError.message
          : "无法进入支付收银台。",
      );
      setCheckingOut(false);
    }
  }

  return (
    <section className="border-t pt-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold">购买点数包</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            点数包余额永久有效，并在每日赠送和套餐点数用完后使用。
          </p>
        </div>
        <Button
          aria-label="刷新点数包"
          title="刷新点数包"
          variant="outline"
          size="icon"
          disabled={loading}
          onClick={() => void load()}
        >
          <RefreshCw className={cn("size-4", loading && "animate-spin")} />
        </Button>
      </div>

      {order?.status === "paid" ? (
        <div className="mt-4 flex items-start gap-3 rounded-md border border-emerald-500/30 bg-emerald-500/5 p-4">
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" />
          <div>
            <p className="text-sm font-medium">
              支付成功，{order.credits.toLocaleString()} 点已到账
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              余额已刷新。本次购买的点数不会随订阅周期过期。
            </p>
          </div>
        </div>
      ) : order?.status === "pending" ? (
        <div className="mt-4 flex items-center gap-3 rounded-md border bg-muted/25 p-4 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          正在确认支付结果，请不要重复支付...
        </div>
      ) : null}

      {error ? (
        <div className="mt-4 flex items-start gap-3 rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          {error}
        </div>
      ) : null}

      {loading && packs.length === 0 ? (
        <div className="mt-4 rounded-md border p-5 text-sm text-muted-foreground">
          <Loader2 className="mr-2 inline size-4 animate-spin" />
          正在读取可购买点数包...
        </div>
      ) : packs.length === 0 ? (
        <div className="mt-4 rounded-md border border-dashed p-5 text-sm text-muted-foreground">
          管理员尚未发布点数包，或支付渠道当前未启用。
        </div>
      ) : (
        <div className="mt-4 space-y-4">
          <div className="grid gap-2 sm:grid-cols-2">
            {packs.map((pack) => {
              const allowed =
                planRank(currentPlan) >= planRank(pack.minimumPlanCode);
              return (
                <button
                  key={pack.code}
                  type="button"
                  onClick={() => setSelectedCode(pack.code)}
                  className={cn(
                    "min-h-28 rounded-md border p-4 text-left transition-colors",
                    selectedCode === pack.code
                      ? "border-foreground bg-muted/30 ring-1 ring-foreground"
                      : "hover:bg-muted/20",
                  )}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-medium">{pack.name}</div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {pack.description ||
                          `${pack.credits.toLocaleString()} 点永久余额`}
                      </div>
                    </div>
                    <Coins className="size-4 shrink-0 text-muted-foreground" />
                  </div>
                  <div className="mt-4 flex items-end justify-between gap-3">
                    <div className="text-lg font-semibold tabular-nums">
                      {pack.credits.toLocaleString()} 点
                    </div>
                    <div className="text-right">
                      <div className="text-sm font-medium tabular-nums">
                        {money(pack.providerAmountMinor, "CNY")}
                      </div>
                      <div className="text-[11px] text-muted-foreground">
                        标价 {money(pack.priceMinor, "USD")}
                      </div>
                    </div>
                  </div>
                  {!allowed ? (
                    <div className="mt-2 text-xs text-amber-700 dark:text-amber-400">
                      需要
                      {pack.minimumPlanCode === "team" ? "团队版" : "专业版"}
                      及以上套餐
                    </div>
                  ) : null}
                </button>
              );
            })}
          </div>

          {selectedPack ? (
            <div className="rounded-md border p-4">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <div className="text-xs font-medium text-muted-foreground">
                    支付方式
                  </div>
                  <div className="mt-2 inline-flex rounded-md bg-muted p-1">
                    {selectedPack.paymentMethods.map((method) => (
                      <button
                        key={method}
                        type="button"
                        onClick={() => setPaymentMethod(method)}
                        className={cn(
                          "h-8 rounded px-3 text-sm transition-colors",
                          paymentMethod === method
                            ? "bg-background font-medium shadow-sm"
                            : "text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {method === "alipay" ? "支付宝" : "微信支付"}
                      </button>
                    ))}
                  </div>
                </div>
                <Button
                  size="lg"
                  disabled={
                    !eligible || checkingOut || order?.status === "pending"
                  }
                  onClick={() => void checkout()}
                >
                  {checkingOut ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <WalletCards />
                  )}
                  {checkingOut
                    ? "正在创建订单"
                    : `支付 ${money(selectedPack.providerAmountMinor, "CNY")}`}
                </Button>
              </div>
              <div className="mt-4 flex items-center gap-2 border-t pt-3 text-xs text-muted-foreground">
                <ShieldCheck className="size-3.5" />
                订单金额、支付回调和点数到账均由 PostgreSQL
                事务校验，并防止重复发放。
              </div>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}

function planRank(plan: string) {
  return (
    ({ free: 0, pro: 1, team: 2, enterprise: 3 } as Record<string, number>)[
      plan
    ] ?? 0
  );
}
function money(value: number, currency: "USD" | "CNY") {
  return new Intl.NumberFormat("zh-CN", { style: "currency", currency }).format(
    value / 100,
  );
}
function wait(ms: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}
