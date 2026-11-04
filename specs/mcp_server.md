# Planning Hub - MCP Server

The goal for this document is to describe the creation of an MCP Server for the CM Planning Hub, including its functional and technical requirements.
This will allow AI models to create release plans and provide already a best-effort plan considering the user's context input.

## Functional Requirements

1. The MCP Server shall implement tools for the Release Plan application.
2. The MCP Server shall provide tools to create or update Release Plan boards.
3. The agent must be aware of the JSON structure used for Release Plan boards (state) and the server must validate the JSON structure received is valid.

## Technical Requirements

1. Create an MCP server to implement tools that support the functional requirements.
2. The MCP server must be aware of the JSON structure to build a board (similar to `normalizePlan`) and the APIs that store the board.
3. The MCP server tool that creates or updates a plan must validate the JSON structure received from the agent before storing it. The tool must return an exception if cannot create or save the state.
