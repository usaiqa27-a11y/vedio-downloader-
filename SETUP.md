# Video Downloader — Setup & Troubleshooting

## Prerequisites

- **Python 3.11+**
- **Node.js 18+**
- **FFmpeg** (required for audio/video merging)

---

## 1. Install FFmpeg

FFmpeg is **mandatory** — without it, HD videos download without audio because the video and audio streams cannot be merged.

### Windows (winget)
```powershell
winget install Gyan.FFmpeg
```
Then **restart your terminal** so the `ffmpeg` command is on PATH.

### Windows (manual)
1. Download from https://ffmpeg.org/download.html (Windows build)
2. Extract the zip
3. Add the `bin/` folder to your system PATH

### macOS (Homebrew)
```bash
brew install ffmpeg
```

### Ubuntu / Debian
```bash
sudo apt update && sudo apt install ffmpeg
```

### Verify installation
```bash
ffmpeg -version
```
You should see version info (e.g. `ffmpeg version 7.x ...`). If you get "command not found", FFmpeg is not on PATH.

---

## 2. Backend Setup

```bash
cd video-downloader

# Create virtual environment
python -m venv venv

# Activate it
# Windows:
venv\Scripts\activate
# macOS/Linux:
source venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# Run the server
python main.py
```

Server runs at **http://localhost:8000**.

On startup you should see in the terminal:
```
INFO:     yt-dlp version: 2025.x.x
INFO:     FFmpeg detected: ffmpeg version 7.x ...
```

If you see `WARNING: FFmpeg NOT found`, go back to step 1.

---

## 3. Frontend Setup

Open a **new terminal**:

```bash
cd video-downloader/frontend

npm install
npm run dev
```

Frontend runs at **http://localhost:5173**.

---

## Troubleshooting

### "FFmpeg NOT found" warning
- Windows: After `winget install Gyan.FFmpeg`, close and reopen your terminal
- Verify: `ffmpeg -version` should work in a fresh terminal

### "This URL is not supported"
- The URL might be from a private/restricted video, or an unsupported platform
- yt-dlp supports 1000+ sites — check the full list: https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md

### HD video has no audio
- This means FFmpeg is missing or not detected
- The backend logs will show `FFmpeg NOT found`
- Install FFmpeg (step 1), restart the backend

### CORS errors in browser console
- Ensure the backend is running on port 8000
- Ensure the frontend is running on port 5173
- Do NOT open the React files directly — always use `npm run dev`

### Download is slow
- The app uses 10 concurrent fragment downloads by default
- For Facebook/TikTok, speeds depend on the platform's CDN
- Large 4K files can take several minutes

### Windows filename errors (Errno 22)
- Already handled — the backend uses `restrictfilenames=True` and `windowsfilenames=True`
- If you still see this, update yt-dlp: `pip install -U yt-dlp`
