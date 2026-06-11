import { Request, Response, NextFunction } from 'express';
import env from "../../config/env";

const WHITELISTED_IPS = (env.whitelisted_ips || "").split(",").map(ip=> ip.trim())

export function verifyWebhookIP(req: Request, res: Response, next: NextFunction) {
    // Get the real IP address

    // @ts-expect-error - x-forwarded-for header type is not narrowed
    const ip = req.headers['x-forwarded-for']?.toString().split(',')[0].trim() || req.socket.remoteAddress;

    if (!ip || !WHITELISTED_IPS.includes(ip)) {
        console.warn(`Unauthorized webhook attempt from IP: ${ip}`);
        return res.status(403).json({ message: 'Forbidden: Invalid IP address' });
    }

    next(); // Proceed to webhook handler
}