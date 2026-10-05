import { z } from "zod";

/** Stable provider identities shared by storage, APIs, and integration code. */
export const CHANNELS = [
  "telegram",
  "instagram",
  "messenger",
  "whatsapp",
] as const;

export const ChannelSchema = z.enum(CHANNELS);

export type Channel = z.infer<typeof ChannelSchema>;

/** Recorded by the OAuth callback after state consumption and token exchange. */
export const ChannelOAuthEvidenceSchema = z.object({
  version: z.literal(1),
  source: z.enum(["provider_oauth", "provider_lab"]),
  stateFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
});

export type ChannelOAuthEvidence = z.infer<typeof ChannelOAuthEvidenceSchema>;

/**
 * How each channel is written in copy. Storage and events carry the slug, and
 * title-casing it gives "Whatsapp", which reads as a product that does not know
 * what WhatsApp is called. Emails, notifications, and the app quote from this
 * one table so the spelling cannot drift between surfaces.
 */
export const CHANNEL_LABELS = {
  telegram: "Telegram",
  instagram: "Instagram",
  messenger: "Messenger",
  whatsapp: "WhatsApp",
} satisfies Record<Channel, string>;

/**
 * Channels whose webhook subscription lives on a provider resource.
 *
 * Instagram subscribes a business account and WhatsApp a phone number, each
 * registered against an application id, and both resources can be shared with
 * other apps -- which is why the pair has to be stored and matched together.
 * Telegram and Messenger carry no such pair: Telegram's webhook is the bot
 * token, and Messenger's subscription belongs to the Page connection.
 *
 * A runtime value for the same reason `META_OAUTH_PROVIDERS` is one. This set
 * was written by hand twice inside a single `channel_accounts` check
 * constraint, where no drift guard can see it: it names `whatsapp`, so the
 * Meta guard passes it over, and it is not the full union, so the channel
 * guard passes it over too.
 */
export const SUBSCRIPTION_RESOURCE_CHANNELS = [
  "instagram",
  "whatsapp",
] as const satisfies readonly Channel[];

export type SubscriptionResourceChannel =
  (typeof SUBSCRIPTION_RESOURCE_CHANNELS)[number];

/** Whether an untyped string names one of the stable provider identities. */
export function isChannel(value: string): value is Channel {
  return CHANNELS.some((channel) => channel === value);
}

/**
 * The display label for a channel slug. Case-insensitive, so a value that is
 * already a label ("WhatsApp") maps to itself and a caller can pass either
 * form. Anything else comes back unchanged rather than blank: the caller
 * decides whether an unknown channel is a reason not to send, and a silently
 * emptied value would hide the bug that produced it.
 */
export function channelLabel(value: string): string {
  const slug = value.toLowerCase();

  return isChannel(slug) ? CHANNEL_LABELS[slug] : value;
}
