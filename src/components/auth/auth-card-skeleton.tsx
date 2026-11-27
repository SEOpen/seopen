import { Card, CardBody } from "@/components/ui/card";

const bar = "rounded-sm bg-surface-2";

/**
 * An auth page's card while its query is read (sign-in's `next`, a reset link's token): the Suspense
 * fallback that lets the rest of the page prerender. Still, no shimmer.
 */
export function AuthCardSkeleton() {
  return (
    <Card>
      <CardBody className="flex flex-col gap-4" role="status" aria-label="Loading">
        <div className={`h-6 w-40 ${bar}`} />
        <div className={`h-9 w-full ${bar}`} />
        <div className={`h-9 w-full ${bar}`} />
        <div className={`h-9 w-full ${bar}`} />
      </CardBody>
    </Card>
  );
}
