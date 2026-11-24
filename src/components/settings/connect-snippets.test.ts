import { describe, expect, it } from "vitest";
import { connectSnippets, exportKeyLine, KEY_ENV } from "./connect-snippets";

const endpoint = "https://app.getseopen.com/api/mcp";
const snippets = connectSnippets(endpoint);
const byId = (id: string) => snippets.find((s) => s.id === id)!;

describe("connectSnippets", () => {
  it("connects Claude Code for every folder, reading the key from the environment", () => {
    expect(byId("claude").code).toBe(`claude mcp add --scope user --transport http seopen ${endpoint} --header 'Authorization: Bearer \${SEOPEN_API_KEY}'`);
  });

  it("gives Cursor its user-level mcp.json, with Cursor's env syntax in the header", () => {
    const cursor = byId("cursor");
    expect(cursor.where).toBe("~/.cursor/mcp.json");
    expect(JSON.parse(cursor.code)).toEqual({ mcpServers: { seopen: { url: endpoint, headers: { Authorization: "Bearer ${env:SEOPEN_API_KEY}" } } } });
  });

  it("gives Codex its config.toml table, naming the variable rather than the key", () => {
    const codex = byId("codex");
    expect(codex.where).toBe("~/.codex/config.toml");
    expect(codex.code).toBe(`[mcp_servers.seopen]\nurl = "${endpoint}"\nbearer_token_env_var = "SEOPEN_API_KEY"`);
  });

  it("lists Claude Code, Cursor and Codex, and never writes a key into one", () => {
    expect(snippets.map((s) => s.label)).toEqual(["Claude Code", "Cursor", "Codex"]);
    for (const s of snippets) expect(s.code).not.toMatch(/seopen_[A-Za-z0-9]/);
  });
});

describe("exportKeyLine", () => {
  it("puts the key in the variable the snippets read", () => {
    expect(KEY_ENV).toBe("SEOPEN_API_KEY");
    expect(exportKeyLine("seopen_abc123")).toBe('export SEOPEN_API_KEY="seopen_abc123"');
  });
});
