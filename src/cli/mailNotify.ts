/**
 * Mail a command sends for its caller, and the notice that goes with it: `msg send`, and
 * what `track pr` and `review post` send by themselves (the owners notice, the review
 * handshake). Composition only: the decisions are in the adapters they call.
 */
import * as Effect from "effect/Effect";
import { harnesses } from "../adapters/harnesses/index.ts";
import { mailSend } from "../adapters/mail.ts";
import { notifyRecipient } from "../adapters/notices.ts";
import type { TrackPrNotify } from "../adapters/trackPr.ts";
import { reviewerTrackOf } from "../core/layout.ts";
import { formatSent } from "../core/mail.ts";
import { formatDelivery } from "../core/notices.ts";
import { caller } from "./session.ts";

/** Four hex digits for a message id: unique within a second among a handful of senders. */
export const randomHex = (): string =>
  [...crypto.getRandomValues(new Uint8Array(2))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

/**
 * Mail sent by a command for its caller (track pr, review post): stored, then a live notice
 * to each session at the address. A track's reviewer address takes it before any reviewer
 * registers there, so it waits for one.
 */
export const mailAndNotify =
  (root: string): TrackPrNotify =>
  (to, subject, text) =>
    Effect.gen(function* () {
      const message = yield* mailSend(root, to, subject, text, new Date(), randomHex, caller(), {
        toReviewer: reviewerTrackOf(to) !== undefined,
      });
      const delivery = yield* notifyRecipient(
        root,
        message,
        harnesses(process.env),
        new Date(),
      ).pipe(
        Effect.catchTags({
          TrackError: (error) =>
            Effect.succeed({ notified: 0, pruned: [], skipped: [error.reason] }),
          WorkspaceError: (error) =>
            Effect.succeed({ notified: 0, pruned: [], skipped: [error.message] }),
        }),
      );
      return `${formatSent(message)}\n${formatDelivery(to, delivery)}`;
    });
