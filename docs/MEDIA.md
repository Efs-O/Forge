# Local video and music generation

Forge's media tools run configured local adapters. They are optional, off by
default, and do not download models. When `media.enabled` is false, the video
and music tools are not registered.

## Set it up

1. Install ComfyUI and any local runtimes you plan to use. Have `ffmpeg` and
   `ffprobe` available on `PATH`, or configure `media.ffmpeg`.
2. Add a `media:` block to `config.yaml`. The commented example in
   [`config/config.example.yaml`](../config/config.example.yaml) lists every
   setting and the file paths each engine requires. Set paths to files already
   installed; `output_dir` is workspace-relative and defaults to `media`.
3. Choose GPU ids with enough free memory. The example assigns LTX-2.5, ACE-Step
   and Stable Audio to GPU 2, and H3 to GPU 0. These are example physical indexes.
   Forge checks each configured device against its `min_free_vram_mb` threshold
   before taking the GPU lease or unloading a model. Example thresholds are
   11,000 for LTX, ACE-Step and Stable Audio, and 15,000 for H3. The music
   engines use one selected GPU and should run sequentially.
4. Set `media.enabled: true` after reviewing the paths and hardware. Run
   **Forge: Check Media Setup** from the Command Palette. It checks configured
   paths and `ffmpeg`/`ffprobe` without launching an engine, render, or GPU
   memory probe. Render startup checks live free VRAM. Telegram `/media` shows
   the same setup report.

Use the shipped `hf-download` skill when you want help downloading model files.
It uses parallel ranged downloads with resume and hash checks. Confirm the model
license, exact files and destination before downloading. Forge never downloads
weights automatically.

## Video

`generate_video` makes a short clip from a still or from a prompt. LTX-2.5 is
the default; its defaults are 5 seconds, 1344×768 at 24 fps, and both dimensions
must be multiples of 64. Without `image_path`, Forge first asks the configured
image backend to make a still. The render runs in the background and may unload
the chat model from a GPU; the next chat turn loads it again.

MiniMax H3 is optional. It needs one 16 GB Blackwell card, the configured UNET,
and the upstream ComfyUI blueprint at
`<ComfyUI root>/blueprints/Image to Video (MiniMax H3).json`. Forge chooses H3
only when the user asks for it by name. Start with the official
[MiniMaxAI/MiniMax-H3](https://huggingface.co/MiniMaxAI/MiniMax-H3) model files
and verify the workflow's exact node and file requirements.

The LTX adapter's Q8 GGUF is available from the community
[Abiray/LTX-2.5-Distilled-GGUF](https://huggingface.co/Abiray/LTX-2.5-Distilled-GGUF);
Lightricks' official model files and documentation are in
[Lightricks/LTX-2.5](https://huggingface.co/Lightricks/LTX-2.5). Check the
license for the exact files you use.

## Music

`generate_music` supports ACE-Step 1.5 for tracks with or without vocals, and
Stable Audio 3 Medium for instrumental tracks. Stable Audio 3 cannot sing and
has a 380-second maximum. ACE-Step is installed as a standalone runtime;
ComfyUI's repackaged checkpoint is in
[Comfy-Org/ace_step_1.5_ComfyUI_files](https://huggingface.co/Comfy-Org/ace_step_1.5_ComfyUI_files),
with the upstream model at
[ACE-Step/Ace-Step1.5](https://huggingface.co/ACE-Step/Ace-Step1.5). Configure
the post-trained Stable Audio checkpoint from
[stabilityai/stable-audio-3-medium](https://huggingface.co/stabilityai/stable-audio-3-medium)
and its ComfyUI text encoder from
[Comfy-Org/stable-audio-3](https://huggingface.co/Comfy-Org/stable-audio-3),
not the Base checkpoint.

If you supply an audio file, Forge can send it to a configured Music Flamingo
DLT analyzer. That analysis guides a new track and its target duration; the
source audio is not passed to the generator as a cover, voice clone or direct
audio-to-audio edit. Analysis is optional and may be unavailable. Treat any
detected lyric fragments as uncertain, not as transcription. User-written or
agent-written lyrics need a workspace file; agent-written lyrics must be shown
to and approved by the user before rendering. `lyrics: "none"` makes an
instrumental and uses Stable Audio 3 by default.

## Output checks and limits

Each run keeps its inputs, logs and manifest under the configured workspace
output directory. The manifest records engine validation, duration and silence
checks. Those checks catch gross technical failures only; they do not score
visual quality, musical quality or lyric intelligibility. In the phase 1 smoke
run, silence detection flagged the LTX-2.5 and ACE-Step outputs, while the
Stable Audio output had no detected silence. Inspect video with `view_video`
and listen to music before deciding whether an output is usable.

Telegram delivery uses the existing durable outbox. A finished file within the
50 MiB upload limit is sent to the bound chat. A larger file may be accompanied
by a shorter preview and a workspace path to the full output.
