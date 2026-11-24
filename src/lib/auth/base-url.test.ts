import { describe, expect, it } from "vitest";
import { loopbackRedirect } from "./base-url";

const BASE = "http://127.0.0.1:4100";

describe("loopbackRedirect", () => {
  it("sends localhost to the configured loopback address, keeping the path and query", () => {
    expect(loopbackRedirect(new URL("http://localhost:4100/sign-in?next=%2Fprojects"), BASE)).toBe("http://127.0.0.1:4100/sign-in?next=%2Fprojects");
    expect(loopbackRedirect(new URL("http://[::1]:4100/"), BASE)).toBe("http://127.0.0.1:4100/");
    expect(loopbackRedirect(new URL("http://127.0.0.1:4100/x"), "http://localhost:4100")).toBe("http://localhost:4100/x");
  });

  it("leaves the base host, other ports, other schemes and real domains alone", () => {
    expect(loopbackRedirect(new URL("http://127.0.0.1:4100/sign-in"), BASE)).toBeNull();
    expect(loopbackRedirect(new URL("http://localhost:3000/"), BASE)).toBeNull();
    expect(loopbackRedirect(new URL("https://localhost:4100/"), BASE)).toBeNull();
    expect(loopbackRedirect(new URL("http://localhost:4100/"), "https://app.example.com")).toBeNull();
    expect(loopbackRedirect(new URL("https://app.example.com/"), BASE)).toBeNull();
    expect(loopbackRedirect(new URL("http://localhost:4100/"), "not a url")).toBeNull();
  });
});
