import type { DashboardFixtures } from "@/components/ui/module-card";
import type { DomainsDashboardData } from "./dashboard";

/** `n` monthly traffic points ending Oct 2026, growing from `from` to `to`. */
function months(from: number, to: number, n = 12): DomainsDashboardData["history"] {
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(2026, 9 - (n - 1) + i, 1);
    const t = n === 1 ? 1 : i / (n - 1);
    const wobble = Math.sin(i * 1.9) * Math.abs(to - from) * 0.12;
    return { month: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`, traffic: Math.max(0, Math.round(from + (to - from) * t + wobble)) };
  });
}

export const fixtures: DashboardFixtures<DomainsDashboardData> = {
  full: {
    domain: "alphanote.example",
    latest: { date: "2026-10-01", keywords: 2_184, traffic: 6_412, top10: 312, trafficValue: 9_873.4 },
    previous: { month: "2026-09", keywords: 2_051, traffic: 6_890, top10: 298 },
    history: months(4_120, 6_412),
  },
  sparse: {
    domain: "newsite.io",
    latest: { date: "2026-10-01", keywords: 14, traffic: 3, top10: 0, trafficValue: 0.42 },
    previous: null,
    history: [],
  },
  long: {
    domain: "the-very-long-subdomain.international-hardware-distributors-association.co.uk",
    latest: { date: "2026-10-01", keywords: 48_213_977, traffic: 99_999, top10: 99_999, trafficValue: 1_234_567 },
    previous: { month: "2026-09", keywords: 1_204, traffic: 7_481, top10: 12 },
    history: months(7_481, 99_999),
  },
  more: {
    "no history loaded": {
      domain: "alphanote.example",
      latest: { date: "2026-10-01", keywords: 2_184, traffic: 6_412, top10: 312, trafficValue: 9_873.4 },
      previous: null,
      history: [],
    },
  },
};
