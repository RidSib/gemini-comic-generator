# Gemini Comic Generator

A small local web app that turns a prompt into a multi-page comic.

- **Gemini 3.8 Flash** plans the story: page count, art style, characters, and the panels of each page.
- **Nano Banana** (2 Lite, 2, or Pro) draws each page as one multi-panel image.
- **Veo 3.1** (optional) turns each page into a short looping clip.

## Features

- Review and edit the outline before drawing, or generate instantly (capped at 5 pages).
- Edit the breakdown afterwards; only pages whose prompt changed are redrawn.
- Cinematic reader with single-page and side-by-side views and a page-flip animation.
- Test feature: draw every page with all three image models and compare them side by side.
- Every comic is saved locally in `comics/<date-time-title>/` as `comic.json` plus the page images and clips.

## Run it

Requires Node 20.12 or newer. There are no dependencies to install.

```bash
cp .env.example .env   # then add your GEMINI_API_KEY
npm start
```

Open http://localhost:5177.

Animation pads pages with the macOS `sips` tool; on other systems pages are sent to Veo unpadded.

## Note

The server has no authentication. Run it locally; anyone who can reach it can generate on your API key.
