#!/bin/sh
# WHEEL - block RSG credentials from ever entering a commit.
#
# RemoteServiceGatewayCredentials stores snapToken / openAIToken / googleToken
# as PLAINTEXT inside Assets/Scene.scene, which is a tracked file. The tokens
# are minted from the developer's Snap login and, until they expire (~1h), let
# anyone call Gemini / OpenAI / Snap3D on that quota. They are also worthless to
# commit: nobody cloning the repo will ever see one before it expires.
#
# The Lens degrades gracefully with the placeholders in place - the glaze bench
# falls back to the six local presets and naming falls back to localName() - so
# blanking them costs a reviewer nothing.
#
# Regenerate at demo time:  ExecuteEditorCode -> Tools/refresh-rsg-tokens.ts
#
# Install (hooks are NOT cloned, so this must be run on each machine):
#   ln -sf ../../Tools/pre-commit-token-guard.sh .git/hooks/pre-commit

# Only look at what is actually staged, and only at added/modified content.
hits=$(git diff --cached -U0 --diff-filter=AM |
       grep -E '^\+.*(snapToken|openAIToken|googleToken): *"?[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-')

if [ -n "$hits" ]; then
  echo "COMMIT BLOCKED: a live RSG token is staged." >&2
  echo >&2
  echo "$hits" | sed 's/^/  /' >&2
  echo >&2
  echo "Blank them back to the placeholders before committing:" >&2
  echo '  snapToken: "[INSERT SNAP TOKEN]"' >&2
  echo '  openAIToken: "[INSERT OPEN AI TOKEN]"' >&2
  echo '  googleToken: "[INSERT GOOGLE TOKEN]"' >&2
  echo >&2
  echo "Lens Studio holds the scene in memory, so edit them through the" >&2
  echo "Editor API (or the Inspector) and save - editing the file alone" >&2
  echo "gets overwritten on the next project save." >&2
  echo >&2
  echo "Override only if you are certain:  git commit --no-verify" >&2
  exit 1
fi
exit 0
