import type { ComponentProps } from "react";
import { SegmentedLinks } from "@/components/ui/segmented-links";

/** Segmented links with too many options for a phone: they scroll inside themselves rather than widening the page. */
export function ViewLinks(props: ComponentProps<typeof SegmentedLinks>) {
  return (
    <div className="max-w-full min-w-0 overflow-x-auto [scrollbar-width:none]">
      <SegmentedLinks {...props} />
    </div>
  );
}
