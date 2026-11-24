import { authorizedClient, fixtureMode } from "./auth";
import { fixtureApis } from "./fixtures";
import { liveApis } from "./google-api";
import type { GoogleApis } from "./types";

/** The Google clients for the workspace's connected account. Throws GoogleNotConnectedError when there is none. */
export async function googleApis(workspaceId: number): Promise<GoogleApis> {
  if (fixtureMode()) return fixtureApis;
  const { client, account } = await authorizedClient(workspaceId);
  return liveApis(client, account.id);
}
