import * as Effect from "effect/Effect";
import { describe, expect, it, onTestFinished } from "vitest";

import type { LucaRequest } from "../src/http.ts";
import { optionalField } from "../src/optional-field.ts";
import { connect } from "./helpers.ts";

describe("booking confirmation", () => {
  describe("luca_close_call_loop confirmation", () => {
    async function closeLoop(args: Record<string, string | boolean | number>) {
      const requests: LucaRequest[] = [];

      const { client, close } = await connect((request) => {
        requests.push(request);

        return Effect.succeed({ callEvent: { id: "call-1" } });
      });

      onTestFinished(close);

      const result = await client.callTool({
        name: "luca_close_call_loop",
        arguments: { bookingId: "booking-1", ...args },
      });

      return { result, requests };
    }

    it("refuses a no_show report without confirm before any write", async () => {
      const { result, requests } = await closeLoop({ attendance: "no_show" });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual({
        error: {
          code: "confirmation_required",
          toolName: "luca_close_call_loop",
          requiredArgument: "confirm",
        },
      });
      expect(requests).toHaveLength(0);
    });

    it("files a no_show report that carries confirm", async () => {
      const { result, requests } = await closeLoop({
        attendance: "no_show",
        confirm: true,
      });

      expect(result.isError).not.toBe(true);
      expect(requests.length).toBeGreaterThan(0);
    });

    it("files a completed report without confirm", async () => {
      const { result, requests } = await closeLoop({ attendance: "completed" });

      expect(result.isError).not.toBe(true);
      expect(requests.length).toBeGreaterThan(0);
    });

    it.each(["won", "lost"])(
      "refuses a %s outcome without confirm before filing attendance",
      async (outcome) => {
        const { result, requests } = await closeLoop({
          attendance: "completed",
          outcome,
          amountMinor: 100,
          currency: "USD",
          lossReasonDefinitionId: "reason-1",
        });

        expect(result.structuredContent).toEqual({
          error: {
            code: "confirmation_required",
            toolName: "luca_close_call_loop",
            requiredArgument: "confirm",
          },
        });
        expect(requests).toHaveLength(0);
      }
    );

    it("files a won outcome with confirm", async () => {
      const { result, requests } = await closeLoop({
        attendance: "completed",
        outcome: "won",
        amountMinor: 100,
        currency: "USD",
        confirm: true,
      });

      expect(result.isError).not.toBe(true);
      expect(
        requests.some(
          (request) => request.operation.id === "bookings.outcome.record"
        )
      ).toBe(true);
    });
  });

  describe("booking outcome confirmation", () => {
    async function record(status: "won" | "lost" | "open", confirm?: true) {
      const requests: LucaRequest[] = [];

      const { client, close } = await connect((request) => {
        requests.push(request);

        return Effect.succeed({ episode: { status } });
      });

      onTestFinished(close);

      const body = {
        won: { status: "won", amountMinor: 100, currency: "USD" },
        lost: {
          status: "lost",
          lossReasonDefinitionId: "00000000-0000-0000-0000-000000000001",
        },
        open: {
          status: "open",
          nextFollowUpAt: "2026-10-07T12:00:00Z",
          followUpTimezone: "Europe/Madrid",
        },
      }[status];

      const result = await client.callTool({
        name: "luca_bookings_outcome_record",
        arguments: {
          id: "00000000-0000-0000-0000-000000000000",
          body,
          ...optionalField("confirm", confirm),
        },
      });

      return { result, requests };
    }

    it.each(["won", "lost"] as const)(
      "refuses a %s outcome without confirm before any API request",
      async (status) => {
        const { result, requests } = await record(status);
        expect(result.structuredContent).toEqual({
          error: {
            code: "confirmation_required",
            toolName: "luca_bookings_outcome_record",
            requiredArgument: "confirm",
          },
        });
        expect(requests).toHaveLength(0);
      }
    );

    it("allows a won outcome with confirm", async () => {
      const { result, requests } = await record("won", true);
      expect(result.isError).not.toBe(true);
      expect(requests).toHaveLength(1);
    });

    it("allows an open outcome without confirm", async () => {
      const { result, requests } = await record("open");
      expect(result.isError).not.toBe(true);
      expect(requests).toHaveLength(1);
    });
  });
});
