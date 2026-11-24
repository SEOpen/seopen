/**
 * How each coding agent connects to SEOpen's MCP server, as `agents/README.md` gives it. Every one
 * reads the key from `SEOPEN_API_KEY`, so no key is written into an agent's config. Checked against
 * each tool's own docs on 2026-11-09:
 * - Claude Code: `claude mcp add` (`--scope user` works in every folder; the single quotes keep
 *   `${SEOPEN_API_KEY}` out of the shell, and Claude Code expands it when it connects).
 * - Cursor: `~/.cursor/mcp.json`, whose `headers` take `${env:NAME}`.
 * - Codex: `~/.codex/config.toml`, whose `bearer_token_env_var` names the variable.
 */

export const KEY_ENV = "SEOPEN_API_KEY";

export type ConnectSnippet = { id: "claude" | "cursor" | "codex"; label: string; where: string | null; code: string };

/** The line that puts a new key in the environment, for a shell profile such as `~/.zshrc`. */
export const exportKeyLine = (key: string) => `export ${KEY_ENV}="${key}"`;

export function connectSnippets(endpoint: string): ConnectSnippet[] {
  const cursor = { mcpServers: { seopen: { url: endpoint, headers: { Authorization: `Bearer \${env:${KEY_ENV}}` } } } };
  return [
    { id: "claude", label: "Claude Code", where: null, code: `claude mcp add --scope user --transport http seopen ${endpoint} --header 'Authorization: Bearer \${${KEY_ENV}}'` },
    { id: "cursor", label: "Cursor", where: "~/.cursor/mcp.json", code: JSON.stringify(cursor, null, 2) },
    { id: "codex", label: "Codex", where: "~/.codex/config.toml", code: `[mcp_servers.seopen]\nurl = "${endpoint}"\nbearer_token_env_var = "${KEY_ENV}"` },
  ];
}
