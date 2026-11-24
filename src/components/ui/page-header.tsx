import type { ReactNode } from "react";

/**
 * Top of every page: title, where the numbers come from and how fresh they are, actions on the right.
 * `helpHref` is for a module with no tab row to carry its "How this works". It runs on from the
 * description rather than taking a line of its own, so the page below it stays where the skeleton put it.
 * `as="div"` is for a mockup of a page inside another page, which already has its h1.
 * Under a page's actions is a line for what they answer (`HeaderMessage`), so an answer doesn't move the header.
 * It's `relative` so a `ConfirmSubmit` question can float under its row rather than widen it.
 */
export function PageHeader({ title, description, actions, helpHref, as: Title = "h1" }: { title: string; description?: ReactNode; actions?: ReactNode; helpHref?: string | null; as?: "h1" | "div" }) {
  return (
    <>
    <div data-page-header className="relative mb-5 flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
      {/* A title can be a long URL with nowhere to break, which on a phone would widen the page. */}
      <div className="min-w-0 flex-[1_1_16rem] [overflow-wrap:anywhere]">
        <Title className="font-display text-[24px] leading-8">{title}</Title>
        {(description || helpHref) && (
          <div className="mt-1 text-sm text-muted">
            {description}
            {description && helpHref && " "}
            {helpHref && (
              // Inside a sentence nothing else says it's a link, so it keeps a faint underline. The tap area grows without moving the text.
              // The docs are on the marketing site, so a plain link in a new tab keeps the app where it was.
              <a
                href={helpHref}
                target="_blank"
                rel="noopener"
                className="relative rounded-sm text-xs whitespace-nowrap text-muted underline decoration-line underline-offset-3 transition-colors duration-[120ms] ease-instrument after:absolute after:-inset-x-1 after:-inset-y-1.5 hover:text-fg hover:decoration-fg focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                How this works
              </a>
            )}
          </div>
        )}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
    {actions && Title === "h1" && <div data-header-message className="mb-5 empty:hidden" />}
    </>
  );
}
