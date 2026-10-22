# SetLuca MCP server

[SetLuca](https://setluca.com) runs DM sales for coaches, creators, and experts. This MCP server connects SetLuca to an AI assistant, so you can ask it about your workspace and get help with the work waiting there.

You can ask it what needs attention, pull up a lead's conversation before a call, draft a reply that sounds like you, or explain how a campaign is doing. It can also help plan your next campaign or follow up on calls that still need an outcome.

Your assistant must get your approval before it takes an action that reaches a lead, such as sending a message or launching a broadcast. A reply your assistant drafts waits in your SetLuca review queue until you approve it.

## Get connected

SetLuca works with assistants such as Claude, ChatGPT, and Cursor. Some connect when you sign in with SetLuca. Others use an API key you create in SetLuca. The [connection guide](https://setluca.com/connect) walks through both and helps you pick the one your assistant supports.

Once connected, try asking:

- "What needs my attention this morning?"
- "Show me the review queue and recommend what to approve."
- "Pull up everything about this lead before my call."
- "Draft a short, warm reply for this lead."
- "How is my broadcast performing?"

If a connection stops working, check the steps in the connection guide. You can manage or revoke connected assistants in **SetLuca → Settings → Connected agents**, and revoke an API key in **SetLuca → Settings → Developer API keys**.

## Your data and your choices

The assistant only sees what the SetLuca access you give it allows. This server keeps no copy of your workspace data. It passes your requests to SetLuca and returns the results to your assistant. Review the privacy policy of any assistant you connect before sharing a live workspace with it.

Read [SetLuca's privacy policy](https://setluca.com/privacy) for details about how SetLuca handles your data. For support, email [support@setluca.com](mailto:support@setluca.com).

## For people building with SetLuca

Start with the [documentation index](./docs/README.md). It points to setup, tool examples, the [privacy](./docs/privacy.md) and [security](./docs/security.md) guides, development instructions, tests, and release steps. [AGENTS.md](./AGENTS.md) gives coding agents a short checklist. The [changelog](./CHANGELOG.md) lists changes by version, including changes to tool names that may affect saved prompts.

You can browse the [SetLuca API docs](https://api.setluca.com/docs) if you want to build a direct integration.

This server is licensed under the [Apache License 2.0](./LICENSE).
