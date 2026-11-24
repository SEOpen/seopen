import type { DashboardFixtures } from "@/components/ui/module-card";
import type { KeywordsDashboardData } from "./dashboard";

/** A 120-character list name. */
const LONG_NAME = "Commercial investigation keywords for enterprise project management software comparisons in North America and Europe 26";

export const fixtures: DashboardFixtures<KeywordsDashboardData> = {
  full: {
    keywords: 6_210,
    lists: 7,
    top: [
      { id: 1, name: "Pricing pages", keywords: 1_204, volume: 18_300 },
      { id: 2, name: "Competitor alternatives", keywords: 842, volume: 64_150 },
      { id: 3, name: "How-to guides", keywords: 2_310, volume: 241_800 },
      { id: 4, name: "Integrations", keywords: 517, volume: 9_420 },
      { id: 5, name: "Brand", keywords: 38, volume: 12_900 },
    ],
  },
  sparse: {
    keywords: 1,
    lists: 1,
    top: [{ id: 1, name: "Ideas", keywords: 1, volume: 0 }],
  },
  long: {
    keywords: 499_995,
    lists: 99_999,
    top: [1, 2, 3, 4, 5].map((id) => ({ id, name: LONG_NAME, keywords: 99_999, volume: 48_213_977 })),
  },
  more: {
    "empty lists": {
      keywords: 0,
      lists: 2,
      top: [
        { id: 1, name: "New list", keywords: 0, volume: 0 },
        { id: 2, name: "Drafts", keywords: 0, volume: 0 },
      ],
    },
  },
};
