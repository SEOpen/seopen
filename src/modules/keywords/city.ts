import "server-only";
import { cityInMarket } from "@/lib/dataforseo/places";
import type { Place } from "@/lib/dataforseo/place-names";
import type { Project } from "@/lib/projects";
import type { Market } from "./requests";

export interface ResearchCity {
  city: Place | null;
  /** What links should carry for `city`: its code, or 0 to stay off the project's city. */
  param: number | undefined;
}

/**
 * The city for a keyword lookup: `?city=` when it's a city of the market, else the project's own
 * when researching in its country. `city=0` asks for none.
 */
export async function researchCity(raw: string | undefined, m: Market, project: Pick<Project, "locationCode" | "cityCode" | "cityName"> | null): Promise<ResearchCity> {
  const own = project?.cityCode && project.cityName && project.locationCode === m.locationCode ? { code: project.cityCode, name: project.cityName } : null;
  const none = own ? 0 : undefined;
  if (raw === undefined) return { city: own, param: own?.code };
  const code = Number(raw);
  if (!code) return { city: null, param: none };
  if (code === own?.code) return { city: own, param: code };
  const city = await cityInMarket(code, m.locationCode);
  return { city, param: city?.code ?? none };
}
