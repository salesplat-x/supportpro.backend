import { Request, Response, NextFunction } from "express";
import env from "../../config/env";

const WHITELISTED_IPS = (env.whitelisted_ips || "").split(",").map((ip) => ip.trim());

export function verifyWebhookIP(req: Request, res: Response, next: NextFunction) {
  // Get the real IP address

  const forwardedFor = req.headers["x-forwarded-for"];
  const ip =
    (typeof forwardedFor === "string" ? forwardedFor.split(",")[0]?.trim() : undefined) ||
    req.socket.remoteAddress;

  if (!ip || !WHITELISTED_IPS.includes(ip)) {
    console.warn(`Unauthorized webhook attempt from IP: ${ip}`);
    return res.status(403).json({ message: "Forbidden: Invalid IP address" });
  }

  next(); // Proceed to webhook handler
}
