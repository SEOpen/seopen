import { Geist_Mono, Outfit } from "next/font/google";
import localFont from "next/font/local";

// Outfit is the words: headlines at 700 and UI at 400 to 500. Geist Mono is the machine-read part:
// deltas, chart ticks, dates, table numbers, URLs in cells, shortcuts and code. Only latin is preloaded;
// other scripts load when a page needs them.
const sans = Outfit({ variable: "--font-outfit", subsets: ["latin"] });
const mono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

// Google's slices of Outfit leave out → and ↗, though the font draws them. Under 2KB, fetched only by a
// page that shows one.
const sansSymbols = localFont({
  src: "./font-assets/outfit-symbols.woff2",
  variable: "--font-outfit-symbols",
  weight: "100 900",
  preload: false,
  adjustFontFallback: false,
  declarations: [{ prop: "unicode-range", value: "U+2192,U+2197" }],
});

// Google's slices of Geist Mono leave out these, though the font draws them. Outfit has no ≈, ≤, ≥, ▲ or ▼
// at all, so the sans stack takes them from here too, ahead of the system. Same terms: under 2KB, on demand.
const monoSymbols = localFont({
  src: "./font-assets/geist-mono-symbols.woff2",
  variable: "--font-geist-mono-symbols",
  weight: "100 900",
  preload: false,
  adjustFontFallback: false,
  declarations: [{ prop: "unicode-range", value: "U+2192,U+2197,U+2248,U+2264,U+2265,U+25B2,U+25BC" }],
});

/** For <html>, in the root layout and in global-error.tsx, which replaces it. */
export const fontVariables = `${sans.variable} ${mono.variable} ${sansSymbols.variable} ${monoSymbols.variable}`;
