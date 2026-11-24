const OLD_CITY_NAMES: Record<string, string> = {
  "Asia/Calcutta": "Asia/Kolkata",
  "Asia/Katmandu": "Asia/Kathmandu",
  "Asia/Rangoon": "Asia/Yangon",
  "Asia/Saigon": "Asia/Ho_Chi_Minh",
  "Europe/Kiev": "Europe/Kyiv",
};

/**
 * A zone's name for people: "America/New York". Runtimes still report some cities under their old
 * names (Asia/Calcutta), which stay the stored value but read as the current one (Asia/Kolkata).
 */
export function timeZoneName(zone: string): string {
  return (OLD_CITY_NAMES[zone] ?? zone).replaceAll("_", " ");
}

function utcOffset(zone: string, now: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZoneName: "shortOffset", timeZone: zone }).formatToParts(now);
  return parts.find((p) => p.type === "timeZoneName")?.value ?? "";
}

/** How the picker names a zone at that moment: "New York (GMT-5)", "Knox, Indiana (GMT-6)", "UTC". */
export function zoneLabel(zone: string, now = new Date()): string {
  if (zone === "UTC") return "UTC";
  const [region, ...place] = timeZoneName(zone).split("/");
  return `${place.reverse().join(", ") || region} (${utcOffset(zone, now)})`;
}

export interface TimeZoneOption {
  value: string;
  label: string;
}

/**
 * Every zone this runtime knows, by region, sorted by city so typing a city name in the select
 * finds it: "Tokyo (GMT+9)", "Knox, Indiana (GMT-6)". UTC, which runtimes leave out of their list,
 * comes first. `current` always appears, so a stored zone from another runtime's list stays selected.
 */
export function timeZoneOptions(current: string, now = new Date()): { region: string; zones: TimeZoneOption[] }[] {
  const zones = new Set(Intl.supportedValuesOf("timeZone"));
  zones.delete("UTC");
  zones.add(current);
  const regions = new Map<string, TimeZoneOption[]>();
  for (const zone of zones) {
    if (zone === "UTC") continue;
    const [region] = timeZoneName(zone).split("/");
    const options = regions.get(region) ?? [];
    options.push({ value: zone, label: zoneLabel(zone, now) });
    regions.set(region, options);
  }
  return [
    { region: "UTC", zones: [{ value: "UTC", label: "UTC" }] },
    ...[...regions.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([region, options]) => ({ region, zones: options.sort((a, b) => a.label.localeCompare(b.label)) })),
  ];
}
