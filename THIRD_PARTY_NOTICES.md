# Third-party notices

No third-party binary, model weight, browser profile, account data, or media
sample is stored in this Git repository. The optional local setup script
downloads the following pinned artifacts into the ignored `.runtime/` directory.
Those artifacts remain governed by their upstream terms and are not relicensed
under this project's Polyform license.

| Component | How it is used | Upstream terms |
| --- | --- | --- |
| [QwenAudio/SenseVoice](https://github.com/QwenAudio/SenseVoice) | SenseVoice llama.cpp Windows runtime `runtime-llamacpp-v0.2.1` and its public test sample | [MIT License](https://github.com/QwenAudio/SenseVoice/blob/main/LICENSE) |
| [FunAudioLLM/SenseVoiceSmall-GGUF](https://huggingface.co/FunAudioLLM/SenseVoiceSmall-GGUF) | Local speech-recognition model weights | Apache-2.0, as stated by the upstream model card |
| [FunAudioLLM/fsmn-vad-GGUF](https://huggingface.co/FunAudioLLM/fsmn-vad-GGUF) | Local voice-activity-detection model weights | Apache-2.0, as stated by the upstream model card |

The chat editor selector was informed by the independently maintained
[ScriptCat-Douyin-Fire-Helper](https://github.com/dr-190/ScriptCat-Douyin-Fire-Helper),
which is distributed under the MIT License. No copy of that project or its
runtime assets is included here.

Users are responsible for reviewing and complying with the upstream terms that
apply to artifacts they download and with the terms of the services they use.
