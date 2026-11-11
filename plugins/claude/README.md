# SetLuca for Claude Code

SetLuca is a DM sales platform for coaches, experts, creators and agencies. It replies to leads on Telegram, Instagram and Facebook Messenger the way the coach writes, qualifies them and books calls. WhatsApp is coming soon. Auto-send is on by default, and the coach can switch any channel to review, where replies wait for their approval.

This plugin connects Claude Code to your SetLuca workspace, so you can ask what needs your attention, work through the review queue, look up leads and conversations, draft replies, and check booked calls and campaigns.

## Install

```text
/plugin install setluca --marketplace setluca/luca-mcp
```

## Connect

The plugin adds the hosted SetLuca MCP server:

- URL: `https://mcp.setluca.com/mcp` (Streamable HTTP)
- Sign-in: OAuth 2.1 with PKCE. Run `/mcp`, choose **setluca**, then **Authenticate**, and sign in to SetLuca in your browser. You don't need an API key.

On the consent screen you choose what Claude may do. Read and draft are on by default, and you can add more. Manage or revoke the connection at any time from your SetLuca settings.

## Scopes

| Scope               | What it allows                                                                                                               |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `luca:read`         | Read leads, conversations, the review queue, bookings, campaigns, analytics and reports.                                     |
| `luca:draft`        | Everything in read, plus draft replies, add lead notes and update leads, memories and call feedback. Nothing reaches a lead. |
| `luca:queue_ops`    | Everything in draft, plus approve and send replies, book, move or cancel calls, and run broadcasts and campaigns.            |
| `luca:full`         | Everything in queue operations, plus change channels, integrations and webhooks.                                             |
| `luca:full_content` | Read the exact text leads wrote. Without it, lead messages come back redacted. This is separate from the levels above.       |

A tool that sends a message, launches a broadcast or books a call refuses to run until you approve that exact action.

## Links

- Setup guide: https://setluca.com/connect
- Privacy policy: https://setluca.com/privacy
- Terms of service: https://setluca.com/terms
- Support: support@setluca.com
- Source: https://github.com/setluca/luca-mcp (Apache-2.0)
