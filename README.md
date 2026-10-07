# Always Spoiler Media for Revenge Classic

Version **1.0.1** conceals incoming images, videos, GIF/link previews, and stickers in chat messages.

- Images and uploaded GIF images use Discord's normal spoiler overlay.
- Uploaded videos, linked GIFs, link previews, and stickers have a one-tap **Show media** button. The message's long-press menu also offers **Show media** and **Hide media**.
- Audio files, voice messages, emojis, documents, and bot components stay visible.
- Reply previews conceal quoted media without adding inactive reveal links. Reveal the quoted media on its original message. Forwarded messages and media attached to replies retain their reveal controls.
- Changes are local to your device, and disabling the plugin restores saved media.

## Install

Add this URL in Revenge Classic's plugin installer, then restart Discord:

```text
https://raw.githubusercontent.com/vikandreas6/spoiler-everything/gh-pages/always-spoiler-images/
```

The plugin's settings screen shows version **1.0.1**. To refresh an existing installation, remove it and reinstall with the same URL.

## Build

Run `pnpm install` and `pnpm run build`. GitHub Actions publishes the built plugin to `gh-pages` when `main` is updated. The root ZIP contains the version 1.0.1 source and built plugin.

The plugin applies to media in chat messages. Avatars, reactions, profiles, voice calls, and screen shares are outside its scope. Discord's internal modules can change; behavior still needs checking on your installed Android build.
