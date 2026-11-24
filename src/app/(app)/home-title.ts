/** The tab title of the app's home, which shows a different page for no project, one, or several (page.tsx). */
export function homeTitle(projects: number): string {
  if (!projects) return "Get started";
  return projects === 1 ? "Overview" : "All projects";
}
