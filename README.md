# SAMC Speedo

Static HTML/CSS/JS speedometer for GitHub Pages.

## Custom speed backgrounds
The six PNG backgrounds are stored in `assets/01.png` through `assets/06.png`.
Change their stage mapping in `app.js` inside `SPEED_BG_STAGES`.

Current speed bands (same unit used by the incoming speed telemetry):
- 0-20 -> 01.png
- 21-60 -> 02.png
- 61-120 -> 03.png
- 121-160 -> 04.png
- 161-200 -> 05.png
- 200+ -> 06.png

The dark canvas wash is intentionally low-opacity so the PNG artwork remains visible behind the dial graphics.
