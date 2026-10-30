import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { toFils } from "@filspay/money";
import { requireMerchantAuth, requireMerchantRole, requireMerchantWriterActor } from "../auth/requireMerchantAuth.js";
import { assertRefundRequestScope, initiateMerchantRefund } from "../refunds/initiateMerchantRefund.js";
import { BadRequestError } from "../lib/errors.js";

interface RefundBody {
  transactionId?: unknown;
  amountFils?: unknown;
  reason?: unknown;
}

/**
 * FP-212. One handler behind both documented paths: `POST /v1/refunds` (the
 * merchant comes from the credential) and `POST /v1/merchants/:merchantId/
 * refunds` (path scope-checked against the credential, as the dashboard
 * calls it).
 *
 * The body is read field by field, never spread into the input, so a body
 * `merchantId` can't override the authenticated one. The Idempotency-Key is
 * the client's (required, as on capture), so a retried request replays
 * instead of refunding twice.
 */
async function handleRefund(app: FastifyInstance, request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const header = request.headers["idempotency-key"];
  const idempotencyKey = Array.isArray(header) ? header[0] : header;
  if (!idempotencyKey) {
    throw new BadRequestError("idempotency_key_required", "Idempotency-Key header is required");
  }

  const body = (request.body ?? {}) as RefundBody;
  if (typeof body.transactionId !== "string" || body.transactionId === "") {
    throw new BadRequestError("invalid_request", "transactionId is required");
  }
  if (body.amountFils !== undefined && (typeof body.amountFils !== "number" || !Number.isSafeInteger(body.amountFils))) {
    throw new BadRequestError("invalid_request", "amountFils must be an integer number of fils");
  }
  if (body.reason !== undefined && typeof body.reason !== "string") {
    throw new BadRequestError("invalid_request", "reason must be a string");
  }

  const auth = request.merchantAuth!;
  const result = await initiateMerchantRefund(app.db, app.acquirer, {
    merchantId: auth.merchantId,
    transactionId: body.transactionId,
    // validateRefundRequest rejects zero/negative amounts with a 422.
    amountFils: body.amountFils === undefined ? undefined : toFils(body.amountFils, { allowNegative: true }),
    idempotencyKey,
    actor: requireMerchantWriterActor(auth),
    reason: body.reason,
  });
  reply.code(result.statusCode).send(result.body);
}

/** Registered with prefix '/v1/refunds'. */
export async function refundRoutes(app: FastifyInstance): Promise<void> {
  app.post("/", { preHandler: [requireMerchantAuth, requireMerchantRole("owner", "finance")] }, (request, reply) =>
    handleRefund(app, request, reply),
  );
}

/** Registered with prefix '/v1/merchants'. */
export async function merchantRefundRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { merchantId: string } }>(
    "/:merchantId/refunds",
    { preHandler: [requireMerchantAuth, requireMerchantRole("owner", "finance")] },
    (request, reply) => {
      assertRefundRequestScope(request.merchantAuth!, request.params.merchantId);
      return handleRefund(app, request, reply);
    },
  );
}
