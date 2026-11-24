import type { AnyDashboardModule } from "@/components/ui/module-card";
import { dashboard as ai } from "@/modules/ai/dashboard";
import { dashboard as audit } from "@/modules/audit/dashboard";
import { dashboard as backlinks } from "@/modules/backlinks/dashboard";
import { dashboard as domains } from "@/modules/domains/dashboard";
import { dashboard as fixes } from "@/modules/fixes/dashboard";
import { dashboard as google } from "@/modules/google/dashboard";
import { dashboard as ga4 } from "@/modules/google/ga4-dashboard";
import { dashboard as keywords } from "@/modules/keywords/dashboard";
import { dashboard as local } from "@/modules/local/dashboard";
import { dashboard as rank } from "@/modules/rank/dashboard";

/**
 * Dashboard order. The first module is also the first setup step on an empty dashboard. AI
 * visibility comes straight after Search Console: it's why most people sign up.
 */
export const DASHBOARD_MODULES: AnyDashboardModule[] = [google, ai, ga4, rank, local, domains, audit, fixes, backlinks, keywords];
