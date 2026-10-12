# Agent Note: Deployment personality defaults and worker policy

Status: implemented

English | [中文](2026-10-11-deployment-personality-policy.zh.md)

## Problem

A deployment can select a personality preset while the web session still uses the global model default. Child delegation can also inherit stale creation-time options after a model switch. Hiding spawn tools alone does not forbid service callers from creating further children.

## Decision

A scoped `agent/default-model` contribution supplies the blank session default. Explicit picker selections and logged request headers retain precedence. Prompt assembly copies the selected provider, model and reasoning effort into agent options; child composition inherits those options. `AgentOptions.reasoningEffort` supplies a first-request effort to the loop. The scoped `subagent/authorize` bail event runs before one-shot and continuable delegation allocate resources. A reason produces `DELEGATION_DENIED`. CLI startup preserves configured preset roots.

The Easter deployment owns personality prose, role assignment, ticket tools and persistent ticket storage in its e-server plugin. The harness owns only the model-default and delegation enforcement extension points.

## Alternatives considered

Per-request personality routing would override the model picker and make the displayed selection misleading. Prompt-only delegation restrictions would allow direct service calls. Embedding all ticket and personality behavior in the loop would couple a deployment policy to the upstream execution driver.

## Consequences

Model changes remain independent of personality. In-process workers inherit the actual assembled selection. Default contributions remain optional, and deployments without an authorization listener preserve ordinary delegation. Policy denial is enforced before both provider invocation and continuable reservations.

Focused package tests exercise default resolution, inheritance and both denied delegation paths. The assembled deployment smoke boots the real built web profile with an isolated home and scripted LLM, switches a blank personality, and delegates a ticket through worker submission and coordinator acceptance. Real provider responses and GPU inference require separate live verification.
