import type { ReactNode } from "react";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { rules } from "@/plan-policy/rules";

const PLANS_HREF = rules.plansHref ?? "/";

/**
 * A module the workspace's plan doesn't include (`rules.planIncludes`; nothing on a copy without plans), said as what Starter adds and
 * where to get it, in place of a form that would only refuse. `extra` is a second action, such as a
 * way to data the workspace already has.
 */
export function PlanFeature({ module, extra, level }: { module: string; extra?: ReactNode; level?: 1 | 2 | 3 }) {
  const feature = rules.planFeature(module);
  if (!feature) return null;
  const { title, description } = feature;
  return (
    <EmptyState
      level={level}
      title={title}
      description={description}
      action={
        <div className="flex flex-wrap gap-2">
          <ButtonLink href={PLANS_HREF}>See plans</ButtonLink>
          {extra}
        </div>
      }
    />
  );
}

/** The same, in place of an add form's card on a page that still shows data from a paid plan. */
export function PlanFeatureCard({ title, module }: { title: string; module: string }) {
  const feature = rules.planFeature(module);
  if (!feature) return null;
  return (
    <Card>
      <CardHeader title={title} description={feature.description} />
      <CardBody>
        <ButtonLink href={PLANS_HREF} variant="secondary" size="sm">
          See plans
        </ButtonLink>
      </CardBody>
    </Card>
  );
}
