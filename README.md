# Selects MCP

Connects Claude Desktop to the [Selects](https://cutback.video/selects/install) desktop app via the Model Context Protocol.

Edit videos through natural conversation: query transcripts, keep utterances, modify drafts, install overlays.

## Install

1. Download `selects.mcpb` from [Releases](https://github.com/CutbackVideo/selects-mcp/releases)
2. In Claude Desktop: **Settings → Extensions → Install Extension**
3. Launch the Selects desktop app

## Requirements

- macOS 13+ or Windows 10+
- [Selects desktop app](https://cutback.video/selects/install) (must be running)
- Claude Desktop with Desktop Extensions support

## How it works

The connector is a thin stdio bridge. It forwards JSON-RPC requests from Claude Desktop to the Selects app's local MCP server (`127.0.0.1:23100`). All editing data stays on your machine.

```
Claude Desktop ──(stdio)──▶ Bridge ──(localhost HTTP)──▶ Selects
```

If the Selects app is not running, Claude can launch it via the bundled `launch_app` tool.

## Troubleshooting

- **"Selects is not running"** — Launch the Selects desktop app, or ask Claude to call `launch_app`. If the error persists, restart the app.
- **Connector shows "Unable to connect"** — Toggle the extension off and on in Claude Desktop → Settings → Extensions, then ensure the Selects app is running.
- **Tools not appearing in a conversation** — Start a new conversation after enabling the extension.

For other issues, contact <https://help.cutback.video/>.

## Support

<https://help.cutback.video/>
