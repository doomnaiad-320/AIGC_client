import type { HomeDiscoveryCategory } from "./home-discovery-seeds";
import { homeDiscoverySeedCategories } from "./home-discovery-seeds";

export type HomeDiscoveryCategoryRow = {
  created_at?: string;
  is_active?: boolean;
  key: string;
  label: string;
  sort_order: number;
  updated_at?: string;
};

export type HomeDiscoveryCaseRow = {
  author_avatar_url: string;
  author_name: string;
  case_url?: string;
  category_key: string;
  cover_image_url: string;
  created_at?: string;
  id: string;
  is_active?: boolean;
  like_count: number;
  seed_prompt: string;
  sort_order: number;
  title: string;
  updated_at?: string;
  view_count: number;
};

export function mapHomeDiscoveryRows(
  categories: HomeDiscoveryCategoryRow[],
  cases: HomeDiscoveryCaseRow[],
): HomeDiscoveryCategory[] {
  const casesByCategory = new Map<string, HomeDiscoveryCaseRow[]>();

  for (const item of cases) {
    const group = casesByCategory.get(item.category_key) ?? [];
    group.push(item);
    casesByCategory.set(item.category_key, group);
  }

  return [...categories]
    .sort((left, right) => left.sort_order - right.sort_order)
    .map((category) => ({
      key: category.key,
      label: category.label,
      cases: [...(casesByCategory.get(category.key) ?? [])]
        .sort((left, right) => left.sort_order - right.sort_order)
        .map((item) => ({
          id: item.id,
          title: item.title,
          coverImageUrl: item.cover_image_url,
          authorName: item.author_name,
          authorAvatarUrl: item.author_avatar_url,
          viewCount: item.view_count,
          likeCount: item.like_count,
          prompt: item.seed_prompt,
        })),
    }));
}

export async function loadHomeDiscoveryCategories(): Promise<
  HomeDiscoveryCategory[]
> {
  return homeDiscoverySeedCategories;
}
