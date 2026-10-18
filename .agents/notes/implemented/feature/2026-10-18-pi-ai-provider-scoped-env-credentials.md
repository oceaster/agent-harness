# Agent Note: Provider-scoped env credentials for pi-ai routes

Status: implemented

English | [中文](2026-10-18-pi-ai-provider-scoped-env-credentials.zh.md)

## Problem

The pi-ai adapter could hand one route exactly one secret: `apiKeyEnv` resolved a reference into pi-ai's `apiKey` stream option, which pi-ai treats as a bearer token. Amazon Bedrock signs with SigV4 over an access key ID, a secret access key, and a region, so a Bedrock route could not authenticate from the harness credential store at all. Its only options were exporting ambient AWS variables to the whole process — authenticating every route on that host as the same identity — or leaving the route unusable.

## Decision

`PiAiProviderProfile` gains `env`, plain provider-scoped values such as `AWS_REGION`, and `envCredentials`, credential *references* keyed by the environment-variable name they fill. `resolveProfiles` validates both dicts and copies what survives, detached: a key must be a POSIX environment-variable name, a plain value must be non-empty, a reference must be a valid credential reference, and one name declared by both dicts is refused rather than resolved twice. Every failure names the route and the key, so the settings write that produced it is refused instead of stored.

A resolved profile keeps references only. Each request resolves every `envCredentials` entry through the same seam `apiKeyEnv` uses — `ctx.credentials`, else `launchEnvironmentOf(ctx)` — and fails with `LlmError('MISSING_CREDENTIAL')` naming the route, the name, and the reference. Neither an absent nor a blank resolution is ever handed over: pi-ai's `getProviderEnvValue` falls back to `process.env` for both, so a route that named a reference would silently sign as whatever ambient AWS identity the host holds.

`adapter.ts` merges `profile.env` first and the resolved credentials over it into the single `env` option that `profileOptions()` builds beside apiKey, reasoning, and timeout, and sends no `env` at all for a route declaring neither field. pi-ai's `Models` overlays its auth context with that option, which is where the Bedrock provider's own resolution reads the AWS variables and its module performs the signing.

Env values get no trimming and no header-safety check, unlike an API key in `assertUsableApiKey`: a provider SDK reads them rather than an HTTP header, and an AWS secret access key legitimately contains `+`, `/`, and `=`.

`ProviderSpec.namesCredential` stays keyed to `apiKeyEnv` alone. An env-authenticated catalog route therefore keeps the installed provider's own auth method instead of gaining the harness's bearer-token method, which a SigV4 protocol never wants.

## Alternatives considered

**One `env` dict whose values may be references** (a `${REF}` marker, or resolving anything that looks like a variable name): resolution would have to guess whether a string is a literal or a reference, and a literal colliding with the syntax would silently be treated as the other.

**Passing the credential set through `apiKey`**: pi-ai's Bedrock auth reads a `key` as a Bedrock bearer token, a genuinely different credential, so a SigV4 route would authenticate as an invalid token instead of a signed identity.

**Extending `supportedProtocols()` with `bedrock-converse-stream`**: SigV4 signing lives in pi-ai's Bedrock provider module, which loads its Smithy stack through a separate entry point this package cannot reconstruct, so the protocol table stays narrow and only catalog Bedrock routes benefit.

**Resolving references into the profile at construction**: the resolved profile is returned to configuration surfaces and RPC callers, so values would land in a settings-visible payload and rotation would need a reload.

## Consequences

Rotation is free: a changed credential reaches the next request with no restart, and a route's plain values and references hold provider configuration that no single API key could express.

No secret value reaches a log, an error message, a settings document, or a resolved profile — only the reference, which is what the failure messages name.

A route declaring neither field sends exactly the options it sent before these fields existed, so deepseek and `apiKeyEnv`-only routes are untouched.

Deferred: configuration surfaces have no env editor — the Models page does not yet render either dict — and nothing validates a name against a provider's known variable set, matches the SigV4 pair for completeness, or offers the provider-scoped env to endpoint interrogation.

`tests/env-credentials.spec.ts` pins the schema refusals, both resolution seams, the merged option observed on a recording pi-ai provider, per-request re-resolution of a rotated value, the refusal to sign with an ambient credential, and the absence of a secret in the resolved profile and in failure messages. A live Bedrock request was not made: it needs real AWS credentials, and the assembled evidence stops at the options pi-ai receives.
