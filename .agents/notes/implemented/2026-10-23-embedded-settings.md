# Embedded settings entry

The embedding e-server shell owns the global Settings entry. SettingsRoot accepts an open command only from its actual parent at the exact referrer origin, provided the embedding page shares its hostname and protocol. The standalone app retains its trigger. An embedded app omits it; open and close still write the existing shell store.

The settings-only frame uses the same section, preferences and origin as the conversation frame. It suppresses onboarding and hides the surrounding app while keeping the settings panel visible. Ready and closed messages let the shell manage its loading state and return focus. No account credential is carried in these messages.

Validation: settings-root component tests cover parent/source/origin checks, close notification and automatic opening. e-server's composed browser checks cover both the conversation frame and the global settings frame from another app.
