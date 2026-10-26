// Every /api/* route of the wizard (see src/server/api.ts).
import type { Config } from "@netlify/functions";
import { handle } from "../../src/server/api.js";

export default (req: Request) => handle(req);

export const config: Config = { path: "/api/*" };
