const bar = "rounded-sm bg-surface-2";

/** The tab row's place, the same height as the real one, for while the tabs or the page can't be drawn yet. */
export function TabsPlaceholder() {
  return <div className="mb-5 h-[39px] shadow-[inset_0_-1px_0_var(--color-line)]" />;
}

/**
 * The shape of every page while it loads: title, tabs on a module with them, sentence, figures, a table.
 * Still, no shimmer. `header` off for a boundary inside a page whose title is already showing. A Suspense
 * fallback can't read the pathname, which suspends, so a module with tabs asks for them in its own loading.tsx.
 */
export function PageSkeleton({ label = "Loading", header = true, tabs = false }: { label?: string; header?: boolean; tabs?: boolean }) {
  return (
    <div role="status" aria-label={label}>
      {header && (
        <div className="mb-5">
          <div className={`h-8 w-48 max-w-full ${bar}`} />
          <div className={`mt-2 h-4 w-72 max-w-full ${bar}`} />
        </div>
      )}
      {tabs && <TabsPlaceholder />}
      <div className={`h-[26px] w-[32rem] max-w-full ${bar}`} />
      <div className="figure-strip mt-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i}>
            <div className={`h-4 w-20 ${bar}`} />
            <div className={`mt-2 h-[31px] w-24 ${bar}`} />
            <div className={`mt-1.5 h-[18px] w-28 max-w-full ${bar}`} />
          </div>
        ))}
      </div>
      <div className="mt-6 flex flex-col divide-y divide-line-soft">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="flex items-center justify-between gap-6 py-3">
            <div className={`h-4 w-64 max-w-[60%] ${bar}`} />
            <div className={`h-4 w-16 ${bar}`} />
          </div>
        ))}
      </div>
    </div>
  );
}
