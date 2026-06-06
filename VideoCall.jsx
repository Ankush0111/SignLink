import React, { useState, useEffect, useRef, useCallback } from 'react';
import { io } from 'socket.io-client';
import { useNavigate, useLocation } from 'react-router-dom';
import Peer from 'simple-peer';
import { GestureRecognizer, FilesetResolver } from '@mediapipe/tasks-vision';
import '../style.css';

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const SOCKET_URL = 'http://localhost:5000';

const ICE_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

const GESTURE_ICONS = {
  'Closed_Fist':      '✊',
  'Open_Palm':        '🖐️',
  'Pointing_Up':      '☝️',
  'Thumb_Up':         '👍',
  'Thumb_Down':       '👎',
  'Victory':          '✌️',
  'ILoveYou':         '🤟',
  'Space':            '⏹️', 
  'None':             '🤚',
};

const prettifyGesture = (raw) =>
  raw.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

// ─── VideoNode ────────────────────────────────────────────────────────────────
const VideoNode = React.memo(({ peer, name }) => {
  const vidRef = useRef();

  useEffect(() => {
    if (!peer) return;
    const attach = (stream) => {
      if (!vidRef.current || vidRef.current.srcObject === stream) return;
      vidRef.current.srcObject = stream;
      vidRef.current.play().catch(() => {});
    };
    if (peer.streams?.[0]) attach(peer.streams[0]);
    peer.on('stream', attach);
    return () => peer.off('stream', attach);
  }, [peer]);

  return (
    <div className="participant-card active-speaker">
      <div className="remote-video-wrap">
        <video ref={vidRef} autoPlay playsInline />
      </div>
      <span className="participant-name">{name}</span>
      <div className="participant-status active" />
    </div>
  );
});

// ─── Main component ───────────────────────────────────────────────────────────
const VideoCall = () => {
  const navigate = useNavigate();
  const location = useLocation();

  const [currentRoomId] = useState(() => {
    const p = new URLSearchParams(location.search);
    return p.get('room') || 'RM-' + Math.random().toString(36).slice(2, 6).toUpperCase();
  });

  const [isRunning,      setIsRunning]      = useState(false);
  const [currentGesture, setCurrentGesture] = useState('None');
  const [confidence,     setConfidence]     = useState('—');
  const [historyFeed,    setHistoryFeed]    = useState([]);
  const [chatMessage,    setChatMessage]    = useState('');
  const [stats,          setStats]          = useState({ count: 0, totalConf: 0, freq: {} });
  const [activePeers,    setActivePeers]    = useState([]);
  const [linkCopied,     setLinkCopied]     = useState(false);
  const [modelStatus,    setModelStatus]    = useState('idle');
  
  const [accumulatedWord, setAccumulatedWord] = useState('');

  const localVidRef      = useRef(null);
  const canvasRef        = useRef(null);
  const streamRef        = useRef(null);
  const socketRef        = useRef(null);
  const rafRef           = useRef(null);       
  const isRunningRef     = useRef(false);
  const historyRef       = useRef([]);
  const peersRef         = useRef(new Map());
  const gestureRef       = useRef(null);       
  const lastGestureRef   = useRef('None');
  const lastVideoTimeRef = useRef(-1);
  
  // Throttle tracking reference: Limits predictions to 1 per second
  const lastProcessingTimeRef = useRef(0);
  const wordBufferRef    = useRef('');

  const userName = localStorage.getItem('userName') || 'User';

  useEffect(() => { historyRef.current = historyFeed; }, [historyFeed]);

  // ── Load MediaPipe model ─────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    const loadModel = async () => {
      try {
        setModelStatus('loading');
        const vision = await FilesetResolver.forVisionTasks(
          'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm'
        );
        const recognizer = await GestureRecognizer.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: '/gesture_recognizer.task',
            delegate: 'GPU',   
          },
          runningMode: 'VIDEO',
          numHands: 1,
          minHandDetectionConfidence: 0.5,
          minHandPresenceConfidence: 0.5,
          minTrackingConfidence: 0.5,
        });

        if (cancelled) { recognizer.close(); return; }
        gestureRef.current = recognizer;
        setModelStatus('ready');
      } catch (err) {
        console.error('[MediaPipe] model load failed:', err);
        setModelStatus('error');
      }
    };
    loadModel();
    return () => { cancelled = true; };
  }, []);

  // ── Broadcast Completed Sign Words ────────────────────────────────────────
  const dispatchSignWord = useCallback(() => {
    const finalWord = wordBufferRef.current.trim();
    if (!finalWord) return;

    const ts = new Date().toLocaleTimeString('en-US', { hour12: false });

    if (socketRef.current) {
      socketRef.current.emit('chatMessage', { 
        roomId: currentRoomId, 
        msg: `[Sign] ${finalWord}`, 
        senderName: userName 
      });
    }

    setHistoryFeed(prev => [
      { id: Date.now(), type: 'chat', icon: '🤟', text: `You (Sign): ${finalWord}`, meta: ts },
      ...prev.slice(0, 49)
    ]);

    wordBufferRef.current = '';
    setAccumulatedWord('');
  }, [currentRoomId, userName]);

  // ── Push characters or process Space triggers ───────────────────────────
  const processLiveGesture = useCallback((sign, confStr) => {
    const rawSign = sign.replace(/ /g, '_');
    
    if (rawSign.toLowerCase() === 'space') {
      dispatchSignWord();
      return;
    }

    if (rawSign === 'None') return;

    let characterToken = sign;
    if (sign.length > 2) {
      characterToken = sign.charAt(0).toUpperCase(); 
    }

    wordBufferRef.current += characterToken;
    setAccumulatedWord(wordBufferRef.current);

    const confNum = parseFloat(confStr);
    setStats(prev => ({
      count: prev.count + 1,
      totalConf: prev.totalConf + (isNaN(confNum) ? 0 : confNum),
      freq: { ...prev.freq, [sign]: (prev.freq[sign] || 0) + 1 },
    }));
  }, [dispatchSignWord]);

  // ── MediaPipe inference loop with 1-Second Throttler ─────────────────────
  const runGestureLoop = useCallback(() => {
    if (!isRunningRef.current) return;
    const video = localVidRef.current;
    const recognizer = gestureRef.current;

    const now = performance.now();
    // 1000ms ensures exactly 1 processing run per second
    const timeDelta = now - lastProcessingTimeRef.current; 

    if (
      recognizer && 
      video && 
      video.readyState >= 2 && 
      video.currentTime !== lastVideoTimeRef.current &&
      timeDelta >= 500 
    ) {
      lastVideoTimeRef.current = video.currentTime;
      lastProcessingTimeRef.current = now; 

      try {
        const results = recognizer.recognizeForVideo(video, Date.now());
        if (results.gestures && results.gestures.length > 0) {
          let bestGesture = null;
          let bestScore   = 0;
          results.gestures.forEach(handGestures => {
            if (handGestures.length > 0 && handGestures[0].score > bestScore) {
              bestScore   = handGestures[0].score;
              bestGesture = handGestures[0].categoryName;
            }
          });

          if (bestGesture) {
            const pretty = prettifyGesture(bestGesture);
            const confStr = bestScore.toFixed(2);
            setCurrentGesture(pretty);
            setConfidence(confStr);

            if (bestGesture !== lastGestureRef.current) {
              lastGestureRef.current = bestGesture;
              processLiveGesture(pretty, confStr);
            }
            drawLandmarks(results);
          } else {
            setCurrentGesture('None');
            clearCanvas();
          }
        } else {
          setCurrentGesture('None');
          clearCanvas();
        }
      } catch (err) {}
    }
    rafRef.current = requestAnimationFrame(runGestureLoop);
  }, [processLiveGesture]);

  const drawLandmarks = (results) => {
    const canvas = canvasRef.current;
    const video  = localVidRef.current;
    if (!canvas || !video) return;
    canvas.width  = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!results.landmarks) return;

    const CONNECTIONS = [
      [0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],
      [0,9],[9,10],[10,11],[11,12],[0,13],[13,14],[14,15],[15,16],
      [0,17],[17,18],[18,19],[19,20],[5,9],[9,13],[13,17],
    ];

    results.landmarks.forEach(landmarks => {
      ctx.strokeStyle = 'rgba(0, 212, 255, 0.8)';
      ctx.lineWidth   = 2;
      CONNECTIONS.forEach(([a, b]) => {
        ctx.beginPath();
        ctx.moveTo(landmarks[a].x * canvas.width, landmarks[a].y * canvas.height);
        ctx.lineTo(landmarks[b].x * canvas.width, landmarks[b].y * canvas.height);
        ctx.stroke();
      });
      landmarks.forEach((lm, i) => {
        ctx.beginPath();
        ctx.arc(lm.x * canvas.width, lm.y * canvas.height, i === 0 ? 6 : 4, 0, Math.PI * 2);
        ctx.fillStyle = i === 0 ? '#3a8ef6' : '#00e5a0';
        ctx.fill();
      });
    });
  };

  const clearCanvas = () => {
    const canvas = canvasRef.current;
    if (canvas) canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
  };

  const syncPeers = useCallback(() => {
    const list = [];
    peersRef.current.forEach(({ peer, name: n }, id) => {
      list.push({ peerId: id, peer, name: n });
    });
    setActivePeers([...list]);
  }, []);

  const makePeer = useCallback(({ remoteId, initiator, stream, incomingSignal }) => {
    const peer = new Peer({ initiator, trickle: true, stream, config: ICE_CONFIG });
    peer.on('signal', signal => {
      socketRef.current?.emit('signal', { to: remoteId, signal });
    });
    peer.on('stream',  () => syncPeers());
    peer.on('connect', () => syncPeers());
    peer.on('close',   () => { peersRef.current.delete(remoteId); syncPeers(); });
    peer.on('error',   err => console.warn('[peer error]', err.message));

    if (!initiator && incomingSignal) peer.signal(incomingSignal);
    return peer;
  }, [syncPeers]);

  const startCamera = async () => {
    if (isRunningRef.current) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      streamRef.current = stream;

      if (localVidRef.current) {
        localVidRef.current.srcObject = stream;
        await localVidRef.current.play().catch(() => {});
      }

      isRunningRef.current = true;
      setIsRunning(true);

      if (gestureRef.current) {
        rafRef.current = requestAnimationFrame(runGestureLoop);
      }

      const socket = io(SOCKET_URL, { transports: ['websocket'], reconnection: false });
      socketRef.current = socket;

      socket.on('connect', () => {
        socket.emit('joinRoom', { roomId: currentRoomId, userName });
      });

      socket.on('chatMessage', ({ msg, senderName }) => {
        const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
        setHistoryFeed(prev => [
          { id: Date.now(), type: 'chat', icon: '💬', text: `${senderName}: ${msg}`, meta: ts },
          ...prev.slice(0, 49)
        ]);
      });

      socket.on('allUsers', users => {
        users.forEach(user => {
          if (peersRef.current.has(user.id)) return;
          const peer = makePeer({ remoteId: user.id, initiator: true, stream: streamRef.current });
          peersRef.current.set(user.id, { peer, name: user.name });
        });
      });

      socket.on('userJoined', ({ id, name }) => {
        if (!peersRef.current.has(id)) peersRef.current.set(id, { peer: null, name });
      });

      socket.on('signal', ({ from, signal }) => {
        let record = peersRef.current.get(from);
        if (!record || !record.peer) {
          const peer = makePeer({
            remoteId: from,
            initiator: false,
            stream: streamRef.current,
            incomingSignal: signal,
          });
          peersRef.current.set(from, { peer, name: record?.name || 'Peer' });
        } else {
          try { record.peer.signal(signal); } catch (e) {}
        }
      });

      socket.on('userLeft', id => {
        const r = peersRef.current.get(id);
        if (r?.peer) r.peer.destroy();
        peersRef.current.delete(id);
        syncPeers();
      });

    } catch (err) {
      console.error('[startCamera]', err);
    }
  };

  const stopCamera = useCallback(() => {
    isRunningRef.current = false;
    setIsRunning(false);
    setCurrentGesture('None');
    setConfidence('—');
    lastGestureRef.current = 'None';
    cancelAnimationFrame(rafRef.current);
    clearCanvas();

    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    if (localVidRef.current) localVidRef.current.srcObject = null;

    peersRef.current.forEach(({ peer }) => peer?.destroy());
    peersRef.current.clear();
    setActivePeers([]);

    socketRef.current?.disconnect();
    socketRef.current = null;
  }, []);

  const copyInviteLink = () => {
    navigator.clipboard.writeText(`${window.location.origin}/workspace?room=${currentRoomId}`)
      .then(() => { setLinkCopied(true); setTimeout(() => setLinkCopied(false), 2500); });
  };

  const sendChatMessage = (e) => {
    if (e.key && e.key !== 'Enter') return;
    if (!chatMessage.trim()) return;

    const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
    
    if (socketRef.current) {
      socketRef.current.emit('chatMessage', { roomId: currentRoomId, msg: chatMessage, senderName: userName });
    }

    setHistoryFeed(prev => [
      { id: Date.now(), type: 'chat', icon: '💬', text: `You: ${chatMessage}`, meta: ts },
      ...prev.slice(0, 49)
    ]);
    setChatMessage('');
  };

  const handleLogout = () => { stopCamera(); localStorage.clear(); navigate('/login'); };

  const getTopGesture = () => {
    let top = '—', max = 0;
    Object.entries(stats.freq).forEach(([k, v]) => { if (v > max) { max = v; top = k; } });
    return top.split(' ')[0];
  };

  useEffect(() => {
    if (modelStatus === 'ready' && isRunningRef.current && !rafRef.current) {
      rafRef.current = requestAnimationFrame(runGestureLoop);
    }
  }, [modelStatus, runGestureLoop]);

  useEffect(() => () => {
    stopCamera();
    gestureRef.current?.close();
  }, []); // eslint-disable-line

  const modelBadge = {
    idle:    { color: '#7a99cc', text: 'Model: idle' },
    loading: { color: '#f5a623', text: 'Model: loading…' },
    ready:   { color: '#00e5a0', text: 'Model: ready ✓' },
    error:   { color: '#e84040', text: 'Model: load failed ✗' },
  }[modelStatus];

  return (
    <div className="app-shell">
      <section className="video-section">
        <div className="video-header">
          <div className="header-left">
            <div className="rec-dot" />
            <span className="rec-label">LIVE ROOM</span>
            <span className="session-id">{currentRoomId}</span>
            <button onClick={copyInviteLink} style={{
              marginLeft: '12px', padding: '4px 10px', borderRadius: '4px',
              fontSize: '0.7rem', cursor: 'pointer',
              backgroundColor: linkCopied ? '#2e7d32' : '#1976d2',
              color: '#fff', border: 'none', fontWeight: 'bold', transition: 'all 0.2s',
            }}>
              {linkCopied ? '✓ Copied!' : '🔗 Copy Invite Link'}
            </button>
            <span style={{
              marginLeft: '12px', fontSize: '0.65rem', fontFamily: 'var(--font-mono)',
              color: modelBadge.color, fontWeight: 600,
            }}>
              {modelBadge.text}
            </span>
          </div>
          <div className="header-title">Sign Language Interpreter Module</div>
        </div>

        <div className="main-feed-wrap">
          <video ref={localVidRef} id="webcam" autoPlay playsInline muted
            style={{ display: isRunning ? 'block' : 'none' }} />
          <canvas ref={canvasRef} id="overlay"
            style={{
              display: isRunning ? 'block' : 'none',
              position: 'absolute', inset: 0,
              width: '100%', height: '100%',
              pointerEvents: 'none',
              transform: 'scaleX(-1)',   
            }}
          />
          {!isRunning && (
            <div className="feed-placeholder">
              <div className="placeholder-text">
                {modelStatus === 'loading'
                  ? 'LOADING GESTURE MODEL…'
                  : modelStatus === 'error'
                  ? 'MODEL LOAD FAILED — CHECK CONSOLE'
                  : 'CAMERA INACTIVE · PRESS ▶️ TO START'}
              </div>
            </div>
          )}

          <div className="gesture-badge">
            <div className="gesture-icon">
              {GESTURE_ICONS[currentGesture.replace(/ /g, '_')] || GESTURE_ICONS[currentGesture] || '🤚'}
            </div>
            <div className="gesture-info">
              <span className="gesture-label">DETECTED SIGN</span>
              <span className="gesture-value">{currentGesture}</span>
            </div>
            <div className="gesture-conf">
              <span className="conf-label">BUFFER WORD</span>
              <span className="conf-value" style={{ color: 'var(--accent-cyan)' }}>
                {accumulatedWord || '—'}
              </span>
            </div>
          </div>
        </div>

        <div className="participants-row">
          <div className="participant-card active-speaker">
            <div className="remote-video-wrap local-avatar-wrap">
              <div className="participant-avatar">ME</div>
            </div>
            <span className="participant-name">{userName} (You)</span>
            <div className="participant-status active" />
          </div>
          {activePeers.map(p => (
            <VideoNode key={p.peerId} peer={p.peer} name={p.name} />
          ))}
        </div>

        <div className="control-bar">
          <button className="ctrl-btn" onClick={startCamera}
            disabled={isRunning || modelStatus === 'loading'}
            title={modelStatus === 'loading' ? 'Wait for model to load' : 'Start'}
            style={{ color: isRunning ? 'var(--accent-green)' : 'inherit' }}>▶️</button>
          <button className="ctrl-btn" onClick={stopCamera} disabled={!isRunning}>⏸️</button>
          <button className="ctrl-btn end-call" onClick={handleLogout}>❌</button>
        </div>
      </section>

      <aside className="sidebar">
        <div className="sidebar-header">
          <span className="sidebar-title">Translation & Chat Feed</span>
        </div>
        <div className="sign-feed">
          <span className="feed-heading">Activity Log</span>
          <ul className="feed-list">
            {historyFeed.length === 0
              ? <li className="feed-item placeholder"><div className="feed-text"><span className="feed-sign">Awaiting activity data…</span></div></li>
              : historyFeed.map(item => (
                <li key={item.id} className="feed-item">
                  <div className="feed-avatar" style={item.type === 'chat'
                    ? { background: 'linear-gradient(135deg, var(--accent-green), var(--navy-panel))' } : {}}>
                    {item.icon}
                  </div>
                  <div className="feed-text">
                    <span className="feed-sign">{item.text}</span>
                    <span className="feed-time">{item.meta}</span>
                  </div>
                </li>
              ))
            }
          </ul>
        </div>
        <div className="stats-strip">
          <div className="stat"><span className="stat-val">{stats.count}</span><span className="stat-key">Signs</span></div>
          <div className="stat">
            <span className="stat-val">{stats.count > 0 ? (stats.totalConf / stats.count).toFixed(2) : '—'}</span>
            <span className="stat-key">Avg Conf</span>
          </div>
          <div className="stat"><span className="stat-val">{getTopGesture()}</span><span className="stat-key">Top Sign</span></div>
        </div>
        <div className="chat-input-wrap">
          <input type="text" className="chat-input" placeholder="Type note or chat text…"
            value={chatMessage} onChange={e => setChatMessage(e.target.value)} onKeyDown={sendChatMessage} />
          <button className="send-btn" onClick={() => sendChatMessage({ key: 'Enter' })}>➡️</button>
        </div>
      </aside>
    </div>
  );
};

export default VideoCall;