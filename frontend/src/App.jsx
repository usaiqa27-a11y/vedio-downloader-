import { useState, useCallback, useRef, useEffect } from "react";

const API_BASE = "http://localhost:8000";

function formatDuration(seconds) {
  if (!seconds) return "--:--";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0)
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatSize(bytes) {
  if (!bytes) return "";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let size = bytes;
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024;
    i++;
  }
  return `${size.toFixed(1)} ${units[i]}`;
}

const STEPS = [
  { key: "analyzing", label: "Analyzing Link" },
  { key: "downloading", label: "Downloading Stream" },
  { key: "merging", label: "Merging Video & Audio" },
  { key: "done", label: "Saving File" },
];

function StepIndicator({ currentStep }) {
  const idx = STEPS.findIndex((s) => s.key === currentStep);
  return (
    <div className="flex items-center justify-center gap-1 sm:gap-2 py-4">
      {STEPS.map((step, i) => {
        const active = i === idx;
        const done = i < idx;
        return (
          <div key={step.key} className="flex items-center gap-1 sm:gap-2">
            <div className="flex flex-col items-center">
              <div
                className={`flex h-7 w-7 sm:h-8 sm:w-8 items-center justify-center rounded-full text-[10px] sm:text-xs font-bold transition-all ${
                  done
                    ? "bg-green-500/20 text-green-400"
                    : active
                    ? "bg-indigo-500/30 text-indigo-300 ring-2 ring-indigo-500/50 animate-pulse"
                    : "bg-white/5 text-gray-600"
                }`}
              >
                {done ? (
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                  </svg>
                ) : (
                  i + 1
                )}
              </div>
              <span
                className={`mt-1 text-[9px] sm:text-[10px] whitespace-nowrap ${
                  active ? "text-indigo-300" : done ? "text-green-400/70" : "text-gray-600"
                }`}
              >
                {step.label}
              </span>
            </div>
            {i < STEPS.length - 1 && (
              <div
                className={`mb-4 h-px w-4 sm:w-8 ${
                  done ? "bg-green-500/30" : "bg-white/10"
                }`}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

function ProgressBar({ progress, speed, eta }) {
  const pct = parseFloat(progress) || 0;
  return (
    <div className="space-y-1.5">
      <div className="h-2 w-full overflow-hidden rounded-full bg-white/10">
        <div
          className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-purple-500 transition-all duration-300"
          style={{ width: `${Math.min(pct, 100)}%` }}
        />
      </div>
      <div className="flex justify-between text-[10px] sm:text-xs text-gray-400">
        <span>{progress || "0%"}</span>
        {speed && <span>{speed}</span>}
        {eta && <span>ETA {eta}</span>}
      </div>
    </div>
  );
}

export default function App() {
  const [url, setUrl] = useState("");
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState("");
  const [videoInfo, setVideoInfo] = useState(null);
  const [selectedFormat, setSelectedFormat] = useState(null);
  const [downloadMode, setDownloadMode] = useState("video");
  const [dlStatus, setDlStatus] = useState(null);
  const [dlProgress, setDlProgress] = useState("");
  const [dlSpeed, setDlSpeed] = useState("");
  const [dlEta, setDlEta] = useState("");
  const eventSourceRef = useRef(null);

  useEffect(() => {
    return () => {
      if (eventSourceRef.current) eventSourceRef.current.close();
    };
  }, []);

  const handleAnalyze = async (e) => {
    e.preventDefault();
    const trimmed = url.trim();
    if (!trimmed) return;

    setAnalyzing(true);
    setError("");
    setVideoInfo(null);
    setSelectedFormat(null);
    setDlStatus(null);

    try {
      const res = await fetch(`${API_BASE}/api/info`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: trimmed }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Failed to analyze video.");

      const videoFormats = data.formats.filter(
        (f) => f.vcodec && f.vcodec !== "none"
      );
      const audioFormats = data.formats.filter(
        (f) =>
          f.acodec &&
          f.acodec !== "none" &&
          (!f.vcodec || f.vcodec === "none")
      );

      const bestVideo = videoFormats[0];
      const bestAudio = audioFormats[0];

      setVideoInfo({
        ...data,
        videoFormats,
        audioFormats,
        bestVideo: bestVideo?.format_id || "best",
        bestAudio: bestAudio?.format_id || "best-audio",
      });
      setSelectedFormat(bestVideo?.format_id || "best");
      setDownloadMode("video");
    } catch (err) {
      setError(err.message || "Something went wrong.");
    } finally {
      setAnalyzing(false);
    }
  };

  const handleDownload = useCallback(async () => {
    if (!videoInfo) return;
    setError("");
    setDlStatus("queued");
    setDlProgress("");
    setDlSpeed("");
    setDlEta("");

    const fmtId =
      downloadMode === "audio"
        ? videoInfo.bestAudio
        : selectedFormat || videoInfo.bestVideo;

    try {
      const startRes = await fetch(`${API_BASE}/api/download`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: url.trim(),
          format_id: fmtId,
          mode: downloadMode,
        }),
      });

      if (!startRes.ok) {
        const data = await startRes.json().catch(() => ({}));
        throw new Error(data.detail || `Server error: ${startRes.status}`);
      }

      const { task_id } = await startRes.json();

      await new Promise((resolve, reject) => {
        const es = new EventSource(`${API_BASE}/api/progress/${task_id}`);
        eventSourceRef.current = es;

        es.onmessage = (event) => {
          const data = JSON.parse(event.data);

          if (data.error) {
            es.close();
            reject(new Error(data.error));
            return;
          }

          setDlStatus(data.status);
          setDlProgress(data.progress);
          setDlSpeed(data.speed);
          setDlEta(data.eta);

          if (data.status === "done") {
            es.close();
            resolve(task_id);
          }
        };

        es.onerror = () => {
          es.close();
          reject(new Error("Lost connection to server."));
        };
      });

      setDlStatus("saving");
      const fileRes = await fetch(`${API_BASE}/api/file/${task_id}`);
      if (!fileRes.ok) {
        const data = await fileRes.json().catch(() => ({}));
        throw new Error(data.detail || "Failed to retrieve file.");
      }

      const blob = await fileRes.blob();
      const disposition = fileRes.headers.get("Content-Disposition") || "";
      const match = disposition.match(/filename="?([^"]+)"?/);
      const filename = match
        ? match[1]
        : `download.${downloadMode === "audio" ? "mp3" : "mp4"}`;

      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(a.href);

      setDlStatus("complete");
      setTimeout(() => setDlStatus(null), 3000);
    } catch (err) {
      setError(err.message || "Download failed.");
      setDlStatus(null);
    } finally {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    }
  }, [videoInfo, selectedFormat, downloadMode, url]);

  const handleReset = () => {
    setUrl("");
    setVideoInfo(null);
    setSelectedFormat(null);
    setError("");
    setDownloadMode("video");
    setDlStatus(null);
  };

  const displayFormats =
    downloadMode === "audio"
      ? videoInfo?.audioFormats || []
      : videoInfo?.videoFormats || [];

  const isBusy = dlStatus !== null && dlStatus !== "complete";

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-950 via-gray-900 to-indigo-950 px-4 py-8 sm:py-12">
      <div className="mx-auto max-w-4xl">
        <h1 className="mb-1 text-center text-2xl sm:text-3xl font-bold tracking-tight text-white">
          Video Downloader
        </h1>
        <p className="mb-8 sm:mb-10 text-center text-xs sm:text-sm text-gray-400">
          Universal downloader &mdash; YouTube, Facebook, TikTok, Instagram, X &
          1000+ sites
        </p>

        {/* Search */}
        <form
          onSubmit={handleAnalyze}
          className="mx-auto mb-8 sm:mb-10 max-w-2xl"
        >
          <div className="glass rounded-2xl p-1">
            <div className="flex items-center gap-2 rounded-xl bg-white/5 px-3 sm:px-4 py-2.5 sm:py-3">
              <svg
                className="h-5 w-5 shrink-0 text-gray-400"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"
                />
              </svg>
              <input
                type="text"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="Paste video URL here..."
                className="flex-1 min-w-0 bg-transparent text-sm text-white placeholder-gray-500 outline-none"
                disabled={analyzing || isBusy}
              />
              {videoInfo && (
                <button
                  type="button"
                  onClick={handleReset}
                  disabled={isBusy}
                  className="shrink-0 text-xs text-gray-500 hover:text-gray-300 disabled:opacity-40"
                >
                  Clear
                </button>
              )}
              <button
                type="submit"
                disabled={analyzing || !url.trim() || isBusy}
                className="shrink-0 rounded-lg bg-indigo-600 px-3 sm:px-5 py-2 text-xs sm:text-sm font-medium text-white transition hover:bg-indigo-500 disabled:opacity-40"
              >
                {analyzing ? "Analyzing..." : "Analyze"}
              </button>
            </div>
          </div>
        </form>

        {/* Error */}
        {error && (
          <div className="mx-auto max-w-2xl mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300 backdrop-blur-sm">
            <div className="flex items-start justify-between gap-2">
              <span className="break-words">{error}</span>
              <button
                onClick={() => setError("")}
                className="shrink-0 text-red-400 hover:text-red-200"
              >
                ✕
              </button>
            </div>
          </div>
        )}

        {/* Analyzing spinner */}
        {analyzing && (
          <div className="flex flex-col items-center justify-center gap-3 py-16">
            <div className="h-10 w-10 animate-spin rounded-full border-4 border-white/20 border-t-indigo-400" />
            <p className="text-sm text-gray-400">Fetching video info...</p>
          </div>
        )}

        {/* Download progress overlay */}
        {isBusy && (
          <div className="mx-auto max-w-2xl glass rounded-2xl p-5 sm:p-6 mb-6">
            <StepIndicator
              currentStep={
                dlStatus === "queued"
                  ? "analyzing"
                  : dlStatus === "downloading"
                  ? "downloading"
                  : dlStatus === "merging"
                  ? "merging"
                  : "analyzing"
              }
            />
            {dlStatus === "downloading" && (
              <div className="mt-2">
                <ProgressBar progress={dlProgress} speed={dlSpeed} eta={dlEta} />
              </div>
            )}
            {dlStatus === "merging" && (
              <p className="text-center text-xs text-indigo-300 mt-2 animate-pulse">
                ffmpeg is combining video + audio streams...
              </p>
            )}
            {dlStatus === "saving" && (
              <p className="text-center text-xs text-green-300 mt-2">
                Merged file ready. Saving to your device...
              </p>
            )}
          </div>
        )}

        {/* Results */}
        {videoInfo && !analyzing && (
          <div className="glass rounded-2xl p-4 sm:p-6">
            <div className="flex flex-col sm:flex-row gap-4 sm:gap-6">
              {/* Thumbnail */}
              <div className="shrink-0 sm:w-72">
                {videoInfo.thumbnail ? (
                  <img
                    src={videoInfo.thumbnail}
                    alt={videoInfo.title}
                    className="w-full rounded-xl object-cover aspect-video"
                  />
                ) : (
                  <div className="flex h-40 w-full items-center justify-center rounded-xl bg-white/5 text-gray-500">
                    No preview
                  </div>
                )}
                <h2 className="mt-3 text-sm sm:text-base font-semibold text-white leading-snug line-clamp-2">
                  {videoInfo.title}
                </h2>
                <p className="mt-1 text-xs text-gray-400">
                  {formatDuration(videoInfo.duration)} &middot;{" "}
                  {videoInfo.formats.length} formats
                </p>
              </div>

              {/* Right panel */}
              <div className="flex-1 min-w-0">
                {/* Mode tabs */}
                <div className="flex gap-2 mb-3">
                  <button
                    onClick={() => {
                      if (isBusy) return;
                      setDownloadMode("video");
                      setSelectedFormat(videoInfo.bestVideo);
                    }}
                    className={`flex-1 sm:flex-none rounded-lg px-4 py-2 text-xs sm:text-sm font-medium transition ${
                      downloadMode === "video"
                        ? "bg-indigo-600 text-white"
                        : "bg-white/5 text-gray-400 hover:bg-white/10"
                    }`}
                  >
                    Video
                  </button>
                  <button
                    onClick={() => {
                      if (isBusy) return;
                      setDownloadMode("audio");
                    }}
                    className={`flex-1 sm:flex-none rounded-lg px-4 py-2 text-xs sm:text-sm font-medium transition ${
                      downloadMode === "audio"
                        ? "bg-indigo-600 text-white"
                        : "bg-white/5 text-gray-400 hover:bg-white/10"
                    }`}
                  >
                    Audio Only
                  </button>
                </div>

                {/* Format list */}
                <h3 className="mb-2 text-xs sm:text-sm font-medium text-gray-300">
                  {downloadMode === "audio" ? "Audio Formats" : "Video Formats"}
                </h3>
                <div className="max-h-64 sm:max-h-80 space-y-1.5 sm:space-y-2 overflow-y-auto pr-1">
                  {displayFormats.length === 0 && (
                    <p className="text-xs text-gray-500 py-4 text-center">
                      No {downloadMode} formats available for this video.
                    </p>
                  )}
                  {downloadMode === "video"
                    ? displayFormats.map((fmt) => (
                        <button
                          key={fmt.format_id}
                          onClick={() => {
                            if (!isBusy) setSelectedFormat(fmt.format_id);
                          }}
                          disabled={isBusy}
                          className={`w-full rounded-lg border px-3 sm:px-4 py-2.5 sm:py-3 text-left text-xs sm:text-sm transition disabled:opacity-50 ${
                            selectedFormat === fmt.format_id
                              ? "border-indigo-500/50 bg-indigo-500/10"
                              : "border-white/5 bg-white/[0.03] hover:bg-white/[0.06]"
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-medium text-white truncate">
                              {fmt.resolution}
                            </span>
                            <div className="flex items-center gap-2 shrink-0">
                              {fmt.fps && (
                                <span className="text-xs text-gray-500">
                                  {fmt.fps}fps
                                </span>
                              )}
                              {fmt.filesize && (
                                <span className="text-xs text-gray-400">
                                  {formatSize(fmt.filesize)}
                                </span>
                              )}
                              <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] sm:text-xs font-medium text-gray-300 uppercase">
                                {fmt.ext}
                              </span>
                            </div>
                          </div>
                          {fmt.note && (
                            <p className="mt-1 text-[10px] text-gray-500">
                              {fmt.note}
                            </p>
                          )}
                        </button>
                      ))
                    : displayFormats.map((fmt) => (
                        <div
                          key={fmt.format_id}
                          className="w-full rounded-lg border border-white/5 bg-white/[0.03] px-3 sm:px-4 py-2.5 sm:py-3"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-medium text-white text-xs sm:text-sm truncate">
                              {fmt.resolution}
                            </span>
                            <div className="flex items-center gap-2 shrink-0">
                              {fmt.filesize && (
                                <span className="text-xs text-gray-400">
                                  {formatSize(fmt.filesize)}
                                </span>
                              )}
                              <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] sm:text-xs font-medium text-gray-300 uppercase">
                                {fmt.ext}
                              </span>
                            </div>
                          </div>
                        </div>
                      ))}
                </div>

                {/* Download button */}
                <button
                  onClick={handleDownload}
                  disabled={isBusy || displayFormats.length === 0}
                  className="mt-3 sm:mt-4 w-full rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 px-6 py-3 text-sm font-semibold text-white transition hover:from-indigo-500 hover:to-purple-500 active:scale-[0.98] disabled:opacity-40"
                >
                  {isBusy ? (
                    <span className="flex items-center justify-center gap-2">
                      <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                      {dlStatus === "downloading"
                        ? `Downloading... ${dlProgress || ""}`
                        : dlStatus === "merging"
                        ? "Merging..."
                        : dlStatus === "saving"
                        ? "Saving..."
                        : "Preparing..."}
                    </span>
                  ) : dlStatus === "complete" ? (
                    <span className="flex items-center justify-center gap-2">
                      <svg className="h-5 w-5 text-green-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                      Done!
                    </span>
                  ) : downloadMode === "audio" ? (
                    "Download Audio"
                  ) : (
                    "Download Video"
                  )}
                </button>
              </div>
            </div>
          </div>
        )}

        <p className="mt-8 sm:mt-10 text-center text-xs text-gray-600">
          For educational purposes only. Respect content creators' rights.
        </p>
      </div>
    </div>
  );
}
