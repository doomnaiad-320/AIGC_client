// ---------------------------------------------------------------------------
// Loomic Pricing Data
// ---------------------------------------------------------------------------

export type BillingPeriod = "monthly" | "yearly";

export interface PricingTier {
  id: string;
  name: string;
  nameEn: string;
  description: string;
  monthlyPrice: number;
  yearlyPrice: number; // per month
  credits: number;
  creditLabel: string;
  badge?: string;
  highlighted?: boolean;
  features: string[];
  cta: string;
  ctaVariant: "default" | "accent" | "outline";
}

export interface FeatureCategory {
  name: string;
  features: FeatureRow[];
}

export interface FeatureRow {
  name: string;
  tiers: Record<string, string | boolean>;
}

export interface FAQItem {
  question: string;
  answer: string;
}

export function buildPricingData(
  plans: import("@loomic/shared").PublishedBillingPlan[],
) {
  const pricingTiers: PricingTier[] = plans.map((plan) => ({
    id: plan.code,
    name: plan.nameZh,
    nameEn: plan.code,
    description: plan.descriptionZh,
    monthlyPrice: plan.monthlyPriceMinor / 100,
    yearlyPrice: plan.annualPriceMinor > 0 ? plan.annualPriceMinor / 1200 : 0,
    credits: plan.monthlySubscriptionCredits,
    creditLabel: [
      plan.monthlySubscriptionCredits > 0
        ? `${plan.monthlySubscriptionCredits.toLocaleString()} 积分/月`
        : null,
      plan.dailyCredits > 0 ? `每天赠送 ${plan.dailyCredits} 积分` : null,
    ]
      .filter(Boolean)
      .join(" · "),
    ...(plan.code === "pro" ? { badge: "推荐", highlighted: true } : {}),
    features: [
      `${plan.entitlements.maxConcurrentJobs} 个并发任务`,
      `图片最高${qualityLabel(plan.entitlements.maxImageQuality)}`,
      `视频最高 ${plan.entitlements.maxVideoResolution}`,
      `${limitLabel(plan.entitlements.maxProjects)}个项目`,
      `${limitLabel(plan.entitlements.maxBrandKits)}个品牌套件`,
      `${plan.entitlements.maxTeamSeats} 个团队席位`,
      plan.topUpEligible ? "可购买独立点数包" : "不开放独立点数包",
    ],
    cta: plan.code === "free" ? "免费开始" : `选择${plan.nameZh}`,
    ctaVariant:
      plan.code === "pro"
        ? "accent"
        : plan.code === "free"
          ? "outline"
          : "default",
  }));

  const featureCategories: FeatureCategory[] = [
    {
      name: "创作能力",
      features: [
        {
          name: "图片最高质量",
          tiers: Object.fromEntries(
            plans.map((plan) => [
              plan.code,
              qualityLabel(plan.entitlements.maxImageQuality),
            ]),
          ),
        },
        {
          name: "视频最高分辨率",
          tiers: Object.fromEntries(
            plans.map((plan) => [
              plan.code,
              plan.entitlements.maxVideoResolution,
            ]),
          ),
        },
        {
          name: "并发任务",
          tiers: Object.fromEntries(
            plans.map((plan) => [
              plan.code,
              String(plan.entitlements.maxConcurrentJobs),
            ]),
          ),
        },
      ],
    },
    {
      name: "积分与用量",
      features: [
        {
          name: "每月订阅点数",
          tiers: Object.fromEntries(
            plans.map((plan) => [
              plan.code,
              plan.monthlySubscriptionCredits > 0
                ? plan.monthlySubscriptionCredits.toLocaleString()
                : false,
            ]),
          ),
        },
        {
          name: "每日赠送",
          tiers: Object.fromEntries(
            plans.map((plan) => [
              plan.code,
              plan.dailyCredits > 0 ? `${plan.dailyCredits}/天` : false,
            ]),
          ),
        },
        {
          name: "独立点数包",
          tiers: Object.fromEntries(
            plans.map((plan) => [plan.code, plan.topUpEligible]),
          ),
        },
      ],
    },
    {
      name: "协作与管理",
      features: [
        {
          name: "项目数量",
          tiers: Object.fromEntries(
            plans.map((plan) => [
              plan.code,
              limitLabel(plan.entitlements.maxProjects),
            ]),
          ),
        },
        {
          name: "品牌套件",
          tiers: Object.fromEntries(
            plans.map((plan) => [
              plan.code,
              limitLabel(plan.entitlements.maxBrandKits),
            ]),
          ),
        },
        {
          name: "团队席位",
          tiers: Object.fromEntries(
            plans.map((plan) => [
              plan.code,
              String(plan.entitlements.maxTeamSeats),
            ]),
          ),
        },
        {
          name: "API 接入",
          tiers: Object.fromEntries(
            plans.map((plan) => [plan.code, plan.entitlements.apiEnabled]),
          ),
        },
      ],
    },
  ];

  return { featureCategories, pricingTiers };
}

function qualityLabel(value: string) {
  return (
    ({ standard: "标准", hd: "高清", ultra: "超清" } as Record<string, string>)[
      value
    ] ?? value
  );
}

function limitLabel(value: number) {
  return value === -1 ? "不限" : value.toLocaleString();
}

// ---------------------------------------------------------------------------
// FAQ
// ---------------------------------------------------------------------------

export const faqItems: FAQItem[] = [
  {
    question: "积分是如何计算的？",
    answer:
      "每次生成操作消耗不同数量的积分。标准图片生成约消耗 5 积分，HD 图片约 10 积分，标准视频（5秒）约 40 积分。使用更高端的 AI 模型或更高分辨率会消耗更多积分。",
  },
  {
    question: "未使用的积分会累积吗？",
    answer:
      "订阅积分在每个计费周期重置，不会累积到下月。但通过充值购买的额外积分永不过期，可以一直使用。",
  },
  {
    question: "可以随时升级或降级吗？",
    answer:
      "随时可以升级，我们会按比例计算差价。降级将在当前计费周期结束后生效。升级后立即获得新套餐的全部功能和积分。",
  },
  {
    question: "年付方案如何计费？",
    answer:
      "年付方案按年一次性支付，相当于每月价格的约 75 折（节省约 25%）。年付方案同样享受所有功能，积分按月重置。",
  },
  {
    question: "团队席位如何工作？",
    answer:
      "团队版包含多个团队席位。成员共享工作区的套餐点数池，可以协作管理项目和品牌套件。需要更多席位可联系我们。",
  },
  {
    question: "支持哪些支付方式？",
    answer:
      "最终可用的支付方式由上线时配置的支付渠道决定。结算页面会显示当前支持的信用卡、本地支付或合同付款方式。",
  },
  {
    question: "如何申请退款？",
    answer:
      "如果在订阅后 7 天内未使用任何积分，可以申请全额退款。超过 7 天或已使用积分的情况不支持退款。请通过客服邮件提交退款申请。",
  },
];

// ---------------------------------------------------------------------------
// Animation variants (shared across pricing components)
// ---------------------------------------------------------------------------

export const fadeInUp = {
  hidden: { opacity: 0, y: 24 },
  visible: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: {
      delay: i * 0.08,
      duration: 0.6,
      ease: [0.25, 0.46, 0.45, 0.94] as const,
    },
  }),
};

export const staggerContainer = {
  hidden: {},
  visible: {
    transition: { staggerChildren: 0.07, delayChildren: 0.15 },
  },
};

export const cardReveal = {
  hidden: { opacity: 0, y: 28, scale: 0.96 },
  visible: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: { duration: 0.5, ease: [0.25, 0.46, 0.45, 0.94] as const },
  },
};

export const scaleIn = {
  hidden: { opacity: 0, scale: 0.9 },
  visible: {
    opacity: 1,
    scale: 1,
    transition: { duration: 0.4, ease: "easeOut" as const },
  },
};
