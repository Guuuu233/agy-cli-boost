// Agy ACP can surface vendor errors as assistant text with stopReason=end_turn.
// Recognize only short, complete, characteristic terminal errors.
// Do not change ordinary model responses that discuss quotas or limits.
const HEADS = [
  "claude ", "quota", "usage limit", "rate limit", "you have ", "you've ",
  "your ", "error:", "http 429", "429 ", "resource_exhausted",
  "quota_exhausted", "model_capacity_exhausted", "the model ",
  "this model ", "the resource ", "not_found", "⚠", "individual quota",
  "weekly quota", "model quota", "daily quota", "subscription quota",
];
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
  if (/^Claude (?:Sonnet|Opus) [\d.]+ is no longer available\. Please switch to Claude (?:Sonnet|Opus) [\d.]+\.?$/i.test(t)) {
    return { kind: "api_error", status: 503, message: t };
  }
  // Observed on de-agy with a depleted Claude 5h pool. Agy ACP emitted
  // this warning as ordinary assistant text and returned stopReason=end_turn.
  if (/^(?:⚠\s*)?(?:Individual|Model|Weekly|Daily|Subscription) quota (?:reached|exhausted|exceeded)\b/i.test(t)) {
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
