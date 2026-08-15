"use client";

import {
  CalendarClock,
  CircleCheck,
  Coins,
  CreditCard,
  Crown,
  ExternalLink,
  Loader2,
  RefreshCw,
  RotateCcw,
  TriangleAlert,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useSubscription } from "@/hooks/use-subscription";

const planLabels = {
  enterprise: "企业版",
  free: "免费版",
  pro: "专业版",
  team: "团队版",
} as const;

export function BillingSection() {
  const { subscription, loading, error, refresh, cancel, resume } =
    useSubscription();
  const [cancelConfirmOpen, setCancelConfirmOpen] = useState(false);
  const [operation, setOperation] = useState<"cancel" | "resume" | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);

  const handleCancel = useCallback(async () => {
    setOperation("cancel");
    setOperationError(null);
    try {
      await cancel();
      setCancelConfirmOpen(false);
    } catch (err) {
      setOperationError(
        err instanceof Error ? err.message : "无法取消订阅，请稍后重试。",
      );
    } finally {
      setOperation(null);
    }
  }, [cancel]);

  const handleResume = useCallback(async () => {
    setOperation("resume");
    setOperationError(null);
    try {
      await resume();
    } catch (err) {
      setOperationError(
        err instanceof Error ? err.message : "无法恢复订阅，请稍后重试。",
      );
    } finally {
      setOperation(null);
    }
  }, [resume]);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold">订阅与计费</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            查看当前套餐、点数周期并管理订阅状态。
          </p>
        </div>
        <Button
          aria-label="刷新订阅状态"
          disabled={loading}
          onClick={() => void refresh()}
          size="icon"
          title="刷新订阅状态"
          variant="outline"
        >
          {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
        </Button>
      </div>

      {loading && !subscription ? (
        <div className="rounded-lg border p-5">
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            正在读取订阅状态...
          </div>
        </div>
      ) : error || !subscription ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4">
          <div className="flex items-start gap-3">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
            <div>
              <p className="text-sm font-medium text-destructive">
                无法加载订阅状态
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {error ?? "请稍后重试。"}
              </p>
            </div>
          </div>
        </div>
      ) : (
        <SubscriptionPanel
          subscription={subscription}
          operation={operation}
          operationError={operationError}
          onCancel={() => {
            setOperationError(null);
            setCancelConfirmOpen(true);
          }}
          onResume={handleResume}
        />
      )}

      <Dialog
        open={cancelConfirmOpen}
        onOpenChange={(open) => {
          if (!operation) setCancelConfirmOpen(open);
        }}
      >
        <DialogContent showCloseButton={!operation}>
          <DialogHeader>
            <DialogTitle>取消当前订阅？</DialogTitle>
            <DialogDescription>
              套餐权益会保留到当前订阅周期结束。到期后工作区将自动回到免费版，未使用的订阅点数也会失效。
            </DialogDescription>
          </DialogHeader>
          {operationError ? (
            <p className="text-sm text-destructive">{operationError}</p>
          ) : null}
          <DialogFooter>
            <Button
              disabled={operation === "cancel"}
              onClick={() => setCancelConfirmOpen(false)}
              variant="outline"
            >
              保留订阅
            </Button>
            <Button
              disabled={operation === "cancel"}
              onClick={handleCancel}
              variant="destructive"
            >
              {operation === "cancel" ? (
                <Loader2 className="animate-spin" />
              ) : null}
              确认取消
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SubscriptionPanel({
  subscription,
  operation,
  operationError,
  onCancel,
  onResume,
}: {
  subscription: NonNullable<ReturnType<typeof useSubscription>["subscription"]>;
  operation: "cancel" | "resume" | null;
  operationError: string | null;
  onCancel: () => void;
  onResume: () => Promise<void>;
}) {
  const isFree = subscription.plan === "free";
  const willCancel =
    subscription.cancelAtPeriodEnd || Boolean(subscription.canceledAt);
  const planName = subscription.planName || planLabels[subscription.plan];

  return (
    <>
      <section className="overflow-hidden rounded-lg border bg-card">
        <div className="flex flex-col gap-4 border-b px-5 py-5 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted">
              <Crown className="size-4" />
            </div>
            <div>
              <p className="text-xs font-medium text-muted-foreground">
                当前套餐
              </p>
              <h3 className="mt-1 text-xl font-semibold">{planName}</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                {subscription.billingPeriod
                  ? `${billingPeriodLabel(subscription.billingPeriod)}订阅`
                  : "无固定计费周期"}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <StatusBadge
              label={willCancel ? "等待到期" : statusLabel(subscription.status)}
              warning={willCancel}
            />
            <span className="inline-flex h-6 items-center rounded-md border px-2 text-xs font-medium text-muted-foreground">
              {providerLabel(subscription.provider)}
            </span>
          </div>
        </div>

        {willCancel ? (
          <div className="flex items-start gap-3 border-b bg-amber-500/5 px-5 py-4">
            <CalendarClock className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-400" />
            <p className="text-sm text-muted-foreground">
              订阅将在 {formatDate(subscription.currentPeriodEnd)}
              结束。在此之前套餐权益保持有效，你可以随时恢复自动续订。
            </p>
          </div>
        ) : subscription.provider === "local" ? (
          <div className="flex items-start gap-3 border-b bg-muted/35 px-5 py-4">
            <CircleCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" />
            <p className="text-sm text-muted-foreground">
              当前为本地订阅模拟，套餐、点数和周期状态均写入
              PostgreSQL，不会产生真实扣款。
            </p>
          </div>
        ) : null}

        <dl className="grid sm:grid-cols-2">
          <InfoRow
            icon={<CreditCard />}
            label="计费周期"
            value={
              subscription.billingPeriod
                ? billingPeriodLabel(subscription.billingPeriod)
                : "不适用"
            }
          />
          <InfoRow
            icon={<Coins />}
            label="每月订阅点数"
            value={`${subscription.monthlyCredits.toLocaleString("en-US")} 点`}
          />
          <InfoRow
            label="订阅周期"
            value={formatDateRange(
              subscription.currentPeriodStart,
              subscription.currentPeriodEnd,
            )}
          />
          <InfoRow
            label="点数周期"
            value={formatDateRange(
              subscription.creditPeriodStart,
              subscription.creditPeriodEnd,
            )}
          />
          <InfoRow
            label={willCancel ? "权益保留至" : "下次续订"}
            value={formatDate(subscription.currentPeriodEnd)}
          />
          <InfoRow label="结算货币" value={subscription.currency} />
        </dl>
      </section>

      {operationError ? (
        <div className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          {operationError}
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button render={<Link href="/pricing" />} size="lg">
          <CreditCard />
          {isFree ? "选择套餐" : "更换套餐"}
        </Button>

        {subscription.customerPortalUrl ? (
          <Button
            render={
              <a
                href={subscription.customerPortalUrl}
                rel="noopener noreferrer"
                target="_blank"
              />
            }
            size="lg"
            variant="outline"
          >
            <ExternalLink />
            管理付款方式
          </Button>
        ) : null}

        {!isFree && willCancel ? (
          <Button
            disabled={operation === "resume"}
            onClick={() => void onResume()}
            size="lg"
            variant="outline"
          >
            {operation === "resume" ? (
              <Loader2 className="animate-spin" />
            ) : (
              <RotateCcw />
            )}
            恢复订阅
          </Button>
        ) : null}

        {!isFree && !willCancel ? (
          <Button onClick={onCancel} size="lg" variant="destructive">
            取消订阅
          </Button>
        ) : null}
      </div>
    </>
  );
}

function InfoRow({
  icon,
  label,
  value,
}: {
  icon?: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="border-b px-5 py-4 last:border-b-0 sm:[&:nth-last-child(-n+2)]:border-b-0 sm:[&:nth-child(odd)]:border-r">
      <dt className="flex items-center gap-1.5 text-xs text-muted-foreground [&_svg]:size-3.5">
        {icon}
        {label}
      </dt>
      <dd className="mt-1.5 text-sm font-medium tabular-nums">{value}</dd>
    </div>
  );
}

function StatusBadge({ label, warning }: { label: string; warning: boolean }) {
  return (
    <span
      className={
        warning
          ? "inline-flex h-6 items-center rounded-md bg-amber-500/10 px-2 text-xs font-medium text-amber-700 dark:text-amber-400"
          : "inline-flex h-6 items-center rounded-md bg-emerald-500/10 px-2 text-xs font-medium text-emerald-700 dark:text-emerald-400"
      }
    >
      {label}
    </span>
  );
}

function statusLabel(status: string | null) {
  return (
    {
      active: "生效中",
      canceled: "已取消",
      expired: "已到期",
      past_due: "付款逾期",
      paused: "已暂停",
      trialing: "试用中",
    }[status ?? ""] ?? "生效中"
  );
}

function providerLabel(provider: string | null) {
  if (provider === "local") return "本地模拟";
  if (provider === "lemon_squeezy") return "Lemon Squeezy";
  return "平台套餐";
}

function billingPeriodLabel(period: "monthly" | "yearly") {
  return period === "yearly" ? "年付" : "月付";
}

function formatDate(value: string | null) {
  if (!value) return "不适用";
  return new Intl.DateTimeFormat("zh-CN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(value));
}

function formatDateRange(start: string | null, end: string | null) {
  if (!start && !end) return "不适用";
  return `${formatDate(start)} - ${formatDate(end)}`;
}
