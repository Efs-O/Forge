---
name: music-track
description: Plan a local music track with the user, then render it with generate_music.
requires_tools: generate_music
---

# Music track

Use `ask_user` to ask about the style and lyrics before calling
`generate_music`. Do not start a render in an unattended turn.

1. Ask for genre, mood, instruments, tempo and arrangement, and ask which lyrics
   choice they want: their own words (`user`), new words drafted by the agent
   (`agent`), or no lyrics (`none`). Use the request's source audio duration as
   the default length when available; otherwise the configured duration applies.
2. For `user`, ask for the lyrics file path. For `agent`, draft original lyrics,
   save them to a workspace file with `write_file`, show the complete text to
   the user, and wait for explicit approval before calling `generate_music`.
   Pass the approved file as `lyrics_path`. For `none`, do not create a lyrics
   file and use `lyrics: "none"`.
3. If the request includes an audio path, pass it as `source_audio_path`. This
   runs the configured Music Flamingo analysis first; it uses the description
   and duration to guide a new track. It is not a cover, audio-to-audio edit,
   transcription, or voice clone. Do not present guessed lyric fragments as a
   transcript. If analysis is unavailable, explain that and ask whether the user
   wants to continue with a style prompt and `analyze: false`; do not invent
   analysis text or lyric text.
4. `lyrics: "user"` and `lyrics: "agent"` route to ACE-Step 1.5. `lyrics:
   "none"` routes to Stable Audio 3, which cannot sing. Keep any BPM or key
   returned by audio analysis labelled as estimates. Do not silently change the
   lyrics choice to fit an engine.
5. Confirm the user's style and lyrics choices before the call. The render runs
   in the background and may unload the chat model from its GPU. When it ends,
   report the output and invite the user to listen; duration and silence checks
   are technical checks, not a judgment of musical quality.

Use the tools directly. Do not run adapters or model programs through `shell`.
