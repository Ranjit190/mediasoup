'use client';
import { useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams, useRouter } from 'next/navigation';
import { RoomClient } from '@/lib/RoomClient';
import { getServerUrl } from '@/lib/config';
import VideoTile from '@/components/VideoTile';
import Controls from '@/components/Controls';

/**
 * Call page: instantiates a RoomClient, joins the room, and renders the
 * local tile, remote tiles, and the control bar.
 * @returns {JSX.Element} The room UI.
 */
export default function RoomPage() {
  const params = useParams<{ roomId: string }>();
  const searchParams = useSearchParams();
  const router = useRouter();
  const roomId = params.roomId;
  const displayName = searchParams.get('name') ?? 'Guest';
  const clientRef = useRef<RoomClient | null>(null);
  const [, setTick] = useState(0);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const rerender = () => setTick((value) => value + 1);
    getServerUrl().then((serverUrl) => {
      if (cancelled) return;
      const client = new RoomClient(serverUrl, roomId, displayName, rerender);
      clientRef.current = client;
      client.join().catch((err) => setError(err instanceof Error ? err.message : String(err)));
    });
    return () => {
      cancelled = true;
      clientRef.current?.leave();
      clientRef.current = null;
    };
  }, [roomId, displayName]);
  /**
   * Leaves the call and returns to the home page.
   * @returns {void}
   */
  function handleLeave(): void {
    clientRef.current?.leave();
    router.push('/');
  }
  const client = clientRef.current;
  const localStream = client?.getLocalStream();
  const remoteStreams = client?.getRemoteStreams() ?? [];
  return (
    <div className="room">
      <div className="room-header">
        Room: {roomId} {error ? `— error: ${error}` : `— ${remoteStreams.length + 1} participant(s)`}
      </div>
      <div className="grid">
        {localStream && (
          <VideoTile stream={localStream} label={`${displayName} (you)`} muted videoActive={client?.camEnabled} />
        )}
        {remoteStreams.map((remote) => (
          <VideoTile
            key={remote.peerId}
            stream={remote.stream}
            label={remote.displayName}
            videoActive={remote.videoActive}
            speaking={remote.speaking}
            pinned={remote.pinned}
            onTogglePin={() => clientRef.current?.togglePin(remote.peerId)}
          />
        ))}
      </div>
      {client && (
        <Controls
          micEnabled={client.micEnabled}
          camEnabled={client.camEnabled}
          screenSharing={client.screenSharing}
          onToggleMic={() => client.toggleMic()}
          onToggleCam={() => client.toggleCam()}
          onToggleScreen={() => void client.toggleScreen()}
          onLeave={handleLeave}
        />
      )}
    </div>
  );
}
