import { z } from "zod";

/**
 * Where a visitor came from, for the waitlist and a sign-up's first visit. The page fills it in, so
 * one that's too long is cut, never an error the visitor can't fix.
 */
export const arrival = (max: number) =>
  z
    .string()
    .trim()
    .transform((s) => s.slice(0, max) || null)
    .nullish()
    .catch(null)
    .transform((s) => s ?? null);
