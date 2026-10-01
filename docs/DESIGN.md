# Design direction

The site presents an agent ecosystem as connected, independently useful parts. The home page's orbit map is the single illustrative element; task rows and tables carry the working information.

The default palette follows AstralDeep's Midnight theme: background #0F1221, surface #1A1E2E, primary #6366F1, secondary #8B5CF6, text #F3F4F6, and cyan accent. Link and muted-text tones are lifted for readability. The persistent appearance toggle selects a Daylight-derived palette with background #F8FAFC, white surfaces, primary #4F46E5, and secondary #7C3AED. Dark remains the default even on a light system theme; an explicit saved user preference wins.

The actual AstralDeep wordmark, icon, and local Open Sans font are copied without modification from AstralProjection `b375588301b8240482dfbae10e9c891242385f70`, under `backend/webrender/static/img/` and `backend/webrender/static/fonts/`. The font's OFL license is retained beside it. Palette references are `backend/webrender/static/astral.css` and `client.js`'s Midnight/Daylight definitions. The other four repositories do not carry standalone brand marks in their tracked assets; their names remain text rather than invented logos.

Layout: left-aligned contribution narrative beside a labeled relationship map; four focus areas; repository directory. The board uses filter controls above task rows. The leaderboard uses a semantic table. All use the same quiet header and footer.

The design deliberately avoids fake live statistics, decorative dashboards, and progress claims before evidence exists. Empty states explain initial review and accepted credit. Keyboard focus, mobile reflow, semantic headings, readable contrast, and safe text rendering are baseline requirements.
