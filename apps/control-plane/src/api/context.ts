// tRPC context + auth middleware stub (seam 1, docs/10 §2, checklist §5.7).
// Reads the CF Access identity header -> forge.user.id; rejects if absent.
// Real CF Access wiring is §8; the stub returns a dev user in the fast profile.

import { initTRPC } from "@trpc/server";
import type { Env } from "../env";
import { resolveProfile } from "../env";
import { ForgeError, type ForgeErrorCategory } from "@forge/domain";
import { newCorrelationId } from "../otel/console";

/** CF Access identity header (set by Access, docs/10 §2). */
const CF_ACCESS_HEADER = "cf-access-jwt-assertion";
/** The dev user id the fast-profile stub returns (no real CF Access locally). */
const DEV_USER_ID = "user_dev_fast";

export interface Context {
  env: Env;
  /** The authenticated user id (forge.user.id). */
  userId: string;
  correlationId: string;
}

/** Build the tRPC context from a request: extract the user identity. */
export async function createContext(opts: { req: Request; env: Env }): Promise<Context> {
  const profile = resolveProfile(opts.env);
  const correlationId = newCorrelationId();

  // In fast: no real CF Access; return a dev user. In real/staging/prod: read
  // the CF Access JWT assertion header and extract the user id (sub). §8 wires
  // the real JWT verification (CF Access public keys).
  let userId: string;
  if (profile === "fast") {
    userId = DEV_USER_ID;
  } else {
    const jwt = opts.req.headers.get(CF_ACCESS_HEADER);
    if (!jwt) {
      throw new ForgeError({
        category: "auth",
        code: "UNAUTHENTICATED",
        message: "missing CF Access identity",
        correlationId,
      });
    }
    // §8: verify the JWT against CF Access public keys and extract `sub`.
    // For now (pre-§8), decode the payload to get the email/sub as a stand-in.
    userId = decodeCfAccessSub(jwt) ?? DEV_USER_ID;
  }

  return { env: opts.env, userId, correlationId };
}

/** Decode a CF Access JWT payload (no verification — §8 adds real verification). */
function decodeCfAccessSub(jwt: string): string | null {
  try {
    const parts = jwt.split(".");
    if (parts.length < 2) return null;
    const payload = JSON.parse(atob(parts[1] ?? "")) as { sub?: string; email?: string };
    return payload.sub ?? payload.email ?? null;
  } catch {
    return null;
  }
}

const t = initTRPC.context<Context>().create({
  errorFormatter({ shape, error }) {
    // Map ForgeError → tRPC code + data.{category,retryable,correlationId,code} (15 §4).
    const cause = error.cause as {
      category?: ForgeErrorCategory;
      correlationId?: string;
      code?: string;
      retryable?: boolean;
    };
    return {
      ...shape,
      data: {
        ...shape.data,
        category: cause?.category,
        retryable: cause?.retryable,
        correlationId: cause?.correlationId,
        code: cause?.code,
      },
    };
  },
});

/** Authed procedure — requires a context user (the middleware enforces presence). */
export const authedProcedure = t.procedure.use((opts) => {
  if (!opts.ctx.userId) {
    throw new ForgeError({
      category: "auth",
      code: "UNAUTHENTICATED",
      message: "authentication required",
      correlationId: opts.ctx.correlationId,
    });
  }
  return opts.next(opts);
});

export const router = t.router;
export const publicProcedure = t.procedure;
export { t };
