import { cn } from "@/lib/utils";

const pct = (v: number, min: number, max: number) => (max === min ? 0 : (Math.min(Math.max(v, min), max) - min) / (max - min)) * 100;

export interface GaugeData {
  min: number;
  max: number;
  value: number;
  /** The earlier reading, drawn as a ghost dot. */
  previous?: number | null;
  /** The dot turns the bad colour when the reading got worse. */
  worse?: boolean;
  /** The track fills green up to the dot when the reading got better, the one thing a gauge has to celebrate. */
  better?: boolean;
  /** Marks min up to here as the good zone (page one on a position scale). */
  zoneTo?: number;
}

/** A reading on a soft track: the dot is now, the small mark is the reading it compares against. */
export function Gauge({ min, max, value, previous, worse, better, zoneTo, className }: GaugeData & { className?: string }) {
  return (
    <span aria-hidden className={cn("relative block h-2", className)}>
      <span className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 overflow-hidden rounded-full bg-surface-2">
        {zoneTo != null && <span className="absolute inset-y-0 left-0 bg-zone-line" style={{ width: `${pct(zoneTo, min, max)}%` }} />}
        {better && <span className="absolute inset-y-0 left-0 bg-good-fill" style={{ width: `${pct(value, min, max)}%` }} />}
      </span>
      {previous != null && previous !== value && <span className="absolute top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-tick-major ring-1 ring-surface" style={{ left: `${pct(previous, min, max)}%` }} />}
      <span className={cn("absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-surface", worse ? "bg-bad" : "bg-fg")} style={{ left: `clamp(4px, ${pct(value, min, max)}%, calc(100% - 4px))` }} />
    </span>
  );
}

/** Position 1–20 with page one marked. A gained rank fills the track green and a dropped one turns the dot. Off the scale says which page instead. */
export function PositionGauge({ position, previous, className }: { position: number; previous?: number | null; className?: string }) {
  return (
    <Gauge
      min={1}
      max={20}
      value={position}
      previous={previous != null && previous <= 20 ? previous : null}
      worse={previous != null && position > previous}
      better={previous != null && position < previous}
      zoneTo={10.5}
      className={className}
    />
  );
}
