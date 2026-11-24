/**
 * Who runs this copy of SEOpen: the address error pages, emails and suspended-workspace messages point
 * people to, the default sender, and where the owner's alerts go without OWNER_ALERT_EMAIL. Null when
 * NEXT_PUBLIC_SEOPEN_CONTACT_EMAIL is unset: a self-hosted copy then names no address, and never
 * SEOpen's own (the hosted service sets its own).
 * NEXT_PUBLIC_ because error pages are client components; it is public anyway. Next bakes it into the
 * build, so changing it means a rebuild. Imports nothing, so client components can use it.
 */
export function contactEmail(): string | null {
  return process.env.NEXT_PUBLIC_SEOPEN_CONTACT_EMAIL?.trim() || null;
}

/**
 * Whether this copy is the hosted service, which SEOpen runs for its customers. Its error messages say a
 * problem is on SEOpen's side and that there's nothing for the customer to fix. A self-hosted copy's
 * messages speak to whoever runs it instead: which setting to add, or that the server log has the reason.
 * The marketing site marks the hosted service (next.config.ts sets SEOPEN_HAS_SITE at build time, for
 * client components too). The worker isn't built by Next, so there it reads as self-hosted: anything it
 * stores for a customer to read keeps the code and is worded when a page shows it.
 */
export function isHostedService(): boolean {
  return process.env.SEOPEN_HAS_SITE === "1";
}

/** The sender's name and postal address for email footers (CAN-SPAM asks for one in commercial email). Empty when unset: the footer then has none. */
export function postalAddress(): string {
  return process.env.SEOPEN_POSTAL_ADDRESS?.trim() ?? "";
}
