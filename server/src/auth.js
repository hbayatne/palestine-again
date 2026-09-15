// auth.js — email/password auth with JWT bearer tokens.
import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { config } from "./config.js";
import { one, query } from "./db.js";
import { entitlementsFor } from "./entitlements.js";

export const authRouter = express.Router();

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const TOKEN_TTL = "30d";

function issueToken(user) {
  return jwt.sign({ sub: String(user.id), email: user.email }, config.jwtSecret, { expiresIn: TOKEN_TTL });
}

function publicUser(u) {
  return { id: u.id, email: u.email, tier: u.tier, entitlements: entitlementsFor(u.tier) };
}

authRouter.post("/signup", async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: "invalid_email" });
  if (password.length < 8) return res.status(400).json({ error: "weak_password", message: "Password must be at least 8 characters." });

  const existing = await one("SELECT id FROM users WHERE email = $1", [email]);
  if (existing) return res.status(409).json({ error: "email_taken" });

  const hash = await bcrypt.hash(password, 12);
  const user = await one(
    "INSERT INTO users (email, password_hash, tier) VALUES ($1, $2, 'free') RETURNING *",
    [email, hash]
  );
  return res.status(201).json({ token: issueToken(user), user: publicUser(user) });
});

authRouter.post("/login", async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  const user = await one("SELECT * FROM users WHERE email = $1", [email]);
  // Constant-ish response regardless of which factor failed (avoid user enumeration).
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: "invalid_credentials" });
  }
  return res.json({ token: issueToken(user), user: publicUser(user) });
});

// Bearer-token middleware. Attaches req.user (fresh from DB, so tier is current).
export async function authRequired(req, res, next) {
  const hdr = req.headers.authorization || "";
  const token = hdr.startsWith("Bearer ") ? hdr.slice(7) : null;
  if (!token) return res.status(401).json({ error: "no_token" });
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    const user = await one("SELECT * FROM users WHERE id = $1", [payload.sub]);
    if (!user) return res.status(401).json({ error: "user_not_found" });
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: "invalid_token" });
  }
}

authRouter.get("/me", authRequired, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

export { publicUser };
