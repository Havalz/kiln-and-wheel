---
name: refresh-rsg-tokens
description: Regenerate the Remote Service Gateway tokens (SNAP, OPENAI, GOOGLE) when they expire. Use when Gemini calls start failing, when the Glaze Bench keeps falling back to offline presets with "Network error", or roughly once an hour during a working session. Triggers - "refresh RSG tokens", "regenerate tokens", "tokens expired", "glaze keeps going offline".
---

# Refresh RSG Tokens

RSG tokens carry a **~1 hour TTL**. On expiry `GlazeBenchVoice` stops getting
real answers from Gemini and silently drops to its offline preset fallback.

**Symptom:** every spoken or typed glaze comes back as a local preset and the
Glaze Bench panel reads `Network error — used offline glaze: <name>`.

## Do this

Run the pre-written editor script with the `ExecuteEditorCode` MCP tool's
`path` argument — do not paste the snippet inline, and do not tell the user to
open the Window menu:

```
ExecuteEditorCode({ path: "<project root>/Tools/refresh-rsg-tokens.ts" })
```

The script regenerates all three providers, writes them onto the
`RemoteServiceGatewayCredentials` component, and saves the project.

## Reading the result

- `{ ok: true, refreshed: [...] }` — done. Report it in one line and stop.
- `warning: 'ancestor "X" is DISABLED'` — tokens were written but the
  credentials component will never run. Reparent `RemoteServiceGatewayCredentials`
  to the scene root (it ships inside the disabled `RemoteServiceGatewayExamples`
  tree) and re-run.
- `ok: false, error: "... HTTP 401"` — the user is signed out of Lens Studio.
  Ask them to sign in via the profile menu, then re-run.
- `ok: false, error: "component not found"` — the RSG package is not installed
  or its credentials object was deleted.

## Notes

- Always generates **all three** providers, never a subset — a partial set
  causes confusing silent failures later.
- The tokens use the user's existing Lens Studio sign-in. There is no API key
  and no OAuth prompt.
- `Tools/` sits outside `Assets/` deliberately: the script is editor-side, and
  Lens Studio's TypeScript compiler must not build it as part of the Lens.
