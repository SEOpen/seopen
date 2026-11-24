"use client";

import { useState } from "react";
import { CityPicker } from "@/components/city-picker";
import { Select } from "@/components/ui/input";
import { LOCATIONS } from "@/lib/dataforseo/locations";
import type { Place } from "@/lib/dataforseo/place-names";

/** Country and optional city for a research form. `city=0` in the URL means "no city", even when the project has one. */
export function MarketFields({ locationCode, city: initialCity }: { locationCode: number; city: Place | null }) {
  const [country, setCountry] = useState(locationCode);
  const [city, setCity] = useState(initialCity);
  return (
    <>
      <Select
        name="loc"
        aria-label="Market"
        value={country}
        onChange={(e) => {
          setCountry(Number(e.target.value));
          // A city belongs to one country.
          setCity(null);
        }}
      >
        {LOCATIONS.map((l) => (
          <option key={l.code} value={l.code}>
            {l.name}
          </option>
        ))}
      </Select>
      <CityPicker country={country} value={city} onChange={setCity} name="city" emptyValue="0" label="City, optional" placeholder="City (optional)" className="w-72 max-w-full" />
    </>
  );
}
