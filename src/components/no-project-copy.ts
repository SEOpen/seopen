/**
 * What a workspace with no project is told. It leads with what every plan has, Free included: the
 * site audit, the fixes it finds and Search Console. A paid plan also tracks rankings and competitors,
 * so only it is told about them (src/lib/billing/plan-features.ts).
 */
export function noProjectCopy(free: boolean): { title: string; description: string } {
  const base = "A project is one site. Add yours to run a site audit, get the list of fixes it finds and see its Search Console data";
  return { title: "No project yet", description: free ? `${base}.` : `${base}, then track its rankings against competitors.` };
}
