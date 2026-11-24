import { deliverAlerts } from "./deliver";
import { alertsFromCrawl, type CrawlAlertInput } from "./record";

/**
 * After a crawl is imported (src/modules/audit/crawl.ts): runs the crawl's rules and, when an
 * urgent alert opened, sends the urgent email now rather than at the day's email.
 */
export async function alertsAfterCrawl(input: CrawlAlertInput, now = new Date()): Promise<void> {
  const opened = await alertsFromCrawl(input, now);
  if (opened) await deliverAlerts({ workspaceId: input.crawl.workspaceId, projectId: input.crawl.projectId }, "urgent", now);
}
