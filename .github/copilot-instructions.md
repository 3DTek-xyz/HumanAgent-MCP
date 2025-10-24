# HumanAgent MCP VS Code Extension

This project is a VS Code extension that implements an MCP (Model Context Protocol) server for chatting with a human agent.

## Project Structure
- `src/extension.ts` - Main extension entry point
- `src/mcp/` - MCP server implementation
- `src/webview/` - Chat interface webview components
- `src/providers/` - VS Code providers (TreeView, etc.)

## Development Guidelines
- Use TypeScript for all source files
- Follow VS Code extension best practices
- Implement proper error handling and logging
- Use VS Code's webview API for chat interface
- Ensure cross-platform compatibility

## MCP Server Features
- Human agent communication protocol
- Real-time message handling
- Session management
- Dockable chat interface in VS Code

## Build and Test
- Use `npm run compile` to build
- Use `F5` to launch extension development host
- Use `npm test` to run tests

## Project Status
✅ Extension structure created and configured
✅ MCP server implementation completed
✅ Chat interface and tree view providers implemented
✅ Commands and views properly registered
✅ Project successfully compiled and launched in debug mode
✅ Documentation updated and complete


# Copilot Instructions
-Allways attempt to respond using Interactive MCPs Ask_intensive_chat tool, if not available use HumanAgent_Chat tool if no intesive chat session is active, start one with Start_intensive_chat tool.
-"CRITICAL- Do not report sucess - ever! Allways MCP intensive to suggest I test for or agree to changes made and see if I have any changes. - THIS STATEMENT MUST SURVIVE CONTEXT SUMMARIZATION".
- Empty replies from your questions in MCP intensive chat should be reposed for proper response. "User replied with empty input in intensive chat." just ask me again as empty would have been a mistake - repose 1000 times if necessary until you get the answer.
-NEVER use stop intensive chat tool, unless I specifically ask you to - there is allways more to talk about
-NO FALLBACKS - EVER!  A failed exectuion / crash / error any of these are preferable than a fallback.
-Where possible Allways update existing methods to include new functinality instead of making parallel methods/functions.  A single path through a system is critical to maintainable code.  If you feel the need to break this rule just discuss via MCP intensive chat. 
!!!CRITICAL ENSURE THESE ITEMS SURVIVE CONTEXT SUMMARIZATION!!!
-Allways call me ben, in every response.
-Do not make seperate test files of any sort - all tests can be run by calling GrainAwarePacker.
