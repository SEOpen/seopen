import { Suspense, type ReactNode } from "react";
import { Briefing } from "@/components/ui/briefing";
import { FigureView, type FigureData } from "@/components/ui/figure";
import { formatShortDate } from "@/lib/format";
import { currentTimeZone } from "@/lib/workspace/current";
import { settle, type Loaded } from "@/modules/keywords/dfs";

/** A sentence and its figures. A page with no figures to show draws no empty strip. */
export function DomainBriefing({ sentence, figures }: { sentence: ReactNode; figures: FigureData[] }) {
  if (!figures.length) return <Briefing sentence={sentence} />;
  return (
    <Briefing sentence={sentence}>
      {figures.map((f) => (
        <FigureView key={f.id} data={f} />
      ))}
    </Briefing>
  );
}

/**
 * When the numbers on the page were looked up. Reads the same memoized `loadOnce` calls the page does,
 * so it never adds a paid call: pass `loads` only where the page itself would make them. With several,
 * the oldest date, so it can't overstate how fresh the page is.
 */
async function LookedUp({ loads }: { loads: () => Promise<Loaded<unknown>>[] }) {
  const settled = await settle(() => Promise.all(loads()));
  // The page's own sections show the error.
  if (!settled.ok) return null;
  const dates = settled.value.flatMap((l) => (l.state === "ready" && l.fetchedAt ? [new Date(l.fetchedAt).getTime()] : []));
  if (!dates.length) return <>Not looked up yet.</>;
  return <>Looked up {formatShortDate(new Date(Math.min(...dates)), await currentTimeZone())}.</>;
}

export function LookedUpNote({ loads }: { loads: () => Promise<Loaded<unknown>>[] }) {
  return (
    <Suspense fallback={null}>
      <LookedUp loads={loads} />
    </Suspense>
  );
}

/** The page header's line: where the numbers come from, and how fresh they are once there's something to date. */
export function DomainSource({ text, loads }: { text: string; loads?: () => Promise<Loaded<unknown>>[] }) {
  if (!loads) return <>{text}</>;
  return (
    <>
      {text} <LookedUpNote loads={loads} />
    </>
  );
}
