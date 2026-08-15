import type { HomeExampleCategory, InputMention } from "./home-example-seeds";
import { homeExampleSeedCategories } from "./home-example-seeds";

export type HomeExampleCategoryRow = {
  accent: string | null;
  created_at?: string;
  data_type: string;
  is_active?: boolean;
  key: string;
  label: string;
  sort_order: number;
  updated_at?: string;
};

export type HomeExampleExampleRow = {
  category_key: string;
  created_at?: string;
  id?: string;
  image_urls: string[];
  input_mentions: unknown;
  is_active?: boolean;
  prompt: string;
  sort_order: number;
  title: string;
  updated_at?: string;
};

export function mapHomeExampleRows(
  categories: HomeExampleCategoryRow[],
  examples: HomeExampleExampleRow[],
): HomeExampleCategory[] {
  const examplesByCategory = new Map<string, HomeExampleExampleRow[]>();

  for (const example of examples) {
    const group = examplesByCategory.get(example.category_key) ?? [];
    group.push(example);
    examplesByCategory.set(example.category_key, group);
  }

  return [...categories]
    .sort((left, right) => left.sort_order - right.sort_order)
    .map((category) => ({
      key: category.key,
      label: category.label,
      dataType: category.data_type,
      ...(category.accent === "special" ? { accent: "special" as const } : {}),
      examples: [...(examplesByCategory.get(category.key) ?? [])]
        .sort((left, right) => left.sort_order - right.sort_order)
        .map((example) => ({
          title: example.title,
          prompt: example.prompt,
          previewImages: example.image_urls,
          inputMentions: (Array.isArray(example.input_mentions)
            ? example.input_mentions
            : []) as InputMention[],
        })),
    }));
}

export async function loadHomeExampleCategories(): Promise<
  HomeExampleCategory[]
> {
  return homeExampleSeedCategories;
}
