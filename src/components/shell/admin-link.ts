import type { NavIconKey } from "./nav-model";

/** One Admin sidebar row. `after` places an extra page after a core one; without it, it goes last. */
export interface AdminLink {
  href: string;
  label: string;
  icon: NavIconKey;
  after?: string;
}
