// Agy ACP can surface vendor errors as assistant text with stopReason=end_turn.
// Recognize only short, complete, characteristic terminal errors.
// Do not change ordinary model responses that discuss quotas or limits.
const HEADS = [
  "claude ", "quota", "usage limit", "rate limit", "you have ", "you've ",
  "your ", "error:", "http 429", "429 ", "resource_exhausted",
  "quota_exhausted", "model_capacity_exhausted", "the model ",
  "this model ", "the resource ", "not_found", "⚠", "individual quota",
  "weekly quota", "model quota", "daily quota", "subscription quota",
  "third-party quota", "permission_denied", "this service has been disabled",
  "verification required", "our servers are experiencing",
];

// agy's endings for an account Google turned away, and for a model with no
// capacity (agy 1.5.9 and 1.5.10 wordings; the same lines the official
// @magpie-community/opencode-agy-cli-auth reads, MIT). Answered as text they
// were a 200 whose whole reply was the notice, so the gateway kept sending
// to a banned or unverified account.
const DISABLED = /^(?:⚠\s*)?(?:PERMISSION_DENIED \(code 403\):\s*)?This service has been disabled in this account for violation of Terms of Service\b/i;
const VERIFY = /^(?:⚠\s*)?Verification Required\.?$/i;
const BUSY = /^(?:⚠\s*)?Our servers are experiencing high traffic right now\b/i;
export const ACCOUNT_DISABLED_MESSAGE = "Google has disabled this account's access to Antigravity " +
  "for violating the Terms of Service (HTTP 403: \"This service has been disabled in this account " +
  "for violation of Terms of Service\"). Submit an appeal with Google before using this account again.";
// "this Google account needs to be verified" is what Magpie reads as an
// account that needs verification.
export function verifyMessage(link = "") {
  const said = "Google wants this account verified before Antigravity serves it again (agy: \"Verification Required\")";
  return link
    ? `${said} — this Google account needs to be verified: open ${link} in a browser signed in to it, verify it, then try again`
    : `${said} — this Google account needs to be verified: open the Antigravity app, or run \`agy\` in a terminal, signed in to it and do what it asks, then try again`;
}
// The https link agy's log gives to verify the account at, "" when none.
export function verifyLinkIn(text) {
  const said = String(text ?? "");
  const link = /"validation_(?:link|url)"\s*:\s*"(https:\/\/[^"\\]+)"/i.exec(said)?.[1] ||
    /in your browser to continue:\s*(https:\/\/\S+)/i.exec(said)?.[1] ||
    /(https:\/\/accounts\.google\.com\/[^\s"'\\<>]+)/i.exec(said)?.[1] || "";
  const trimmed = link.replace(/[).,;\]}]+$/, "");
  try {
    const url = new URL(trimmed);
    return url.protocol === "https:" && url.host ? trimmed : "";
  } catch {
    return "";
  }
}
export function couldBeUpstreamFailure(text) {
  if (typeof text !== "string" || text.length > 1536) return false;
  const t = text.trimStart().toLowerCase();
  if (!t) return true;
  return HEADS.some((head) => head.startsWith(t) || t.startsWith(head));
}
export function classifyUpstreamFailure(text) {
  if (typeof text !== "string" || text.length > 1536) return null;
  const t = text.trim();
  if (!t) return null;
  // Not retried: another try of this request on this account can't pass.
  if (DISABLED.test(t) && !t.includes("\n")) {
    return { kind: "permission_error", status: 403, noRetry: true, message: ACCOUNT_DISABLED_MESSAGE };
  }
  if (VERIFY.test(t)) {
    return { kind: "permission_error", status: 403, noRetry: true, verify: true, message: verifyMessage() };
  }
  // The model's capacity, not the account's: tried again, or elsewhere.
  if (BUSY.test(t) && !t.includes("\n")) {
    return { kind: "overloaded_error", status: 503, message: `Antigravity has no capacity for this model now: ${t.replace(/^⚠\s*/, "")}` };
  }
  if (/^Claude (?:Sonnet|Opus) [\d.]+ is no longer available\. Please switch to Claude (?:Sonnet|Opus) [\d.]+\.?$/i.test(t)) {
    return { kind: "api_error", status: 503, message: t };
  }
  // Observed on de-agy with a depleted Claude 5h pool. Agy ACP emitted
  // this warning as ordinary assistant text and returned stopReason=end_turn.
  if (/^(?:⚠\s*)?(?:Individual|Third-party|Model|Weekly|Daily|Subscription) quota (?:reached|exhausted|exceeded)\b/i.test(t)) {
    return { kind: "rate_limit_error", status: 429, message: t };
  }
  if (/^(?:Error:\s*)?(?:RESOURCE_EXHAUSTED|QUOTA_EXHAUSTED|MODEL_CAPACITY_EXHAUSTED)(?:\b|:)/i.test(t) ||
      /^(?:Error:\s*)?(?:HTTP\s*)?429\b/i.test(t)) {
    return { kind: "rate_limit_error", status: 429, message: t };
  }
  const quotaNoun = /\b(?:quota|usage limit|rate limit|rate-limit|requests? limit|capacity|too many requests)\b/i;
  const limitVerb = /\b(?:reached|hit|exhausted|exceeded|used up|out of|reset|try again after|temporarily unavailable)\b/i;
  // A short notice whose first sentence says the limit was reached; a reply
  // that only mentions a quota somewhere ("Your code ... the quota check is
  // reached once") is not one.
  const first = t.split(/[.!?\n]/, 1)[0];
  if (t.length <= 300 &&
      /^(?:You(?: have|'ve) |Your |This model |The model |The resource |Quota |Usage limit |Rate limit |Error: )/i.test(t) &&
      quotaNoun.test(first) && limitVerb.test(first)) {
    return { kind: "rate_limit_error", status: 429, message: t };
  }
  return null;
}
