from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
from contextlib import asynccontextmanager
from typing import Any

import uvicorn
from fastapi import BackgroundTasks, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel
import yt_dlp

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

FFMPEG_AVAILABLE = False

tasks: dict[str, dict[str, Any]] = {}
tasks_lock = threading.Lock()


def _check_ffmpeg() -> bool:
    global FFMPEG_AVAILABLE
    try:
        kwargs: dict[str, Any] = {"capture_output": True, "timeout": 5}
        if os.name == "nt":
            kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
        result = subprocess.run(["ffmpeg", "-version"], **kwargs)
        if result.returncode == 0:
            line = result.stdout.decode(errors="ignore").split("\n")[0]
            logger.info("FFmpeg detected: %s", line)
            FFMPEG_AVAILABLE = True
            return True
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        pass
    logger.warning(
        "FFmpeg NOT found. Video+audio merging requires FFmpeg. "
        "Install from https://ffmpeg.org/download.html"
    )
    FFMPEG_AVAILABLE = False
    return False


def _cleanup_old_tasks():
    now = time.time()
    with tasks_lock:
        expired = [tid for tid, t in tasks.items() if now - t.get("created", 0) > 1800]
        for tid in expired:
            t = tasks.pop(tid, {})
            d = t.get("tmp_dir", "")
            if d and os.path.isdir(d):
                shutil.rmtree(d, ignore_errors=True)


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("yt-dlp version: %s", yt_dlp.version.__version__)
    _check_ffmpeg()
    yield
    with tasks_lock:
        for t in tasks.values():
            d = t.get("tmp_dir", "")
            if d and os.path.isdir(d):
                shutil.rmtree(d, ignore_errors=True)
        tasks.clear()


app = FastAPI(title="Video Downloader API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["Content-Disposition"],
)


# ── Models ────────────────────────────────────────────────────

class InfoRequest(BaseModel):
    url: str


class DownloadRequest(BaseModel):
    url: str
    format_id: str = "best"
    mode: str = "video"


class FormatInfo(BaseModel):
    format_id: str
    ext: str
    resolution: str
    fps: float | None = None
    filesize: int | None = None
    vcodec: str | None = None
    acodec: str | None = None
    note: str = ""


class VideoInfo(BaseModel):
    title: str
    duration: float | None = None
    thumbnail: str | None = None
    formats: list[FormatInfo]


# ── yt-dlp Helpers ────────────────────────────────────────────

_BASE_OPTS: dict[str, Any] = {
    "quiet": True,
    "no_warnings": True,
    "skip_download": True,
    "noplaylist": True,
}


def _extract_info(url: str) -> dict[str, Any]:
    with yt_dlp.YoutubeDL(_BASE_OPTS) as ydl:
        return ydl.extract_info(url, download=False)


def _format_has_audio(fmt: dict) -> bool:
    acodec = fmt.get("acodec", "none")
    return acodec and acodec != "none"


def _resolve_format_spec(format_id: str, mode: str, raw_formats: list[dict]) -> str:
    if mode == "audio":
        return "bestaudio/best"

    if format_id == "best":
        return "bestvideo+bestaudio/best"

    target = None
    for f in raw_formats:
        if f.get("format_id") == format_id:
            target = f
            break

    if target and _format_has_audio(target):
        return format_id

    return f"{format_id}+bestaudio/best"


def _on_progress(task: dict, d: dict):
    status = d.get("status")
    if status == "downloading":
        task["status"] = "downloading"
        task["progress"] = d.get("_percent_str", "0%").strip()
        task["speed"] = d.get("_speed_str", "").strip()
        task["eta"] = d.get("_eta_str", "").strip()
    elif status == "finished":
        task["status"] = "merging"
        task["progress"] = "100%"
        task["speed"] = ""
        task["eta"] = "ffmpeg merging..." if FFMPEG_AVAILABLE else ""


def _make_safe_title(title: str) -> str:
    safe = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', "_", title)
    safe = re.sub(r"_+", "_", safe).strip("_. ")
    if not safe:
        safe = "download"
    return safe[:80]


def _download_to_temp(
    url: str,
    format_spec: str,
    mode: str,
    progress_callback=None,
) -> tuple[str, str, str]:
    tmp_dir = tempfile.mkdtemp(prefix="vdl_")

    dl_opts: dict[str, Any] = {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "no_part": True,
        "outtmpl": os.path.join(tmp_dir, "%(id)s.%(ext)s"),
        "concurrent_fragment_downloads": 10,
    }

    if mode == "video":
        dl_opts["merge_output_format"] = "mp4"

    if progress_callback:
        dl_opts["progress_hooks"] = [progress_callback]

    with yt_dlp.YoutubeDL(dl_opts) as ydl:
        info = ydl.extract_info(url, download=True)
        title = info.get("title", "download") if info else "download"

    files = [
        f for f in os.listdir(tmp_dir)
        if os.path.isfile(os.path.join(tmp_dir, f))
    ]
    if not files:
        shutil.rmtree(tmp_dir, ignore_errors=True)
        raise RuntimeError("Download produced no output file.")

    orig_path = os.path.join(tmp_dir, files[0])
    ext = files[0].rsplit(".", 1)[-1] if "." in files[0] else "mp4"
    safe_title = _make_safe_title(title)
    safe_filename = f"{safe_title}.{ext}"
    final_path = os.path.join(tmp_dir, safe_filename)

    if orig_path != final_path:
        try:
            os.rename(orig_path, final_path)
        except OSError:
            final_path = orig_path
            safe_filename = files[0]

    return final_path, tmp_dir, safe_filename


def _run_task(task: dict, url: str, format_spec: str, mode: str):
    try:
        task["status"] = "downloading"
        filepath, tmp_dir, safe_filename = _download_to_temp(
            url, format_spec, mode,
            progress_callback=lambda d: _on_progress(task, d),
        )
        task["filepath"] = filepath
        task["tmp_dir"] = tmp_dir
        task["filename"] = safe_filename
        task["status"] = "done"
        task["progress"] = ""
        task["speed"] = ""
        task["eta"] = ""
    except yt_dlp.utils.DownloadError as exc:
        msg = str(exc)
        if "Unsupported URL" in msg:
            task["status"] = "error"
            task["error"] = "This URL is not supported."
        elif "Private video" in msg or "This video is private" in msg:
            task["status"] = "error"
            task["error"] = "This video is private or restricted."
        else:
            task["status"] = "error"
            task["error"] = f"Cannot download: {msg}"
    except Exception as exc:
        logger.exception("Download task failed")
        task["status"] = "error"
        task["error"] = f"Download failed: {exc}"


# ── Endpoints ─────────────────────────────────────────────────

@app.get("/api/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "ffmpeg": str(FFMPEG_AVAILABLE).lower()}


@app.post("/api/info", response_model=VideoInfo)
async def get_info(req: InfoRequest) -> VideoInfo:
    url = req.url.strip()
    if not url:
        raise HTTPException(status_code=400, detail="URL is required.")

    try:
        data = await asyncio.to_thread(_extract_info, url)
    except yt_dlp.utils.DownloadError as exc:
        msg = str(exc)
        if "Unsupported URL" in msg:
            raise HTTPException(status_code=422, detail="This URL is not supported.")
        if "Private video" in msg or "This video is private" in msg:
            raise HTTPException(status_code=403, detail="This video is private or restricted.")
        raise HTTPException(status_code=422, detail=f"Could not fetch video info: {msg}")
    except Exception as exc:
        logger.exception("Unexpected error during info extraction")
        raise HTTPException(status_code=500, detail=f"Internal error: {exc}")

    raw_formats: list[dict[str, Any]] = data.get("formats") or []
    seen: set[tuple] = set()
    deduped: list[FormatInfo] = []

    for fmt in raw_formats:
        fid = fmt.get("format_id", "")
        ext = fmt.get("ext", "unknown")
        filesize = fmt.get("filesize") or fmt.get("filesize_approx")

        vcodec = fmt.get("vcodec", "none")
        acodec = fmt.get("acodec", "none")
        has_video = vcodec and vcodec != "none"
        has_audio = acodec and acodec != "none"

        height = fmt.get("height")
        fps = fmt.get("fps")

        if has_video and height:
            resolution = f"{height}p"
        elif has_video:
            resolution = "video"
        elif has_audio:
            resolution = "audio only"
        else:
            resolution = fmt.get("format_note", "unknown")

        key = (ext, resolution, filesize)
        if key in seen:
            continue
        seen.add(key)

        notes: list[str] = []
        if has_video and not has_audio:
            notes.append("video only")
        if has_audio and not has_video:
            notes.append("audio only")

        deduped.append(
            FormatInfo(
                format_id=fid,
                ext=ext,
                resolution=resolution,
                fps=fps,
                filesize=filesize,
                vcodec=vcodec if has_video else None,
                acodec=acodec if has_audio else None,
                note=", ".join(notes),
            )
        )

    deduped.sort(
        key=lambda f: (
            0 if f.vcodec and f.acodec else 1,
            -(int(f.resolution.replace("p", ""))
              if f.resolution.endswith("p") and f.resolution[:-1].isdigit()
              else 0),
        ),
    )

    return VideoInfo(
        title=data.get("title", "Untitled"),
        duration=data.get("duration"),
        thumbnail=data.get("thumbnail"),
        formats=deduped,
    )


@app.post("/api/download")
async def start_download(req: DownloadRequest):
    url = req.url.strip()
    if not url:
        raise HTTPException(status_code=400, detail="URL is required.")

    _cleanup_old_tasks()

    raw_formats = []
    try:
        data = await asyncio.to_thread(_extract_info, url)
        raw_formats = data.get("formats") or []
    except Exception:
        pass

    task_id = uuid.uuid4().hex[:12]
    task: dict[str, Any] = {
        "id": task_id,
        "status": "queued",
        "progress": "",
        "speed": "",
        "eta": "",
        "filename": "",
        "tmp_dir": "",
        "filepath": "",
        "error": "",
        "created": time.time(),
    }
    with tasks_lock:
        tasks[task_id] = task

    format_spec = _resolve_format_spec(req.format_id, req.mode, raw_formats)

    thread = threading.Thread(
        target=_run_task,
        args=(task, url, format_spec, req.mode),
        daemon=True,
    )
    thread.start()

    return {"task_id": task_id}


@app.get("/api/progress/{task_id}")
async def progress(task_id: str):
    async def generate():
        while True:
            with tasks_lock:
                task = tasks.get(task_id)
            if not task:
                yield f"data: {json.dumps({'status': 'error', 'error': 'Task not found'})}\n\n"
                break

            payload = {
                "status": task["status"],
                "progress": task["progress"],
                "speed": task["speed"],
                "eta": task["eta"],
                "filename": task["filename"],
                "error": task["error"],
            }
            yield f"data: {json.dumps(payload)}\n\n"

            if task["status"] in ("done", "error"):
                break

            await asyncio.sleep(0.5)

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.get("/api/file/{task_id}")
async def serve_file(task_id: str, background_tasks: BackgroundTasks):
    with tasks_lock:
        task = tasks.pop(task_id, None)

    if not task:
        raise HTTPException(status_code=404, detail="Task expired or already downloaded.")

    if task["status"] != "done":
        raise HTTPException(status_code=400, detail="Download not ready.")

    filepath = task["filepath"]
    tmp_dir = task["tmp_dir"]
    filename = task["filename"]

    if not os.path.isfile(filepath):
        if tmp_dir and os.path.isdir(tmp_dir):
            shutil.rmtree(tmp_dir, ignore_errors=True)
        raise HTTPException(status_code=410, detail="File no longer available.")

    background_tasks.add_task(shutil.rmtree, tmp_dir, True)

    return FileResponse(
        path=filepath,
        filename=filename,
        media_type="application/octet-stream",
    )


if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
