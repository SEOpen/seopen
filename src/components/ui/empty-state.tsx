import type { ReactNode } from "react";

/**
 * `level` is the title's heading level. Most empty states sit right under the page's h1, so the
 * default is 2; one that stands in for a whole page (no PageHeader) passes 1, and one inside a
 * card passes 3.
 */
export function EmptyState({ title, description, action, level = 2 }: { title: string; description?: ReactNode; action?: ReactNode; level?: 1 | 2 | 3 }) {
  const Heading = `h${level}` as const;
  return (
    <div className="panel flex flex-col items-start px-6 py-8 [overflow-wrap:anywhere]">
      <Heading className="text-[15px] font-medium">{title}</Heading>
      {description && <div className="mt-1 max-w-prose text-sm text-secondary">{description}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
