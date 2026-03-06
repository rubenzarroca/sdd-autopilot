# MCP Tools
Source: https://modelcontextprotocol.io/docs/concepts/tools
Snapshot date: 2026-03-06
Protocol Revision: 2025-06-18

## Overview
MCP allows servers to expose tools that can be invoked by language models.
Tools are model-controlled: LLM can discover and invoke tools automatically.
Servers that support tools MUST declare the "tools" capability.

## Capabilities Declaration
{
  "capabilities": {
    "tools": {
      "listChanged": true
    }
  }
}
listChanged: indicates server will emit notifications when available tools change.

## Protocol Messages

### Listing Tools (tools/list)
Request: { "jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": { "cursor": "..." } }
Supports pagination via cursor.

### Calling Tools (tools/call)
Request: { "jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": { "name": "tool_name", "arguments": {...} } }

### List Changed Notification
{ "jsonrpc": "2.0", "method": "notifications/tools/list_changed" }

## Tool Definition Schema
{
  "name": "unique_identifier",
  "title": "Optional human-readable name",
  "description": "Human-readable description",
  "inputSchema": { /* JSON Schema */ },
  "outputSchema": { /* Optional JSON Schema for structured output */ },
  "annotations": { /* Optional metadata about tool behavior */ }
}

## Tool Result Content Types
- Text: { "type": "text", "text": "..." }
- Image: { "type": "image", "data": "base64...", "mimeType": "image/png" }
- Audio: { "type": "audio", "data": "base64...", "mimeType": "audio/wav" }
- Resource Link: { "type": "resource_link", "uri": "...", "name": "...", "mimeType": "..." }
- Embedded Resource: { "type": "resource", "resource": { "uri": "...", "mimeType": "...", "text": "..." } }
- Structured: returned as JSON in structuredContent field

## Error Handling
1. Protocol Errors: Standard JSON-RPC errors (unknown tools, invalid arguments, server errors)
2. Tool Execution Errors: In tool results with isError: true

## Security Requirements
Servers MUST: validate all tool inputs, implement access controls, rate limit tool invocations, sanitize outputs.
Clients SHOULD: prompt for user confirmation on sensitive operations, validate results, implement timeouts, log usage.

## New in 2025-06-18
- outputSchema: optional JSON Schema for structured output validation
- Structured content (structuredContent field) for returning JSON objects
- Resource links and embedded resources with annotations
- Audio content type support
