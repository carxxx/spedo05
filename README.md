# SAMC Speedo

Static HTML/CSS/JS speedometer for GitHub Pages.

## Custom speed backgrounds
The six PNG backgrounds are stored in `assets/01.png` through `assets/06.png`.
Change their stage mapping in `app.js` inside `SPEED_BG_STAGES`.

Current speed bands (same unit used by the incoming speed telemetry):
- 0-1 -> 01.png
- 2-25 -> 02.png
- 26-50 -> 03.png
- 51-80 -> 04.png
- 81-100 -> 05.png
- 100+ -> 06.png

The dark canvas wash is intentionally low-opacity so the PNG artwork remains visible behind the dial graphics.
