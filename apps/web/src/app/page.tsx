'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Home page: collects a display name and room id, then routes to the call.
 * @returns {JSX.Element} The landing form.
 */
export default function HomePage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [room, setRoom] = useState('demo');
  /**
   * Navigates to the chosen room with the display name in the query string.
   * @returns {void}
   */
  function joinRoom(): void {
    const roomId = room.trim() || 'demo';
    const displayName = name.trim() || 'Guest';
    router.push(`/room/${encodeURIComponent(roomId)}?name=${encodeURIComponent(displayName)}`);
  }
  return (
    <div className="home">
      <h1>Join a video call</h1>
      <input placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} />
      <input placeholder="Room id" value={room} onChange={(e) => setRoom(e.target.value)} />
      <button onClick={joinRoom}>Join</button>
    </div>
  );
}
