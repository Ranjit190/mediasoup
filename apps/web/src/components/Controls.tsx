'use client';

interface ControlsProps {
  micEnabled: boolean;
  camEnabled: boolean;
  screenSharing: boolean;
  onToggleMic: () => void;
  onToggleCam: () => void;
  onToggleScreen: () => void;
  onLeave: () => void;
}

/**
 * Bottom control bar: mic, camera, screen share, and leave.
 * @param {ControlsProps} props Component props (destructured in body).
 * @returns {JSX.Element} The control bar.
 */
export default function Controls(props: ControlsProps) {
  const { micEnabled, camEnabled, screenSharing, onToggleMic, onToggleCam, onToggleScreen, onLeave } = props;
  return (
    <div className="controls">
      <button className={micEnabled ? 'btn' : 'btn off'} onClick={onToggleMic}>
        {micEnabled ? '🎤 Mute' : '🔇 Unmute'}
      </button>
      <button className={camEnabled ? 'btn' : 'btn off'} onClick={onToggleCam}>
        {camEnabled ? '📹 Stop video' : '📷 Start video'}
      </button>
      <button className={screenSharing ? 'btn active' : 'btn'} onClick={onToggleScreen}>
        {screenSharing ? '🛑 Stop share' : '🖥️ Share screen'}
      </button>
      <button className="btn leave" onClick={onLeave}>
        ☎️ Leave
      </button>
    </div>
  );
}
