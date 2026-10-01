# AstralDeep introduction

The ecosystem film explains the project's design and invites developers to contribute. It does not establish complete protocol conformance, deployment security, or mobile voice qualification. Those remain tasks with their own evidence requirements.

The nine slides cover the goal, authority boundaries, LETS delegation, checks before actions, structured generative UI, component ownership, open protocols, contributor priorities, and the points bounty workflow. The narration contains no academic biography. It uses the actual AstralDeep wordmark and the Midnight palette. There are no changing product screenshots.

[Editable slide source](../media/astraldeep-introduction-slides.pptx) and [storyboard with narration and source pointers](../media/storyboard.json) are retained in the source repository. They stay outside the Pages build allowlist. Public playback assets live in `site/assets/video/`.

The 141.635-second MP4 uses H.264 video at 1920×1080/24 fps and AAC audio. Narration was synthesized through the configured LLM Factory service with `speaches-ai/Kokoro-82M-v1.0-ONNX`, `af_heart`, and 24 kHz mono WAV output. English captions are available as both an embedded subtitle stream and a default same-origin WebVTT track. The web track uses small text with bottom padding. A text transcript provides another way to read the story. No service URL or credential is shipped.

Each utterance was synthesized separately. Caption timing follows its audio boundaries, with longer utterances split into at most two lines using proportionate durations. This is sentence timing, not word-level forced alignment. Nine chapter lengths follow the recorded narration. The final file has a fast-start MP4 layout and is approximately 3 MB.

Sources were checked at the review revisions:

- [AstralDeep guide and engineering constitution](https://github.com/AstralDeep/AstralDeep/tree/6cd4b22641d7c08b7e50e945602d52ccd4489215): server-owned UI, normal dispatch, identity, owner isolation, policy, confirmation, and audit provenance.
- [LETS constitution](https://github.com/AstralDeep/LETS/blob/292d557c6fb4184eb9ee38dd013500260ba5637d/.specify/memory/constitution.md): attenuated child leases, finite resource budgets, expiry, and verification with durable receipt claims before protected effects. Deep's LETS enforcement is configuration-dependent.
- [Component integration intent](https://github.com/AstralDeep/AstralDeep/blob/6cd4b22641d7c08b7e50e945602d52ccd4489215/specs/074-multirepo-lets-integration/spec.md), [Primitives](https://github.com/AstralDeep/AstralPrimitives/tree/fe366d0a11dbff2dbc42e1159a562b544da9cc01), [Projection](https://github.com/AstralDeep/AstralProjection/tree/b375588301b8240482dfbae10e9c891242385f70), and [Plane](https://github.com/AstralDeep/AstralPlane/tree/8ecb88c8ab31b41e6c5879c67943ed0cce4df00f): independently governed components and their responsibilities.
- [Conversational voice](https://github.com/AstralDeep/AstralDeep/blob/6cd4b22641d7c08b7e50e945602d52ccd4489215/specs/065-conversational-voice/spec.md) and [client-local speech](https://github.com/AstralDeep/AstralDeep/blob/6cd4b22641d7c08b7e50e945602d52ccd4489215/specs/075-client-local-speech/spec.md): voice goals and cross-client qualification obligations. Specs describe intent; the video invites work rather than claiming every client is complete.
- Owner priorities and approval on 2026-10-01, the published source bounty issues, and [contribution rules](https://astraldeep.github.io/contribute.html): MCP/A2A compatibility, mobile voice, reusable parts, reservations, and recognition points.

When revising the story, retain the specified/implemented/tested/live-verified distinctions. Preserve the chosen voice, keep playback under three minutes, regenerate captions from the new audio, check every frame, and inspect desktop and mobile playback before publishing.
