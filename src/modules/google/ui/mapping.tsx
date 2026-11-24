import { ActionForm } from "@/components/ui/action-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ConfirmSubmit } from "@/components/ui/confirm-submit";
import { Select } from "@/components/ui/input";
import { ApiError } from "@/components/api-error";
import { listProjects } from "@/lib/projects";
import { applySuggestions, setProjectProperties } from "../actions";
import { planImport, propertyName, siteLabel, suggestGa4Property, suggestGscProperty, usableSite } from "../matching";
import { workspaceScope } from "@/lib/workspace/current";
import { listGoogleProperties } from "../properties";
import { ImportPicker } from "./import-picker";

/**
 * Every project with its GSC and GA4 property. Unmapped projects get a suggestion by domain;
 * Search Console properties with no project can be imported as new projects.
 */
export async function PropertyMapping({ currentProjectId }: { currentProjectId: number }) {
  let props: Awaited<ReturnType<typeof listGoogleProperties>>;
  try {
    props = await listGoogleProperties((await workspaceScope()).workspaceId);
  } catch (e) {
    return <ApiError error={e} />;
  }
  const projects = await listProjects();
  const sites = props.sites.filter(usableSite);
  const rows = projects.map((p) => ({
    p,
    gscSuggestion: p.gscProperty ? null : suggestGscProperty(p.domain, sites),
    // A project on PostHog, Plausible or Umami gets no GA4 suggestion: the select would default to it, and saving the row
    // for any other reason would replace the project's Analytics source and drop its rows.
    ga4Suggestion: p.ga4Property || p.posthogProject || p.plausibleSite || p.umamiSite ? null : suggestGa4Property(p.domain, props.ga4),
  }));
  const pending = rows.filter((r) => r.gscSuggestion || r.ga4Suggestion);
  const importable = planImport(projects, sites);

  const ga4Options = props.ga4.map((g) => ({ property: g.property, label: `${g.propertyName} · ${g.accountName} (${g.property.replace("properties/", "")})` }));

  return (
    <>
      <Card>
        <CardHeader
          title="Properties"
          description={`${sites.length} Search Console ${sites.length === 1 ? "property" : "properties"} and ${props.ga4.length} GA4 ${props.ga4.length === 1 ? "property" : "properties"} on this account.`}
          actions={
            pending.length > 0 && (
              <form action={applySuggestions}>
                <input type="hidden" name="suggestions" value={JSON.stringify(pending.map((r) => ({ id: r.p.id, gsc: r.gscSuggestion, ga4: r.ga4Suggestion })))} />
                <Button variant="secondary" size="sm" type="submit">
                  Apply {pending.length} suggestion{pending.length === 1 ? "" : "s"}
                </Button>
              </form>
            )
          }
        />
        <CardBody className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead className="table-head">
              <tr>
                <th scope="col" className="h-9 px-4 text-left font-medium">Project</th>
                <th scope="col" className="h-9 px-4 text-left font-medium">Search Console</th>
                <th scope="col" className="h-9 px-4 text-left font-medium">GA4</th>
                <th scope="col" className="h-9 px-4">
                  <span className="sr-only">Save</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ p, gscSuggestion, ga4Suggestion }) => {
                const formId = `map-${p.id}`;
                return (
                  <tr key={p.id} className="border-t border-line-soft align-middle">
                    <td className="px-4 py-2">
                      <div className="font-medium">
                        {p.name} {p.id === currentProjectId && <Badge tone="accent">Current</Badge>}
                      </div>
                      <div className="text-xs text-muted">{p.domain}</div>
                    </td>
                    <td className="px-4 py-2">
                      <Select form={formId} name="gscProperty" defaultValue={p.gscProperty ?? gscSuggestion ?? ""} aria-label={`Search Console property for ${p.name}`} className="h-8 w-full max-w-72 text-xs">
                        <option value="">None</option>
                        {p.gscProperty && !sites.some((s) => s.siteUrl === p.gscProperty) && <option value={p.gscProperty}>{siteLabel(p.gscProperty)} (no access)</option>}
                        {sites.map((s) => (
                          <option key={s.siteUrl} value={s.siteUrl}>
                            {siteLabel(s.siteUrl)}
                          </option>
                        ))}
                      </Select>
                      {gscSuggestion && <div className="mt-1 text-xs text-secondary">Suggested by domain</div>}
                    </td>
                    <td className="px-4 py-2">
                      <Select form={formId} name="ga4Property" defaultValue={p.ga4Property ?? ga4Suggestion ?? ""} aria-label={`GA4 property for ${p.name}`} className="h-8 w-full max-w-72 text-xs">
                        <option value="">None</option>
                        {p.ga4Property && !props.ga4.some((g) => g.property === p.ga4Property) && <option value={p.ga4Property}>{propertyName(p.ga4Property)} (no access)</option>}
                        {props.ga4.map((g) => (
                          <option key={g.property} value={g.property}>
                            {g.propertyName} · {g.accountName} ({g.property.replace("properties/", "")})
                          </option>
                        ))}
                      </Select>
                      {ga4Suggestion && <div className="mt-1 text-xs text-secondary">Suggested by domain</div>}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <ActionForm id={formId} action={setProjectProperties.bind(null, p.id)} align="end">
                        {/* Pointing a project at a different property clears what was synced from the old one. */}
                        {p.gscProperty || p.ga4Property || p.posthogProject || p.plausibleSite || p.umamiSite ? (
                          <ConfirmSubmit question={`Save ${p.name}? Any property you changed starts over, and what was synced from the old one is cleared.`} confirmLabel="Save">
                            Save
                          </ConfirmSubmit>
                        ) : (
                          <Button size="sm" variant="secondary" type="submit">
                            Save
                          </Button>
                        )}
                      </ActionForm>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </CardBody>
      </Card>
      {importable.length > 0 && (
        <Card className="mt-6">
          <CardHeader
            title="Import from Search Console"
            description={`${importable.length} ${importable.length === 1 ? "site" : "sites"} on this account ${importable.length === 1 ? "isn't" : "aren't"} a project yet. Tick the ones to add; each becomes a project and starts syncing.`}
          />
          <CardBody className="overflow-x-auto p-0">
            <ImportPicker candidates={importable.map((i) => ({ ...i, ga4Suggestion: suggestGa4Property(i.domain, props.ga4) }))} ga4Options={ga4Options} />
          </CardBody>
        </Card>
      )}
    </>
  );
}
