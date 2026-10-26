const tag = (name) => `[redacted:${name}]`;
const RULES = [
    {
        name: "private-key",
        re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
        replace: () => tag("private-key"),
    },
    { name: "anthropic", re: /sk-ant-[A-Za-z0-9_-]{20,}/g, replace: () => tag("anthropic") },
    { name: "openai", re: /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, replace: () => tag("openai") },
    { name: "github", re: /(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/g, replace: () => tag("github") },
    { name: "slack", re: /xox[abprs]-[A-Za-z0-9-]{10,}/g, replace: () => tag("slack") },
    { name: "aws", re: /\bAKIA[0-9A-Z]{16}\b/g, replace: () => tag("aws") },
    {
        name: "bearer",
        re: /\bBearer\s+[A-Za-z0-9\-._~+/]{16,}=*/g,
        replace: () => `Bearer ${tag("bearer")}`,
    },
    {
        name: "password",
        re: /\b([a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)([^@\s]+)(@)/gi,
        replace: (_m, pre, _pw, at) => `${pre}${tag("password")}${at}`,
    },
    {
        name: "secret",
        re: /\b([A-Za-z0-9_]*(?:api[_-]?key|secret|passwd|password|access[_-]?token|auth[_-]?token)[A-Za-z0-9_]*)(\s*[:=]\s*)["']?([^\s"'\[]{8,})["']?/gi,
        replace: (_m, key, sep) => `${key}${sep}${tag("secret")}`,
    },
];
/** Replace likely secrets with `[redacted:<kind>]` before anything reaches disk. */
export function scrub(text, extra = []) {
    let out = text;
    for (const rule of RULES)
        out = out.replace(rule.re, rule.replace);
    for (const p of extra)
        out = out.replace(new RegExp(p.pattern, "g"), tag(p.name));
    return out;
}
