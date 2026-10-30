import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";

/**
 * Turns away excess load instead of queueing it. On 0.5 vCPU with a 5-
 * connection pool, every request beyond what the API can finish only adds
 * latency for everyone, then memory, then an OOM kill. Past
 * `maxInFlightRequests` concurrent requests, new ones get 503 with
 * Retry-After before any work is done, so the requests already admitted
 * stay fast and correct. Health checks are never shed, or the container
 * would be restarted for being busy.
 */
export const loadSheddingPlugin = fp(
  async (app: FastifyInstance, opts: { maxInFlightRequests: number }): Promise<void> => {
    const limit = opts.maxInFlightRequests;
    if (limit <= 0) return;
    let inFlight = 0;

    app.addHook("onRequest", async (request, reply) => {
      if (request.url === "/healthz" || request.url === "/readyz") return;
      if (inFlight >= limit) {
        reply.code(503).header("retry-after", "1").send({ error: "overloaded" });
        return reply;
      }
      inFlight += 1;
      // 'close' fires once whether the response finished or the client went
      // away, so an aborted request can't leak a slot.
      reply.raw.once("close", () => {
        inFlight -= 1;
      });
    });
  },
);
