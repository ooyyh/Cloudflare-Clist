import { useState, useRef, useEffect, useCallback } from "react";
import { getFileType, formatDuration, getCodeLanguage, type FileType } from "~/lib/file-utils";

interface FilePreviewProps {
  storageId: number;
  fileKey: string;
  fileName: string;
  onClose: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  hasPrev?: boolean;
  hasNext?: boolean;
}

export function FilePreview({
  storageId,
  fileKey,
  fileName,
  onClose,
  onPrev,
  onNext,
  hasPrev,
  hasNext,
}: FilePreviewProps) {
  const fileType = getFileType(fileName);
  const fileUrl = `/api/files/${storageId}/${fileKey}?action=download`;

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      } else if (e.key === "ArrowLeft" && onPrev && hasPrev) {
        onPrev();
      } else if (e.key === "ArrowRight" && onNext && hasNext) {
        onNext();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, onPrev, onNext, hasPrev, hasNext]);

  return (
    <div
      className="fixed inset-0 bg-black/90 flex flex-col z-50"
      onClick={onClose}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-3 bg-black/50"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 min-w-0">
          <span className="text-white font-mono text-sm truncate">{fileName}</span>
        </div>
        <div className="flex items-center gap-2">
          <a
            href={fileUrl}
            download={fileName}
            className="text-zinc-400 hover:text-white text-sm font-mono px-3 py-1 border border-zinc-700 hover:border-zinc-500 rounded transition"
            onClick={(e) => e.stopPropagation()}
          >
            下载
          </a>
          <button
            onClick={onClose}
            className="text-zinc-400 hover:text-white text-2xl px-2"
          >
            ×
          </button>
        </div>
      </div>

      {/* Content */}
      <div
        className="flex-1 flex items-center justify-center overflow-hidden relative"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Navigation arrows */}
        {hasPrev && (
          <button
            onClick={onPrev}
            className="absolute left-4 top-1/2 -translate-y-1/2 text-white/50 hover:text-white text-4xl z-10 p-2"
          >
            ‹
          </button>
        )}
        {hasNext && (
          <button
            onClick={onNext}
            className="absolute right-4 top-1/2 -translate-y-1/2 text-white/50 hover:text-white text-4xl z-10 p-2"
          >
            ›
          </button>
        )}

        {/* Preview content */}
        <div className="w-full h-full flex items-center justify-center p-4">
          {fileType === "video" && <VideoPlayer url={fileUrl} />}
          {fileType === "audio" && <AudioPlayer url={fileUrl} fileName={fileName} />}
          {fileType === "image" && <ImageViewer url={fileUrl} fileName={fileName} />}
          {(fileType === "text" || fileType === "code") && (
            <TextViewer url={fileUrl} fileName={fileName} />
          )}
          {fileType === "pdf" && <PDFViewer url={fileUrl} />}
          {fileType === "unknown" && (
            <div className="text-zinc-400 font-mono text-center">
              <p className="text-lg mb-2">无法预览此文件类型</p>
              <a
                href={fileUrl}
                download={fileName}
                className="text-blue-400 hover:text-blue-300 underline"
              >
                点击下载
              </a>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Video Player Component
function VideoPlayer({ url }: { url: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [showControls, setShowControls] = useState(true);
  const controlsTimeoutRef = useRef<number | null>(null);

  const togglePlay = useCallback(() => {
    if (videoRef.current) {
      if (isPlaying) {
        videoRef.current.pause();
      } else {
        videoRef.current.play();
      }
    }
  }, [isPlaying]);

  const handleTimeUpdate = () => {
    if (videoRef.current) {
      setCurrentTime(videoRef.current.currentTime);
    }
  };

  const handleLoadedMetadata = () => {
    if (videoRef.current) {
      setDuration(videoRef.current.duration);
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const time = parseFloat(e.target.value);
    if (videoRef.current) {
      videoRef.current.currentTime = time;
      setCurrentTime(time);
    }
  };

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const vol = parseFloat(e.target.value);
    setVolume(vol);
    if (videoRef.current) {
      videoRef.current.volume = vol;
    }
  };

  const toggleFullscreen = () => {
    if (videoRef.current) {
      if (document.fullscreenElement) {
        document.exitFullscreen();
      } else {
        videoRef.current.requestFullscreen();
      }
    }
  };

  const handleMouseMove = () => {
    setShowControls(true);
    if (controlsTimeoutRef.current) {
      clearTimeout(controlsTimeoutRef.current);
    }
    controlsTimeoutRef.current = window.setTimeout(() => {
      if (isPlaying) setShowControls(false);
    }, 3000);
  };

  useEffect(() => {
    return () => {
      if (controlsTimeoutRef.current) {
        clearTimeout(controlsTimeoutRef.current);
      }
    };
  }, []);

  return (
    <div
      className="relative max-w-full max-h-full flex items-center justify-center"
      onMouseMove={handleMouseMove}
    >
      <video
        ref={videoRef}
        src={url}
        className="max-w-full max-h-[calc(100vh-200px)] rounded"
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={handleLoadedMetadata}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onClick={togglePlay}
      />

      {/* Controls overlay */}
      <div
        className={`absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent p-4 transition-opacity ${
          showControls ? 'opacity-100' : 'opacity-0'
        }`}
      >
        {/* Progress bar */}
        <input
          type="range"
          min="0"
          max={duration || 100}
          value={currentTime}
          onChange={handleSeek}
          className="w-full h-1 bg-zinc-600 rounded-full appearance-none cursor-pointer mb-3
            [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3
            [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:cursor-pointer"
        />

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            {/* Play/Pause */}
            <button onClick={togglePlay} className="text-white text-xl">
              {isPlaying ? "⏸" : "▶"}
            </button>

            {/* Time */}
            <span className="text-white text-xs font-mono">
              {formatDuration(currentTime)} / {formatDuration(duration)}
            </span>
          </div>

          <div className="flex items-center gap-3">
            {/* Volume */}
            <div className="flex items-center gap-2">
              <span className="text-white text-sm">{volume === 0 ? "🔇" : volume < 0.5 ? "🔉" : "🔊"}</span>
              <input
                type="range"
                min="0"
                max="1"
                step="0.1"
                value={volume}
                onChange={handleVolumeChange}
                className="w-20 h-1 bg-zinc-600 rounded-full appearance-none cursor-pointer
                  [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-2 [&::-webkit-slider-thumb]:h-2
                  [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:rounded-full"
              />
            </div>

            {/* Fullscreen */}
            <button onClick={toggleFullscreen} className="text-white text-sm">
              ⛶
            </button>
          </div>
        </div>
      </div>

      {/* Center play button */}
      {!isPlaying && (
        <button
          onClick={togglePlay}
          className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2
            w-16 h-16 bg-black/50 rounded-full flex items-center justify-center text-white text-3xl
            hover:bg-black/70 transition"
        >
          ▶
        </button>
      )}
    </div>
  );
}

// Audio Player Component
function AudioPlayer({ url, fileName }: { url: string; fileName: string }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);

  const togglePlay = () => {
    if (audioRef.current) {
      if (isPlaying) {
        audioRef.current.pause();
      } else {
        audioRef.current.play();
      }
    }
  };

  const handleTimeUpdate = () => {
    if (audioRef.current) {
      setCurrentTime(audioRef.current.currentTime);
    }
  };

  const handleLoadedMetadata = () => {
    if (audioRef.current) {
      setDuration(audioRef.current.duration);
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const time = parseFloat(e.target.value);
    if (audioRef.current) {
      audioRef.current.currentTime = time;
      setCurrentTime(time);
    }
  };

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const vol = parseFloat(e.target.value);
    setVolume(vol);
    if (audioRef.current) {
      audioRef.current.volume = vol;
    }
  };

  return (
    <div className="w-full max-w-lg bg-zinc-900 border border-zinc-700 rounded-lg p-6">
      <audio
        ref={audioRef}
        src={url}
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={handleLoadedMetadata}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onEnded={() => setIsPlaying(false)}
      />

      {/* Album art placeholder */}
      <div className="w-32 h-32 mx-auto mb-6 bg-zinc-800 rounded-lg flex items-center justify-center">
        <span className="text-5xl">🎵</span>
      </div>

      {/* File name */}
      <div className="text-center mb-6">
        <p className="text-white font-mono text-sm truncate">{fileName}</p>
      </div>

      {/* Progress bar */}
      <div className="mb-4">
        <input
          type="range"
          min="0"
          max={duration || 100}
          value={currentTime}
          onChange={handleSeek}
          className="w-full h-1 bg-zinc-700 rounded-full appearance-none cursor-pointer
            [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3
            [&::-webkit-slider-thumb]:bg-blue-500 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:cursor-pointer"
        />
        <div className="flex justify-between text-xs text-zinc-400 mt-1 font-mono">
          <span>{formatDuration(currentTime)}</span>
          <span>{formatDuration(duration)}</span>
        </div>
      </div>

      {/* Controls */}
      <div className="flex items-center justify-center gap-6">
        {/* Play/Pause */}
        <button
          onClick={togglePlay}
          className="w-14 h-14 bg-blue-600 hover:bg-blue-500 rounded-full flex items-center justify-center text-white text-2xl transition"
        >
          {isPlaying ? "⏸" : "▶"}
        </button>
      </div>

      {/* Volume */}
      <div className="flex items-center justify-center gap-2 mt-6">
        <span className="text-zinc-400 text-sm">{volume === 0 ? "🔇" : volume < 0.5 ? "🔉" : "🔊"}</span>
        <input
          type="range"
          min="0"
          max="1"
          step="0.1"
          value={volume}
          onChange={handleVolumeChange}
          className="w-24 h-1 bg-zinc-700 rounded-full appearance-none cursor-pointer
            [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-2 [&::-webkit-slider-thumb]:h-2
            [&::-webkit-slider-thumb]:bg-blue-500 [&::-webkit-slider-thumb]:rounded-full"
        />
      </div>
    </div>
  );
}

// Image Viewer Component
function ImageViewer({ url, fileName }: { url: string; fileName: string }) {
  const [scale, setScale] = useState(1);
  const [loading, setLoading] = useState(true);

  const zoomIn = () => setScale((s) => Math.min(s + 0.25, 3));
  const zoomOut = () => setScale((s) => Math.max(s - 0.25, 0.5));
  const resetZoom = () => setScale(1);

  return (
    <div className="flex flex-col items-center max-h-full">
      {/* Zoom controls */}
      <div className="flex items-center gap-2 mb-4 bg-black/50 rounded-lg px-3 py-2">
        <button onClick={zoomOut} className="text-white px-2 hover:text-blue-400">−</button>
        <span className="text-white text-sm font-mono w-16 text-center">{Math.round(scale * 100)}%</span>
        <button onClick={zoomIn} className="text-white px-2 hover:text-blue-400">+</button>
        <button onClick={resetZoom} className="text-zinc-400 text-xs ml-2 hover:text-white">重置</button>
      </div>

      {/* Image */}
      <div className="overflow-auto max-w-full max-h-[calc(100vh-200px)]">
        {loading && (
          <div className="flex items-center justify-center w-64 h-64">
            <span className="text-zinc-400 font-mono">加载中...</span>
          </div>
        )}
        <img
          src={url}
          alt={fileName}
          className="transition-transform"
          style={{ transform: `scale(${scale})`, display: loading ? 'none' : 'block' }}
          onLoad={() => setLoading(false)}
        />
      </div>
    </div>
  );
}

// Text Viewer Component
function TextViewer({ url, fileName }: { url: string; fileName: string }) {
  const [content, setContent] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>("");
  const language = getCodeLanguage(fileName);

  useEffect(() => {
    const fetchContent = async () => {
      try {
        setLoading(true);
        const res = await fetch(url);
        if (!res.ok) throw new Error("Failed to fetch file");
        const text = await res.text();
        setContent(text);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load file");
      } finally {
        setLoading(false);
      }
    };

    fetchContent();
  }, [url]);

  if (loading) {
    return (
      <div className="flex items-center justify-center w-full h-64">
        <span className="text-zinc-400 font-mono">加载中...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center w-full h-64">
        <span className="text-red-400 font-mono">{error}</span>
      </div>
    );
  }

  return (
    <div className="w-full max-w-5xl max-h-[calc(100vh-150px)] bg-zinc-900 border border-zinc-700 rounded-lg overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 bg-zinc-800 border-b border-zinc-700">
        <span className="text-zinc-400 text-xs font-mono">{language}</span>
        <span className="text-zinc-500 text-xs font-mono">{content.split('\n').length} 行</span>
      </div>

      {/* Content */}
      <div className="overflow-auto max-h-[calc(100vh-200px)]">
        <pre className="p-4 text-sm font-mono text-zinc-300 whitespace-pre-wrap break-words">
          <code>{content}</code>
        </pre>
      </div>
    </div>
  );
}

// PDF Viewer Component
function PDFViewer({ url }: { url: string }) {
  return (
    <div className="w-full h-full max-w-5xl max-h-[calc(100vh-100px)]">
      <iframe
        src={url}
        className="w-full h-full bg-white rounded-lg"
        title="PDF Viewer"
      />
    </div>
  );
}
