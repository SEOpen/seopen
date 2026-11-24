import { afterEach, describe, expect, it, vi } from "vitest";
import { gridPoints } from "./grid";
import { googleStaticMapUrl, signStaticMapPath, StaticMapError, staticMapImage, staticMapView } from "./static-map";
import { layoutTiles } from "./tiles";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ cacheLife: () => {} }));

const SLM = { lat: 42.7885, lng: -71.2009 };
// A made-up 20-byte secret in Google's URL-safe base64 form, with both - and _ in it.
const SECRET = "vNIXE0xscrmjlyV-12Nj_BvUPaw="; // gitleaks:allow (made up)

afterEach(() => vi.unstubAllEnvs());

describe("signStaticMapPath", () => {
  it("appends a URL-safe signature that depends on the path and the secret", () => {
    const signed = signStaticMapPath("/maps/api/staticmap?center=1,2&key=k", SECRET);
    const sig = signed.split("&signature=")[1];
    expect(signed.startsWith("/maps/api/staticmap?center=1,2&key=k&signature=")).toBe(true);
    expect(sig).toMatch(/^[A-Za-z0-9_=-]{28}$/);
    expect(signStaticMapPath("/maps/api/staticmap?center=1,2&key=k", SECRET)).toBe(signed);
    expect(signStaticMapPath("/maps/api/staticmap?center=1,3&key=k", SECRET)).not.toBe(signed);
  });

  it("reads the secret in URL-safe and standard base64 alike", () => {
    const standard = SECRET.replace(/-/g, "+").replace(/_/g, "/");
    expect(signStaticMapPath("/p?a=1", standard)).toBe(signStaticMapPath("/p?a=1", SECRET));
  });
});

describe("googleStaticMapUrl", () => {
  const points = gridPoints(SLM.lat, SLM.lng, 5, 5);

  it("is null without a key and signing secret, so the map falls back to OpenStreetMap", () => {
    vi.stubEnv("GOOGLE_MAPS_STATIC_KEY", "");
    vi.stubEnv("GOOGLE_MAPS_SIGNING_SECRET", SECRET);
    expect(googleStaticMapUrl(SLM, points)).toBeNull();
  });

  it("asks for the same centre, zoom and size the client lays the points out on", () => {
    vi.stubEnv("GOOGLE_MAPS_STATIC_KEY", "test-key");
    vi.stubEnv("GOOGLE_MAPS_SIGNING_SECRET", SECRET);
    const url = new URL(googleStaticMapUrl(SLM, points)!);
    const layout = layoutTiles(SLM, points);
    expect(url.origin + url.pathname).toBe("https://maps.googleapis.com/maps/api/staticmap");
    expect(url.searchParams.get("center")).toBe("42.788500,-71.200900");
    expect(url.searchParams.get("zoom")).toBe(String(layout.zoom));
    expect(url.searchParams.get("size")).toBe(`${layout.view}x${layout.view}`);
    expect(url.searchParams.get("scale")).toBe("2");
    expect(url.searchParams.getAll("style")).toContain("feature:poi|visibility:off");
    expect(url.searchParams.get("key")).toBe("test-key");
    expect(url.searchParams.get("signature")).toBeTruthy();
  });
});

describe("staticMapView", () => {
  it("keys the image on the view alone, the one layoutTiles draws", () => {
    const points = gridPoints(SLM.lat, SLM.lng, 5, 5);
    const layout = layoutTiles(SLM, points);
    expect(staticMapView(SLM, points)).toEqual({ center: "42.788500,-71.200900", zoom: layout.zoom, size: layout.view });
    // A difference below the URL's six places doesn't make a new image.
    expect(staticMapView({ lat: SLM.lat + 1e-8, lng: SLM.lng }, points)).toEqual(staticMapView(SLM, points));
  });
});

describe("staticMapImage", () => {
  const view = staticMapView(SLM, gridPoints(SLM.lat, SLM.lng, 5, 5));
  afterEach(() => vi.unstubAllGlobals());

  it("refuses Google's text error, even under a 200, so it's never cached", async () => {
    vi.stubEnv("GOOGLE_MAPS_STATIC_KEY", "test-key");
    vi.stubEnv("GOOGLE_MAPS_SIGNING_SECRET", SECRET);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("The request was rejected.", { headers: { "Content-Type": "text/plain" } })));
    await expect(staticMapImage(view)).rejects.toBeInstanceOf(StaticMapError);
  });

  it("refuses without a key and secret, without calling Google", async () => {
    vi.stubEnv("GOOGLE_MAPS_STATIC_KEY", "");
    vi.stubEnv("GOOGLE_MAPS_SIGNING_SECRET", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(staticMapImage(view)).rejects.toBeInstanceOf(StaticMapError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
