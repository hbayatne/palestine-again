// auth.js — lightweight, browser-only account + subscription state.
//
// IMPORTANT (honesty): this is a front-end DEMO of sign-up and tiers. Accounts
// live in the browser's localStorage and the "password" is only lightly hashed.
// It is NOT secure and CANNOT enforce real payments — anyone can read the page
// source. For real monetization, wire these same calls to a backend (auth API +
// Stripe). The function surface here is deliberately backend-shaped so that swap
// is straightforward: signup / login / logout / getState / setTier.

const STORE_KEY = "signaldesk_users_v1";
const SESSION_KEY = "signaldesk_session_v1";
const VIEWAS_KEY = "signaldesk_viewas_v1";

// The owner gets everything free. Change/add emails here (or move to a backend).
export const OWNER_EMAILS = ["hbayatne@icloud.com"];

function readUsers() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY)) || {};
  } catch {
    return {};
  }
}
function writeUsers(u) {
  localStorage.setItem(STORE_KEY, JSON.stringify(u));
}

// Deliberately weak hash — this is a demo, not real security.
function hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

export function isOwnerEmail(email) {
  return OWNER_EMAILS.includes((email || "").trim().toLowerCase());
}

function normalize(email) {
  return (email || "").trim().toLowerCase();
}

export function signup(email, password) {
  email = normalize(email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { error: "Enter a valid email." };
  if (!password || password.length < 4) return { error: "Password must be at least 4 characters." };
  const users = readUsers();
  if (users[email]) return { error: "An account with this email already exists. Try logging in." };
  const tier = isOwnerEmail(email) ? "pro" : "free";
  users[email] = { email, pass: hash(password), tier, owner: isOwnerEmail(email), created: Date.now() };
  writeUsers(users);
  localStorage.setItem(SESSION_KEY, email);
  return { user: users[email] };
}

export function login(email, password) {
  email = normalize(email);
  const users = readUsers();
  const u = users[email];
  if (!u) return { error: "No account found. Please sign up first." };
  if (u.pass !== hash(password)) return { error: "Incorrect password." };
  // keep owner flag fresh even if owner list changed
  u.owner = isOwnerEmail(email);
  if (u.owner) u.tier = "pro";
  users[email] = u;
  writeUsers(users);
  localStorage.setItem(SESSION_KEY, email);
  return { user: u };
}

export function logout() {
  localStorage.removeItem(SESSION_KEY);
  localStorage.removeItem(VIEWAS_KEY);
}

export function getUser() {
  const email = localStorage.getItem(SESSION_KEY);
  if (!email) return null;
  const u = readUsers()[email];
  return u || null;
}

// Set the account's real tier (demo "subscribe"/"upgrade"). In production this
// would be driven by a payment webhook, not the client.
export function setTier(tierId) {
  const email = localStorage.getItem(SESSION_KEY);
  if (!email) return null;
  const users = readUsers();
  if (!users[email]) return null;
  users[email].tier = tierId;
  writeUsers(users);
  return users[email];
}

// Owner-only "preview as tier" — lets the owner see exactly what each plan shows
// without changing their real (Pro) account. Non-owners ignore this.
export function setViewAs(tierId) {
  if (tierId) localStorage.setItem(VIEWAS_KEY, tierId);
  else localStorage.removeItem(VIEWAS_KEY);
}
export function getViewAs() {
  return localStorage.getItem(VIEWAS_KEY) || null;
}

// The tier whose features should actually be applied right now.
export function effectiveTierId() {
  const u = getUser();
  if (!u) return "free";
  if (u.owner) return getViewAs() || "pro";
  return u.tier || "free";
}
