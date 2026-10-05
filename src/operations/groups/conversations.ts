import { op } from "../registry.ts";
import type { LucaOperation } from "../registry.ts";

export const conversationsOperations: readonly LucaOperation[] = [
  op({
    id: "conversations.list",
    title: "List conversations",
    description:
      "List recent conversations. Query supports limit, cursor, channel, and q.",
  }),
  op({
    id: "conversations.get",
    title: "Get a conversation",
    description: "Get a conversation with messages and lead context.",
  }),
  op({
    id: "conversations.messages",
    title: "Read a conversation's messages",
    description:
      "Page backward through a thread's older messages, for threads longer than the window the conversation read returns.",
  }),
  op({
    id: "conversations.send",
    // Answers with ids and status flags only; no lead-authored text.
    untrustedContent: false,
    title: "Send a message to a lead",
    openWorld: true,
    confirm: "always",
    description:
      "Send a message to the lead on their channel right away. This is the one conversation tool that reaches a real person without a reviewer seeing the message first, which is why it needs an explicit confirm. Prefer drafting into the review queue unless the coach has asked for this message to go out now.",
  }),
  op({
    id: "conversations.partial_send_retry",
    // Answers with ids and status flags only; no lead-authored text.
    untrustedContent: false,
    title: "Retry unsent message parts",
    openWorld: true,
    mutatesExisting: true,
    confirm: "always",
    description:
      "Retry only the parts of a partially sent message that are known not to have reached the provider.",
  }),
];
