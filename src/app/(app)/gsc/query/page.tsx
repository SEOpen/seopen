import { Drilldown } from "@/modules/google/ui/drilldown";

export const metadata = { title: "Query · Search Console" };

export default async function QueryPage({ searchParams }: PageProps<"/gsc/query">) {
  return <Drilldown kind="query" sp={await searchParams} />;
}
