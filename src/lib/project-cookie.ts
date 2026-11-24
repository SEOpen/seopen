/**
 * The current project's cookie. Its own module, with no imports, so proxy.ts can set it when a
 * `/projects/<id>` URL opens without pulling in the database.
 */
export const PROJECT_COOKIE = "seopen_project";

export const PROJECT_COOKIE_OPTIONS = { httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 365 } as const;

/** The project id a URL names: "/projects/12" and "/projects/12/settings" → "12". */
export function projectIdFromPath(pathname: string): string | null {
  return /^\/projects\/(\d+)(?:\/|$)/.exec(pathname)?.[1] ?? null;
}
