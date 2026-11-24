import { describe, expect, it } from "vitest";
import { messageSlot } from "./header-message";

const el = (attrs: string[], next: unknown = null) => ({ hasAttribute: (a: string) => attrs.includes(a), nextElementSibling: next });
const inHeader = (header: unknown) => ({ closest: (s: string) => (s === "[data-page-header]" ? header : null) }) as never;

describe("messageSlot", () => {
  it("finds the line under the header the action sits in", () => {
    const slot = el(["data-header-message"]);
    expect(messageSlot(inHeader(el([], slot)))).toBe(slot);
  });

  it("has none outside a header, or under one with no such line", () => {
    expect(messageSlot(inHeader(null))).toBeNull();
    expect(messageSlot(inHeader(el([], el([]))))).toBeNull();
    expect(messageSlot(inHeader(el([])))).toBeNull();
  });
});
