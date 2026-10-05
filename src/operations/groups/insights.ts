import { op } from "../registry.ts";
import type { LucaOperation } from "../registry.ts";

export const insightsOperations: readonly LucaOperation[] = [
  op({
    id: "insights.unreadCount",
    title: "Count unread insights",
    description:
      "How many insights the coach has not read yet. Cheap enough to poll before pulling the whole feed.",
  }),
  op({
    id: "insights.markRead",
    title: "Mark an insight read",
    mutatesExisting: true,
    description:
      "Mark one insight read, so it stops coming back at the top of the feed.",
  }),
  op({
    id: "insights.dismiss",
    title: "Dismiss an insight",
    mutatesExisting: true,
    description:
      "Dismiss one insight the coach does not want to act on. Use this rather than leaving it unread forever.",
  }),
  op({
    id: "insights.markActioned",
    title: "Mark an insight actioned",
    mutatesExisting: true,
    description:
      "Record that the thing an insight asked for was actually done. Use it after doing the work, not instead of it.",
  }),
  op({
    id: "insights.settings.get",
    title: "Read alert delivery settings",
    description:
      "Read which insight alerts reach the coach and how. The row is created with defaults on the first read, so this never 404s. Check it before concluding a quiet feed means nothing is happening \u2014 it may just be muted.",
  }),
  op({
    id: "insights.settings.update",
    title: "Update alert delivery settings",
    mutatesExisting: true,
    description:
      "Merge-patch the coach's alert-delivery settings. Send only what you are changing; anything left out keeps its current value.",
  }),
];
