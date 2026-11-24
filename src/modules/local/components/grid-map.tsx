"use client";

import { useMemo, useState, type CSSProperties } from "react";
import { Badge } from "@/components/ui/badge";
import type { LocalListing } from "@/db/schema/local";
import { cn } from "@/lib/utils";
import { DOT, LIGHT_BASE } from "../dots";
import { bucketOf, type Bucket, type PointStatus } from "../metrics";
import { isSameListing, type ListingIds } from "../parse";
import { pointPlace } from "../point-place";
import { layoutTiles, osmTileUrl } from "../tiles";

export interface MapPoint {
  row: number;
  col: number;
  lat: number;
  lng: number;
  status: PointStatus;
  rank: number | null;
  items: LocalListing[];
  /** Why the search failed. The page sends a customer only SEOpen's own reasons (plainCheckReason), never the vendor's text. */
  error: string | null;
}

export const LEGEND: { bucket: Bucket; label: string; mark: string }[] = [
  { bucket: "top3", label: "Rank 1–3", mark: "" },
  { bucket: "top10", label: "Rank 4–10", mark: "" },
  { bucket: "top20", label: "Rank 11–20", mark: "" },
  { bucket: "none", label: "Not in the top 20", mark: "–" },
  { bucket: "failed", label: "Search failed, not counted", mark: "!" },
];

function dotText(p: MapPoint): string {
  const b = bucketOf(p);
  if (b === "pending") return "…";
  if (b === "failed") return "!";
  if (b === "none") return "–";
  return String(p.rank);
}

function describe(p: MapPoint): string {
  const b = bucketOf(p);
  if (b === "pending") return "waiting for the result";
  if (b === "failed") return "failed";
  if (b === "none") return "not in the top 20";
  return `rank ${p.rank}`;
}

const pointKey = (p: { row: number; col: number }) => `${p.row}:${p.col}`;

/**
 * The geo-grid drawn by hand (no map library), with the listings Maps returned at the selected
 * point beside it. The base is one Google Maps Static image when `googleMap` is set, already
 * greyed by Google's own styling and left unfiltered; otherwise, or when that image fails to load,
 * OpenStreetMap tiles, greyed so only the rank dots carry colour and inverted in dark mode. The dots and legend take
 * their colours from the base under them, not the page (see dots.ts).
 */
export function GridMap({
  points,
  center,
  gridSize,
  ours,
  title,
  googleMap,
}: {
  points: MapPoint[];
  center: { lat: number; lng: number };
  gridSize: number;
  ours: ListingIds;
  title: string;
  /** SEOpen's own route for this view's Google image (`staticMapHref`), never a signed Google URL; null for OpenStreetMap. */
  googleMap?: string | null;
}) {
  // A Google image that doesn't load (Google down, or the route refusing) gives way to OpenStreetMap.
  const [googleFailed, setGoogleFailed] = useState(false);
  const google = googleMap && !googleFailed ? googleMap : null;
  const mid = Math.floor(gridSize / 2);
  const [selected, setSelected] = useState<string>(() => {
    const c = points.find((p) => p.row === mid && p.col === mid) ?? points[0];
    return c ? pointKey(c) : "";
  });
  const layout = useMemo(() => layoutTiles(center, points), [center, points]);
  const current = points.find((p) => pointKey(p) === selected) ?? null;
  const dotSize = gridSize >= 7 ? "size-6 @2xl/main:size-7" : "size-7 @2xl/main:size-8";

  return (
    <div className="grid gap-6 @5xl/main:grid-cols-[minmax(0,37.5rem)_minmax(0,1fr)]">
      <div className="w-full max-w-[600px] overflow-hidden rounded-lg border border-line bg-surface" style={google ? (LIGHT_BASE as CSSProperties) : undefined}>
        <div className="relative aspect-square w-full bg-surface-2">
          {google ? (
            // A square image filling the square frame, as the view does, so the points line up with layoutTiles.
            // eslint-disable-next-line @next/next/no-img-element -- bytes from our own signed-in route, nothing for next/image to optimise
            <img
              src={google}
              alt=""
              width={layout.view}
              height={layout.view}
              className="absolute inset-0 size-full"
              onError={() => setGoogleFailed(true)}
              // An image that failed before hydration fired no onError, so check once it's attached.
              ref={(img) => {
                if (img?.complete && img.naturalWidth === 0) setGoogleFailed(true);
              }}
            />
          ) : (
            <svg
              viewBox={`0 0 ${layout.view} ${layout.view}`}
              className="absolute inset-0 size-full opacity-80 [filter:grayscale(1)_contrast(0.9)] dark:opacity-70 dark:[filter:grayscale(1)_invert(1)_contrast(0.85)_brightness(0.9)]"
              aria-hidden
            >
              {layout.tiles.map((t) => (
                <image key={`${t.z}/${t.left}/${t.top}`} href={osmTileUrl(t)} x={t.left} y={t.top} width={256} height={256} />
              ))}
            </svg>
          )}
          <div role="group" aria-label={`Rank grid for ${title}`} className="absolute inset-0">
            {points.map((p) => {
              const pos = layout.place(p.lat, p.lng);
              const key = pointKey(p);
              const isCenter = p.row === mid && p.col === mid;
              const on = key === selected;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setSelected(key)}
                  aria-pressed={on}
                  aria-label={`${pointPlace(center, p)}: ${describe(p)}`}
                  className={cn(
                    "absolute flex -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border text-xs font-medium leading-none focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-fg",
                    dotSize,
                    DOT[bucketOf(p)],
                    isCenter && "outline-2 outline-offset-2 outline-fg",
                    on && "ring-2 ring-fg",
                  )}
                  style={{ left: `${pos.left * 100}%`, top: `${pos.top * 100}%` }}
                >
                  {dotText(p)}
                </button>
              );
            })}
          </div>
          {/* Google's image carries its own logo and attribution. */}
          {!google && (
            <a
              href="https://www.openstreetmap.org/copyright"
              target="_blank"
              rel="noreferrer"
              className="absolute right-0 bottom-0 rounded-tl-sm bg-surface/85 px-1.5 py-0.5 text-xs text-muted hover:text-fg"
            >
              © OpenStreetMap contributors
            </a>
          )}
        </div>
        <Legend className="border-t border-line px-3 py-2.5" />
      </div>
      <PointPanel point={current} center={center} ours={ours} />
    </div>
  );
}

export function Legend({ className }: { className?: string }) {
  return (
    <div className={cn("text-xs text-muted", className)}>
      <p>The number on a dot is your Google Maps rank from that point.</p>
      <ul className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2" aria-label="Legend">
        {LEGEND.map((l) => (
          <li key={l.bucket} className="flex items-center gap-1.5">
            <span className={cn("flex size-5 items-center justify-center rounded-full border text-xs leading-none font-medium", DOT[l.bucket])} aria-hidden>
              {l.mark}
            </span>
            {l.label}
          </li>
        ))}
        <li className="flex items-center gap-1.5">
          <span className="size-4 rounded-full border border-line-strong bg-surface outline-2 outline-offset-1 outline-fg" aria-hidden />
          Your listing
        </li>
      </ul>
    </div>
  );
}

function PointPanel({ point, center, ours }: { point: MapPoint | null; center: { lat: number; lng: number }; ours: ListingIds }) {
  if (!point) return null;
  const b = bucketOf(point);
  return (
    <section aria-live="polite" className="min-w-0">
      <h3 className="text-sm font-medium">{pointPlace(center, point)}</h3>
      <p className="mt-1 text-xs text-muted">
        {b === "pending"
          ? "Waiting for Google Maps. Reload in a minute."
          : b === "failed"
            ? `This search failed, so it says nothing about your rank${point.error ? ` (${point.error})` : ""}. It isn't counted as not found.`
            : b === "none"
              ? `Google Maps listed ${point.items.length} businesses here, and yours isn't among them.`
              : `You rank #${point.rank} of ${point.items.length} listings here.`}
      </p>
      {point.items.length > 0 && (
        <ol className="mt-3 divide-y divide-line border-y border-line @5xl/main:max-h-[580px] @5xl/main:overflow-y-auto">
          {point.items.map((it) => {
            const mine = isSameListing({ cid: it.cid, place_id: it.pid }, ours);
            return (
              <li key={`${it.r}-${it.cid ?? it.pid ?? it.t}`} className={cn("flex gap-3 px-1 py-2 text-sm", mine && "bg-surface-2 font-medium")}>
                <span className="data w-5 shrink-0 text-right text-muted">{it.r}</span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="min-w-0 truncate" title={it.t}>
                      {it.t}
                    </span>
                    {mine && (
                      <Badge tone="accent" className="shrink-0">
                        You
                      </Badge>
                    )}
                  </span>
                  <span className="block truncate text-xs font-normal text-muted">
                    {[it.cat, it.rating != null ? `★ ${it.rating.toFixed(1)}${it.votes != null ? ` (${it.votes})` : ""}` : null].filter(Boolean).join(" · ") || "–"}
                  </span>
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
