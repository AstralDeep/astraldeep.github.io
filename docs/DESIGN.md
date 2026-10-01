# Design direction

The site presents an agent ecosystem as connected, independently useful parts. The home page's captioned video explains delegation, permission checks, structured UI and component ownership with timed mechanism diagrams. Task rows and tables carry the working information.

The default palette follows AstralDeep's Midnight theme: background #0F1221, surface #1A1E2E, primary #6366F1, secondary #8B5CF6, text #F3F4F6, and cyan accent. Link and muted-text tones are lifted for readability. The persistent appearance toggle selects a Daylight-derived palette with background #F8FAFC, white surfaces, primary #4F46E5, and secondary #7C3AED. Dark remains the default even on a light system theme; an explicit saved user preference wins.

The favicon is exported from the current Apple app icon in AstralProjection `b375588301b8240482dfbae10e9c891242385f70`, under `apple-clients/AstralApp/AstralApp/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png`. The unchanged source master is retained in `media/`. The transparent wordmark was regenerated with the built-in image generator using that icon as its identity reference; it combines the purple orbit and cyan core with AstralDeep text. It replaces the legacy web wordmark in every header, footer and video frame. Generation provenance and the final prompt are in [BRANDING.md](BRANDING.md). Builds version both branding assets by content hash.

The local Open Sans font is copied from the same Projection revision, under `backend/webrender/static/fonts/`; its OFL license is retained beside it. Palette references are `backend/webrender/static/astral.css` and `client.js`'s Midnight/Daylight definitions. The other four repositories do not carry standalone brand marks in their tracked assets; their names remain text rather than invented logos.

Layout: left-aligned contribution narrative beside the ecosystem video; four focus areas; repository directory. The board uses filter controls above task rows. The leaderboard uses a semantic table. All use the same quiet header and footer.

The design deliberately avoids fake live statistics, decorative dashboards, and progress claims before evidence exists. Empty states explain initial review and accepted credit. Keyboard focus, mobile reflow, semantic headings, readable contrast, and safe text rendering are baseline requirements.
