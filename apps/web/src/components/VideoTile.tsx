'use client';
import { useEffect, useRef } from 'react';

interface VideoTileProps {
  stream: MediaStream;
  label: string;
  muted?: boolean;
  videoActive?: boolean;
  speaking?: boolean;
  pinned?: boolean;
  onTogglePin?: () => void;
}

/**
 * Derives up to two initials from a display name.
 * @param {string} name Display name.
 * @returns {string} Initials.
 */
function initials(name: string): string {
  return name.split(/\s+/).map((part) => part[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
}

/**
 * Renders a participant's stream. The video element is always mounted (so
 * audio keeps flowing); when video is not active a placeholder overlays it.
 * @param {VideoTileProps} props Component props (destructured in body).
 * @returns {JSX.Element} The video tile.
 */
export default function VideoTile(props: VideoTileProps) {
  const { stream, label, muted, videoActive = true, speaking, pinned, onTogglePin } = props;
  const videoRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (videoRef.current && videoRef.current.srcObject !== stream) {
      videoRef.current.srcObject = stream;
    }
  }, [stream]);
  const className = `tile${speaking ? ' speaking' : ''}${pinned ? ' pinned' : ''}`;
  return (
    <div className={className} onClick={onTogglePin}>
      <video ref={videoRef} autoPlay playsInline muted={muted} />
      {!videoActive && <div className="placeholder">{initials(label)}</div>}
      <span className="tile-label">
        {label}
        {pinned ? ' 📌' : ''}
      </span>
    </div>
  );
}
