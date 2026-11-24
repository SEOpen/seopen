// Grid geometry and cost for a geo-grid check. Pure, so it is unit tested and safe in client components.

import { formatUsd } from "@/lib/format";
import { costLabel } from "@/modules/keywords/format";
import { rules } from "@/plan-policy/rules";

export const GRID_SIZES = [3, 5, 7] as const;
export type GridSize = (typeof GRID_SIZES)[number];
export const DEFAULT_GRID_SIZE: GridSize = 5;

/** Distance from the listing to the edge of the grid, in miles. */
export const RADII_MILES = [1, 3, 5, 10] as const;
export type RadiusMiles = (typeof RADII_MILES)[number];
export const DEFAULT_RADIUS_MILES: RadiusMiles = 5;

/** Results asked for at each point. Maps shows 20 per page, so this is one page. */
export const DEPTH = 20;

/**
 * DataForSEO's price for one Google Maps task on the Standard queue at normal priority, depth 20
 * (one page of results). Checked against the ledger on 2026-11-02.
 */
export const PRICE_PER_POINT_USD = 0.0006;

/** Price of the Live Maps search that finds a listing. */
export const SEARCH_PRICE_USD = 0.002;

const KM_PER_DEG_LAT = 111.32;
export const KM_PER_MILE = 1.609344;

export function isGridSize(n: number): n is GridSize {
  return (GRID_SIZES as readonly number[]).includes(n);
}

export function isRadius(n: number): n is RadiusMiles {
  return (RADII_MILES as readonly number[]).includes(n);
}

/**
 * The Google Maps zoom each point is searched at. A phone screen at this zoom spans a little more
 * than the gap between points on a 5×5 grid, so neighbouring points see overlapping but distinct areas.
 */
export function zoomForRadius(radiusMiles: number): number {
  if (radiusMiles <= 1) return 15;
  if (radiusMiles <= 3) return 14;
  if (radiusMiles <= 5) return 13;
  return 12;
}

export interface GridPoint {
  /** 0-based from the north (top) edge. */
  row: number;
  /** 0-based from the west (left) edge. */
  col: number;
  lat: number;
  lng: number;
}

/**
 * An n×n square grid centred on (lat, lng), with the outer points `radiusMiles` north, south, east and
 * west of the centre. Rows run north to south and columns west to east. An odd size puts a point
 * on the listing itself.
 */
export function gridPoints(lat: number, lng: number, size: number, radiusMiles: number): GridPoint[] {
  if (!Number.isInteger(size) || size < 1) throw new Error(`Invalid grid size ${size}`);
  const radiusKm = radiusMiles * KM_PER_MILE;
  const kmPerDegLng = KM_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
  const half = size === 1 ? 0 : radiusKm;
  const step = size === 1 ? 0 : (2 * radiusKm) / (size - 1);
  const points: GridPoint[] = [];
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const north = half - row * step;
      const east = col * step - half;
      points.push({ row, col, lat: round7(lat + north / KM_PER_DEG_LAT), lng: round7(lng + east / kmPerDegLng) });
    }
  }
  return points;
}

/** Spacing between neighbouring points, in miles. */
export function gridSpacingMiles(size: number, radiusMiles: number): number {
  return size <= 1 ? 0 : (2 * radiusMiles) / (size - 1);
}

/** "lat,lng,13z": DataForSEO's location_coordinate for Google Maps (7 decimals at most). */
export function locationCoordinate(lat: number, lng: number, zoom: number): string {
  return `${round7(lat)},${round7(lng)},${zoom}z`;
}

/** Cost of one check before it runs: points × keywords × the price of one task. */
export function estimateCheckUsd(gridSize: number, keywords: number): number {
  return gridSize * gridSize * keywords * PRICE_PER_POINT_USD;
}

/**
 * "≈ 9 credits", followed by the dollars where the workspace sees them: "≈ 9 credits · $0.090".
 * Without plans the price is dollars already ("≈ $0.09"), so they aren't said twice.
 * It has no brackets of its own, so it reads the same in a sentence and inside a button's.
 */
export function priceLabel(usd: number, showUsd: boolean): string {
  return showUsd && rules.hasPlans ? `${costLabel(usd)} · ${formatUsd(usd, 3)}` : costLabel(usd);
}

/** "5×5 · 5 mi" */
export function gridLabel(size: number, radiusMiles: number): string {
  return `${size}×${size} · ${radiusMiles} mi`;
}

function round7(n: number): number {
  return Math.round(n * 1e7) / 1e7;
}
