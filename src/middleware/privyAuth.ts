import { Request, Response, NextFunction } from "express";
import { createRemoteJWKSet, jwtVerify } from "jose";

const PRIVY_APP_ID = process.env.PRIVY_APP_ID ?? "";

// Privy's JWKS endpoint for verifying identity tokens
const PRIVY_JWKS = createRemoteJWKSet(
  new URL(
    "https://auth.privy.io/api/v1/apps/" +
      PRIVY_APP_ID +
      "/.well-known/jwks.json",
  ),
);

export interface PrivyClaims {
  sub: string; // Privy user DID: "did:privy:xxxx"
  iss: string;
  aud: string;
  iat: number;
  exp: number;
}

declare global {
  namespace Express {
    interface Request {
      privyUser?: PrivyClaims;
    }
  }
}

/** Verify a Privy identity token from the Authorization header */
export async function requirePrivyAuth(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing authorization header" });
    return;
  }

  const token = authHeader.slice(7);
  try {
    const { payload } = await jwtVerify(token, PRIVY_JWKS, {
      issuer: "privy.io",
      audience: PRIVY_APP_ID,
    });
    req.privyUser = payload as unknown as PrivyClaims;
    next();
  } catch (err) {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

/** Optional auth — attaches user if token present, does not block */
export async function optionalPrivyAuth(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) return next();
  const token = authHeader.slice(7);
  try {
    const { payload } = await jwtVerify(token, PRIVY_JWKS, {
      issuer: "privy.io",
      audience: PRIVY_APP_ID,
    });
    req.privyUser = payload as unknown as PrivyClaims;
  } catch {}
  next();
}
