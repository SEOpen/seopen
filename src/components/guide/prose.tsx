import Link from "next/link";
import type { ReactNode } from "react";

/** Long-form building blocks shared by the Guide and the owner's runbook. */

export function Section({ id, title, description, children }: { id: string; title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-16">
      <h2 className="font-display text-base">{title}</h2>
      {description && <p className="mt-0.5 text-xs text-muted">{description}</p>}
      <div className="mt-3 leading-relaxed">{children}</div>
    </section>
  );
}

export function Li({ children }: { children: ReactNode }) {
  return <li className="relative pl-4 before:absolute before:top-[0.6em] before:left-0 before:size-1.5 before:rounded-full before:bg-line">{children}</li>;
}

export function A({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="text-accent hover:underline">
      {children}
    </Link>
  );
}

export function Code({ children }: { children: ReactNode }) {
  return <code className="rounded-sm bg-surface-2 px-1 py-0.5 font-mono text-[12px]">{children}</code>;
}

export function Cmd({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <div>
      {label && <div className="text-xs text-muted">{label}</div>}
      <code className="mt-1 block overflow-x-auto rounded-md bg-surface-2 px-3 py-2 font-mono text-[12px]">{children}</code>
    </div>
  );
}

/** "On this page" links beside a long page, once main has room. */
export function Toc({ items }: { items: { id: string; label: string; sub?: boolean }[] }) {
  return (
    <aside className="hidden @3xl/main:block">
      <nav className="sticky top-6 flex flex-col gap-0.5 text-sm">
        <div className="mb-1 px-2 text-xs font-medium text-muted">On this page</div>
        {items.map((t) => (
          <a key={t.id} href={`#${t.id}`} className={`rounded-md px-2 py-1 text-muted hover:bg-surface-2 hover:text-fg ${t.sub ? "pl-5 text-xs" : ""}`}>
            {t.label}
          </a>
        ))}
      </nav>
    </aside>
  );
}
