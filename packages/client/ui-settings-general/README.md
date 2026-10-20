# @deepseek-ai/dsh-client-ui-settings-general

English | [中文](README.zh.md)

Settings shell, ownerless copy, and durable product-onboarding namespace. It occupies `sidebar.settings` with the trigger chrome and the modal settings panel, renders the one registered `settings.section` directly — there is no nav rail and no section switching — projects the `settings.onboarding` ledger into one mounted step at a time, and registers everything on the Settings pages that belongs to no single feature — the trigger/header/close chrome content, the General section and its `settings.general.item` slot, and the `settings` dictionaries. The slot types it renders into belong to ui-settings, the settings domain base; only the shell's own contract types live here, because they reference ui-sidebar's slot type and the base layer must depend on no `ui-*` package. Feature-owned rows (Permission, Language, Appearance), sections (Models), and conditional onboarding steps stay with their feature packages.

The shell ships no onboarding copy of its own — all text arrives from registrants. Section entries are ordered by their `order` option and the panel renders the first one; a registrant may still pass a `label`, but nothing renders it, because a one-section panel has no navigation to caption. The onboarding ledger projects in ascending order and mounts exactly one step at a time. Visible steps own their dialog chrome and app-root `inert` lifecycle; a mounted step still resolving private facts renders null, so nothing paints or blocks while it decides. The active registrant receives its id, `complete()`, and an `openSettings()` callback; completing or skipping transfers ownership to the next entry. Registrants own durable completion, capability readiness, copy, mutations, and their visible wrapper, so independently registered flows cannot stack and the shell does not become a second configuration fact source.

The Host half registers `ui-onboarding` in the user-settings seam. The welcome step contributed by `ui-settings-models` reads and writes its `welcomeNoticeVersion` through the existing public settings boundary; the shell itself remains policy-free.

## Model Experience

None, as the plugin renders browser settings UI; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- The General section has no built-in rows; each row appears only when its owning feature plugin is mounted.
- Exactly one settings section is reachable. A second `settings.section` registration renders nowhere rather than appearing as a tab; adding one means restoring a navigation, not registering another entry.
