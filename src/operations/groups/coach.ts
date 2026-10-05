import { op } from "../registry.ts";
import type { LucaOperation } from "../registry.ts";

export const coachOperations: readonly LucaOperation[] = [
  op({
    id: "coach.profile",
    title: "Read the coach's profile",
    description:
      "Read the coach's account record: name, timezone, business hours, and tone slider. Use it to know when the coach is reachable and how formal they want to sound.",
  }),
  op({
    id: "coach.niche",
    title: "Read the coach's niche",
    description:
      "Read the coach's canonical niche, the cohort key their benchmarks are compared against.",
  }),
  op({
    id: "coach.nicheProfile",
    title: "Read the coach's niche profile",
    description:
      "Read the coach's offer, audience, price range, promised outcomes, disqualifiers, and FAQs. This is the context that decides whether a lead is a fit.",
  }),
  op({
    id: "coach.objectionPlaybook",
    title: "Read the coach's objection playbook",
    description:
      "Read how the coach wants each objection type handled — price, timing, trust, fit — before drafting a reply to one.",
  }),
  op({
    id: "coach.postCallSettings",
    title: "Read the post-call settings",
    description:
      "Read the coach's post-call preferences: what gets summarized, what gets pushed to the CRM, and what the coach fills in themselves.",
  }),
  op({
    id: "coach.postCallCrmMapping",
    title: "Read the post-call CRM mapping",
    description:
      "Read which CRM field each post-call value writes to. Check this before a CRM push to know what will land where.",
  }),
  op({
    id: "coach.postCallDealSync",
    title: "Read the post-call deal sync settings",
    description:
      "Read the CRM pipeline and the stage each call outcome moves a deal to.",
  }),
  op({
    id: "coach.auditLog",
    title: "Read the audit log",
    description:
      "Read the coach-visible audit trail, newest first, filterable by actor type, action, action prefix, or target. It is the one read that spans every domain, so use it to check what a previous run actually did instead of replaying each list route.",
  }),
];
