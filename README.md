# Luca for AI assistants

[Luca](https://setluca.com) helps coaches, creators, and experts manage the conversations that lead to sales. This connection lets you ask an AI assistant about your Luca workspace and get help with the work waiting there.

You can ask it to show what needs attention, find a lead's conversation before a call, draft a reply in your voice, or explain how a campaign is doing. It can also help plan your next campaign or follow up on calls that still need an outcome.

Your assistant must get your approval before it takes an action that reaches a lead, such as sending a message or launching a broadcast. Replies drafted by Luca still wait for your review in Luca.

## Get connected

Luca works with assistants such as Claude, ChatGPT, and Cursor. Some connect through your Luca sign-in. Others use an API key you create in Luca. The public [connection guide](https://setluca.com/connect) walks through both options and helps you choose the one your assistant supports.

Once connected, try asking:

- "What needs my attention in Luca this morning?"
- "Show me the review queue and recommend what to approve."
- "Pull up everything about this lead before my call."
- "Draft a short, warm reply for this lead."
- "How is my broadcast performing?"

If a connection stops working, check the steps in the connection guide. You can manage or revoke connected assistants in **Luca → Settings → Connected agents**. You can revoke an API key in **Luca → Settings → Developer API keys**.

## Your data and your choices

The assistant only sees what the Luca access you give it allows. This connection does not keep its own copy of your workspace data. It passes your requests to Luca and returns the results to your assistant. Review the privacy policy of any assistant you connect before sharing a live workspace with it.

Read [Luca's privacy policy](https://setluca.com/privacy) for details about how Luca handles your data.

## For people building with Luca

Start with the [documentation index](./docs/README.md). It points to setup, tool examples, the [privacy](./docs/privacy.md) and [security](./docs/security.md) guides, development instructions, tests, and release steps. [AGENTS.md](./AGENTS.md) gives coding agents a short checklist. The [changelog](./CHANGELOG.md) lists changes by version, including changes to tool names that may affect saved prompts.

You can browse the [Luca API docs](https://api.setluca.com/docs) if you want to build a direct integration.
