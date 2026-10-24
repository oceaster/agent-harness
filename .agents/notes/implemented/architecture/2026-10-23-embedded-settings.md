# Agent Note: Embedded settings entry

Status: implemented

English | [中文](2026-10-23-embedded-settings.zh.md)

## Problem

The embedding e-server shell needs a global Settings action on every app, while the conversation frame currently owns the only trigger.

## Decision

SettingsRoot accepts open and close commands only from its actual parent at the exact referrer origin, provided the embedding page shares its hostname and protocol. A standalone app retains its trigger. An embedded app omits it; open and close still write the existing shell store.

The settings-only frame uses the same section, preferences and origin as the conversation frame. It suppresses onboarding and hides the surrounding app while keeping the settings panel visible. Ready and closed messages let the shell manage loading and restore focus. No account credential is carried in these messages.

## Consequences

The shell can open the same settings from any app without creating another preference store. Component tests cover source/origin checks, closing and automatic opening. e-server browser checks cover both the conversation frame and a settings frame opened from another app.

## Alternatives considered

Duplicating the settings form would create two preference implementations. Clicking the existing trigger through DOM inspection would depend on presentation details and fail across origins. A bounded parent message contract keeps the existing actions as the mutation API.
