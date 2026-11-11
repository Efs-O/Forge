---
name: video-clip
description: Help plan a short local video clip, then render it with generate_video.
requires_tools: generate_video
---

# Video clip

Help the user turn a scene or still image into a short clip with Forge's local
`generate_video` tool.

1. Ask what should move and what the camera should do. If the user has not
   supplied a still, ask whether they want to attach one or want Forge to make a
   still first. A Telegram attachment path is already in the request; use it as
   `image_path`.
2. Use the default LTX-2.5 engine unless the user asks for MiniMax H3 by name.
   Do not choose H3 based on engine ordering. If the requested engine is not
   configured, report the tool's setup message instead of silently switching.
3. Unless the user chooses otherwise, use 5 seconds, 1344×768 (768p) and 24 fps.
   Ask before changing these defaults when the request does not make the choice
   clear. For LTX-2.5, both dimensions must be multiples of 64.
4. Call `generate_video` with a concise prompt describing visible motion and
   camera behavior. Use the still's workspace path as `image_path` when one was
   supplied. Without a still, the configured image backend makes one first.
5. The render runs in the background and may unload the chat model from its
   GPU. When the run finishes, inspect the clip with `view_video` and describe
   what is visible. A successful manifest and silence check do not establish
   visual quality.

Use the tools directly. Do not run adapters or model programs through `shell`.
