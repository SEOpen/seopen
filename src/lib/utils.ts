import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** A range such as 7d or 12m is a code, set in the mono. A segment holding words stays in the sans. */
export function isRangeCode(label: string) {
  return /^\d+[a-z]*$/i.test(label);
}
