import { isIP } from "node:net";
import type { Request } from "express";

/**
 * The API sits behind Cloudflare and a host proxy, and `trust proxy` is unset,
 * so req.ip is the proxy's address for every caller. Cloudflare sets
 * CF-Connecting-IP to the real client on every request it forwards; anything
 * without a valid one (direct origin traffic) falls back to req.ip.
 */
export const getClientIp = (req: Request): string => {
  const cfConnectingIp = req.headers["cf-connecting-ip"];
  return typeof cfConnectingIp === "string" && isIP(cfConnectingIp.trim()) !== 0
    ? cfConnectingIp.trim()
    : (req.ip ?? req.socket?.remoteAddress ?? "");
};
