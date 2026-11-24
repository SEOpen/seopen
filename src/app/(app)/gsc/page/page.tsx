import { Drilldown } from "@/modules/google/ui/drilldown";

export const metadata = { title: "Page · Search Console" };

export default async function PageDetail({ searchParams }: PageProps<"/gsc/page">) {
  return <Drilldown kind="page" sp={await searchParams} />;
}
