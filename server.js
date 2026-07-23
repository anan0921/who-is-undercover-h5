import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { Server } from "socket.io";
import { SPEECH_SECONDS, createStore, GameError, publicRoomState } from "./game.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = __dirname;
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true },
  maxHttpBufferSize: 4_000_000
});
const game = createStore();
const socketPlayers = new Map();
const speechTimers = new Map();

app.use(express.static(publicDir));

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/room/:roomCode", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

io.on("connection", (socket) => {
  socket.on("room:create", safe(socket, ({ nickname, playerId }, reply) => {
    const { room, player } = game.createRoom({ nickname, playerId });
    bindSocket(socket, room.code, player.id);
    reply?.({ ok: true, roomCode: room.code, playerId: player.id });
    broadcastRoom(room.code);
  }));

  socket.on("room:join", safe(socket, ({ roomCode, nickname, playerId }, reply) => {
    const { room, player } = game.joinRoom({ roomCode, nickname, playerId });
    bindSocket(socket, room.code, player.id);
    reply?.({ ok: true, roomCode: room.code, playerId: player.id });
    broadcastRoom(room.code);
  }));

  socket.on("game:start", safe(socket, ({ roomCode, playerId }) => {
    const room = game.startGame({ roomCode, hostId: playerId });
    broadcastRoom(room.code);
  }));

  socket.on("player:ready", safe(socket, ({ roomCode, playerId, ready }) => {
    const room = game.setReady({ roomCode, playerId, ready });
    broadcastRoom(room.code);
  }));

  socket.on("speech:next", safe(socket, ({ roomCode, playerId }) => {
    const room = game.nextSpeaker({ roomCode, hostId: playerId });
    broadcastRoom(room.code);
  }));

  socket.on("speech:submit", safe(socket, ({ roomCode, playerId, kind, text, audio }) => {
    const room = game.submitSpeech({ roomCode, playerId, kind, text, audio });
    broadcastRoom(room.code);
  }));

  socket.on("speech:skip", safe(socket, ({ roomCode, playerId }) => {
    const room = game.skipSpeech({ roomCode, playerId });
    broadcastRoom(room.code);
  }));

  socket.on("speech:expire", safe(socket, ({ roomCode, startedAt }) => {
    const room = game.expireCurrentSpeaker({ roomCode, startedAt });
    if (room) broadcastRoom(room.code);
  }));

  socket.on("vote:cast", safe(socket, ({ roomCode, playerId, targetId, targetIds }, reply) => {
    game.castVote({ roomCode, voterId: playerId, targetId, targetIds });
    const room = game.resolveVoteIfReady({ roomCode });
    broadcastRoom(room.code);
    reply?.({ ok: true });
  }));

  socket.on("vote:remind", safe(socket, ({ roomCode, playerId }) => {
    const room = game.remindVoters({ roomCode, hostId: playerId });
    broadcastRoom(room.code);
  }));

  socket.on("message:send", safe(socket, ({ roomCode, playerId, text }) => {
    const room = game.sendChat({ roomCode, playerId, text });
    broadcastRoom(room.code);
  }));

  socket.on("barrage:send", safe(socket, ({ roomCode, playerId, text, effect, targetId }) => {
    const room = game.sendBarrage({ roomCode, playerId, text, effect, targetId });
    broadcastRoom(room.code);
  }));

  socket.on("game:restart", safe(socket, ({ roomCode, playerId }) => {
    const room = game.restartGame({ roomCode, hostId: playerId });
    broadcastRoom(room.code);
  }));

  socket.on("room:leave", safe(socket, ({ roomCode, playerId }, reply) => {
    const room = game.leaveRoom({ roomCode, playerId });
    socket.leave(roomCode);
    socketPlayers.delete(socket.id);
    reply?.({ ok: true });
    if (room) broadcastRoom(room.code);
  }));

  socket.on("room:sync", safe(socket, ({ roomCode, playerId }) => {
    const room = game.getRoom(roomCode);
    if (!room) throw new GameError("房间不存在或已经结束");
    if (!room.players.some((player) => player.id === playerId)) {
      throw new GameError("请先输入昵称加入房间");
    }
    bindSocket(socket, room.code, playerId);
    game.markConnected({ roomCode: room.code, playerId, connected: true });
    emitState(socket, room.code, playerId);
    broadcastRoom(room.code);
  }));

  socket.on("disconnect", () => {
    const binding = socketPlayers.get(socket.id);
    if (!binding) return;
    socketPlayers.delete(socket.id);
    setTimeout(() => {
      const stillConnected = [...socketPlayers.values()].some(
        (item) => item.roomCode === binding.roomCode && item.playerId === binding.playerId
      );
      if (!stillConnected) {
        const room = game.markConnected({ ...binding, connected: false });
        if (room) broadcastRoom(room.code);
      }
    }, 700);
  });
});

function bindSocket(socket, roomCode, playerId) {
  socket.join(roomCode);
  socketPlayers.set(socket.id, { roomCode, playerId });
}

function broadcastRoom(roomCode) {
  const room = game.getRoom(roomCode);
  if (!room) return;
  scheduleSpeechTimer(room);
  for (const [socketId, binding] of socketPlayers.entries()) {
    if (binding.roomCode === room.code) {
      const target = io.sockets.sockets.get(socketId);
      if (target) emitState(target, room.code, binding.playerId);
    }
  }
}

function scheduleSpeechTimer(room) {
  const existing = speechTimers.get(room.code);
  if (existing) clearTimeout(existing);
  speechTimers.delete(room.code);

  if (room.phase !== "speaking") return;

  if (room.roundPauseUntil) {
    const remainingPause = Math.max(0, room.roundPauseUntil - Date.now());
    const timer = setTimeout(() => {
      const updated = game.finishRoundPause({ roomCode: room.code });
      if (updated) broadcastRoom(updated.code);
    }, remainingPause + 100);
    speechTimers.set(room.code, timer);
    return;
  }

  if (!room.currentSpeakerStartedAt) return;

  const remaining = Math.max(0, SPEECH_SECONDS * 1000 - (Date.now() - room.currentSpeakerStartedAt));
  const timer = setTimeout(() => {
    const updated = game.expireCurrentSpeaker({
      roomCode: room.code,
      startedAt: room.currentSpeakerStartedAt
    });
    if (updated) broadcastRoom(updated.code);
  }, remaining + 100);
  speechTimers.set(room.code, timer);
}

function emitState(socket, roomCode, playerId) {
  const room = game.getRoom(roomCode);
  if (!room) return;
  socket.emit("room:state", publicRoomState(room, playerId));
}

function safe(socket, handler) {
  return (...args) => {
    const maybeReply = typeof args.at(-1) === "function" ? args.pop() : null;
    try {
      handler(...args, maybeReply);
    } catch (error) {
      const message = error instanceof GameError ? error.message : "操作失败，请稍后再试";
      socket.emit("room:error", { message });
      maybeReply?.({ ok: false, message });
    }
  };
}

const port = Number(process.env.PORT || 3000);
server.listen(port, () => {
  console.log(`Who Is Undercover is running at http://localhost:${port}`);
});

export { app, server, game };
