# AstralDeep community branding

The owner selected the current Apple app icon on 2026-10-01. The source is [AppIcon-1024.png in AstralProjection](https://github.com/AstralDeep/AstralProjection/blob/b375588301b8240482dfbae10e9c891242385f70/apple-clients/AstralApp/AstralApp/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png). The light and dark Apple source icons have identical bytes at this revision.

- `media/astraldeep-apple-icon-master.png`: unchanged 1024×1024 Apple source; SHA-256 `ed30aefdbc082becd02d836ede0363fd4d6d8f037560bdc80bc19a1d09551fb3`.
- `media/astraldeep-wordmark-master.png`: regenerated transparent 2172×724 lockup; SHA-256 `730bb1cd430c4c8676021adeb558589540375271f2b2ee9022be629d772290f6`.
- `site/assets/astraldeep-icon.png`: 64×64 favicon exported from the Apple source, without redesign; SHA-256 `d57ae78389da2af0aa3753258a577b930c0b7fa72ee896e0e4f4054b8d1cd80a`.
- `site/assets/astraldeep-wordmark.png`: transparent 1086×362 web/video export; SHA-256 `06303055f7af786434472c6f0882376d97b12ecd73ad71004c88340dbce16835`.

The wordmark uses the built-in image generation tool through the imagegen skill, not the API/CLI fallback. It is an Apple-icon-derived graphic rather than a byte-identical extraction. The Apple source master remains byte-identical. Web exports resize the selected masters with Sharp and preserve the wordmark's alpha channel; masters stay outside the Pages allowlist. No Apple client asset or product code was changed. The same lockup is embedded in the editable video slides, MP4 and poster. The accepted narration, captions and diagram timings remain unchanged.

The first generation supplied the Apple icon and requested a transparent icon-plus-text lockup. The final refinement used that draft as edit target (image 1) and the original Apple icon as the authoritative identity reference (image 2). Final prompt:

```text
Use case: compositing.
Input image 1 is the edit target, a transparent AstralDeep lockup. Input image 2 is the authoritative current Apple app icon, supplied to preserve exact identity.
Create a refined horizontal website header lockup on a TRUE TRANSPARENT background with aspect ratio exactly 4:1, wide landscape canvas. Fix the proportions and typography. Use the icon at left, filling 90% of canvas height but ONLY 22% of canvas width. Place the exact text "AstralDeep" on the right taking about 70% of canvas width. Leave a clear gap of 4% canvas width between the icon and text. Leave clean exterior transparent margins. Do not let the icon touch the A. Vertically center text alongside the icon.
Text is "AstralDeep", exactly, one word. Use a refined humanist sans-serif like Open Sans at SEMIBOLD weight 600, NOT extra bold or chunky. No outlined type. Wordmark letters should be approximately half the icon height. Astral medium luminous violet #9B72DC, Deep medium cyan #389DB1. Crisp, solid clean letters with no heavy gradient, no speckled edges, no shadow. Header-sized text must be readable.
Preserve the exact design from the Apple icon: purple upper orbit, four-point radiant star toward the upper center of the icon, tiny sparkles, the graceful curving violet ribbon and cyan swirling core. Do not invent a different orbit or core. Only remove the flat navy background from that icon. Keep internal dark details and clean glow edges.
No background rectangle, no checkerboard texture, no extra text, no watermark, no other objects. This is one final clean transparent icon + wordmark graphic.
```
