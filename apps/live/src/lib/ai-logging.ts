import type { ErrorRequestHandler, RequestHandler } from "express";

function isAiPath(path: string, basePath: string): boolean {
  const prefix = `${basePath.replace(/\/$/, "")}/ai`.toLowerCase();
  const normalized = path.toLowerCase();
  return normalized === prefix || normalized.startsWith(`${prefix}/`);
}

// Run before JSON parsing: malformed credential-bearing requests must never
// reach the normal logger. The controller still authenticates every request.
export function omitAiRequestLogs(logger: RequestHandler, basePath: string): RequestHandler {
  return (req, res, next) => {
    if (isAiPath(req.path, basePath)) {
      next();
      return;
    }
    logger(req, res, next);
  };
}

// Express's default parser error handler can include parts of the submitted JSON
// in its message. Handle AI parse failures without exposing those fragments.
export function sanitizeAiBodyErrors(basePath: string): ErrorRequestHandler {
  return (error: unknown, req, res, next) => {
    if (!isAiPath(req.path, basePath)) {
      next(error);
      return;
    }
    const tooLarge = typeof error === "object" && error !== null && "status" in error && error.status === 413;
    res.status(tooLarge ? 413 : 400).json({ error: "Invalid assistant request." });
  };
}
