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
  op({
    id: "conversations.send_status",
    // Answers with a status and an id only; no lead-authored text.
    untrustedContent: false,
    title: "Check whether a reply was accepted",
    description:
      "Look up a manual reply by the idempotency key it was sent with, to learn whether the API accepted it for sending before you send it again. accepted means it is queued to go out, not that it was delivered; not_found means no accepted send exists under that key.",
  }),
  op({
    id: "conversations.reply_failure_retry",
    // Answers with ids and status flags only; no lead-authored text.
    untrustedContent: false,
    title: "Resend a failed reply",
    openWorld: true,
    mutatesExisting: true,
    confirm: "always",
    description:
      "Send a reply the coach wrote that failed to go out, under the key it first went out with, so the lead never gets it twice. Only a failure that is safe to repeat can be retried. Sends a real message.",
  }),
  op({
    id: "conversations.reply_failure_dismiss",
    idempotent: true,
    // Answers with a flag only; no lead-authored text.
    untrustedContent: false,
    title: "Dismiss a failed reply",
    mutatesExisting: true,
    description:
      "Close a failed reply the coach has given up on, so it leaves the thread on every device. Sends nothing. Dismissing twice changes nothing.",
  }),
  op({
    id: "conversations.media_retry",
    // Answers with a job id and state only; no lead-authored text.
    untrustedContent: false,
    title: "Retry a voice-note transcription",
    mutatesExisting: true,
    description:
      "Queue another transcription attempt for a voice note in this conversation. Only re-transcribes; never drafts or sends. A refusal says why: a retry is already running, the limit is reached, or the audio is gone.",
  }),
];
