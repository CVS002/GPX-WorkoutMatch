// Maintenance jobs (cache rebuilds, ride-history refresh), up to 15 min per
// invocation; long jobs save progress and re-invoke this function to continue.
import type { Config } from "@netlify/functions";
import { invoker } from "../../src/server/api.js";
import { run } from "../../src/server/jobs.js";

export default async (req: Request) => {
  let body: { jid: string; nonce: string; fwd: Record<string, string> };
  try {
    body = await req.json();
  } catch {
    return;
  }
  if (!body || typeof body.jid !== "string" || typeof body.nonce !== "string") return;
  await run({ jid: body.jid, nonce: body.nonce, fwd: body.fwd || {} }, invoker(new URL(req.url).origin));
};

export const config: Config = { background: true };
