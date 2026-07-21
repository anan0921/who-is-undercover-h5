import crypto from "node:crypto";
import { WORD_PAIRS } from "./words.js";

export const MIN_PLAYERS = 3;
export const SPEECH_SECONDS = 30;
export const SPEECH_ROUNDS_BEFORE_VOTE = 3;
export const EXTRA_SPEECH_ROUNDS_AFTER_MISS = 1;
export const COLORS = [
  "#f97316",
  "#06b6d4",
  "#84cc16",
  "#ec4899",
  "#8b5cf6",
  "#f59e0b",
  "#14b8a6",
  "#ef4444",
  "#3b82f6",
  "#a855f7"
];

export function createStore({ now = () => Date.now(), random = Math.random } = {}) {
  const rooms = new Map();

  function makeRoomCode() {
    let code;
    do {
      code = crypto.randomBytes(3).toString("hex").toUpperCase();
    } while (rooms.has(code));
    return code;
  }

  function requireRoom(roomCode) {
    const room = rooms.get(normalizeRoomCode(roomCode));
    if (!room) throw new GameError("房间不存在或已经结束");
    return room;
  }

  function createRoom({ nickname, playerId }) {
    const roomCode = makeRoomCode();
    const player = makePlayer({ playerId, nickname, color: COLORS[0], now });
    const room = {
      code: roomCode,
      hostId: player.id,
      phase: "lobby",
      voteRule: "undercoverWinsOnMiss",
      missCount: 0,
      players: [player],
      createdAt: now(),
      wordPair: null,
      undercoverId: null,
      round: 1,
      speechStageStartRound: 1,
      speechRoundsInStage: SPEECH_ROUNDS_BEFORE_VOTE,
      speakerIndex: 0,
      votes: {},
      result: null,
      lastVoteSummary: null,
      messages: [],
      currentSpeakerStartedAt: null,
      gameNumber: 0
    };
    rooms.set(roomCode, room);
    return { room, player };
  }

  function joinRoom({ roomCode, nickname, playerId }) {
    const room = rooms.get(normalizeRoomCode(roomCode));
    if (!room) throw new GameError("房间不存在或已经结束");

    let player = room.players.find((item) => item.id === playerId);
    if (player) {
      player.nickname = cleanNickname(nickname) || player.nickname;
      player.connected = true;
      player.lastSeenAt = now();
      return { room, player };
    }

    if (room.phase !== "lobby") throw new GameError("游戏已经开始，不能加入新玩家");

    const usedColors = new Set(room.players.map((item) => item.color));
    const color = COLORS.find((item) => !usedColors.has(item)) || COLORS[room.players.length % COLORS.length];
    player = makePlayer({ playerId, nickname, color, now });
    room.players.push(player);
    return { room, player };
  }

  function startGame({ roomCode, hostId }) {
    const room = requireRoom(roomCode);
    requireHost(room, hostId);
    if (room.phase !== "lobby") throw new GameError("当前不能开始游戏");

    const activePlayers = getActivePlayers(room);
    if (activePlayers.length < MIN_PLAYERS) throw new GameError(`至少需要 ${MIN_PLAYERS} 人才能开始`);
    if (activePlayers.some((player) => player.id !== room.hostId && !player.ready)) {
      throw new GameError("还有玩家没有准备好");
    }

    const undercover = activePlayers[Math.floor(random() * activePlayers.length)];
    const wordPair = WORD_PAIRS[Math.floor(random() * WORD_PAIRS.length)];
    room.wordPair = wordPair;
    room.undercoverId = undercover.id;
    room.voteRule = activePlayers.length > 5 ? "oneRetryOnMiss" : "undercoverWinsOnMiss";
    room.missCount = 0;
    room.phase = "speaking";
    room.round = 1;
    room.speechStageStartRound = 1;
    room.speechRoundsInStage = SPEECH_ROUNDS_BEFORE_VOTE;
    room.speakerIndex = 0;
    room.votes = {};
    room.result = null;
    room.lastVoteSummary = null;
    room.messages = [];
    room.currentSpeakerStartedAt = now();
    room.gameNumber += 1;

    for (const player of room.players) {
      player.eliminated = false;
      player.ready = false;
    }
    return room;
  }

  function setReady({ roomCode, playerId, ready }) {
    const room = requireRoom(roomCode);
    if (room.phase !== "lobby") throw new GameError("只有开局前可以准备");
    const player = requirePlayer(room, playerId);
    if (player.id === room.hostId) throw new GameError("房主不需要准备");
    player.ready = Boolean(ready);
    return room;
  }

  function nextSpeaker({ roomCode, hostId }) {
    const room = requireRoom(roomCode);
    requireHost(room, hostId);
    if (room.phase !== "speaking") throw new GameError("当前不是发言阶段");

    advanceSpeaker(room, now);
    return room;
  }

  function submitSpeech({ roomCode, playerId, kind = "text", text = "", audio = "" }) {
    const room = requireRoom(roomCode);
    if (room.phase !== "speaking") throw new GameError("当前不是发言阶段");
    if (room.currentSpeakerStartedAt && now() - room.currentSpeakerStartedAt > SPEECH_SECONDS * 1000 + 1500) {
      throw new GameError("本轮发言时间已到");
    }

    const eligible = getSpeakingPlayers(room);
    const currentSpeaker = eligible[room.speakerIndex];
    if (!currentSpeaker) throw new GameError("这一轮已经发言完了");
    if (currentSpeaker.id !== playerId) throw new GameError("还没轮到你发言");

    const message = makeSpeechMessage({ room, playerId, kind, text, audio, now });
    room.messages.push(message);
    advanceSpeaker(room, now);
    return room;
  }

  function expireCurrentSpeaker({ roomCode, startedAt }) {
    const room = rooms.get(normalizeRoomCode(roomCode));
    if (!room || room.phase !== "speaking") return null;
    if (!room.currentSpeakerStartedAt || room.currentSpeakerStartedAt !== startedAt) return null;
    if (now() - room.currentSpeakerStartedAt < SPEECH_SECONDS * 1000) return null;

    const eligible = getSpeakingPlayers(room);
    if (!eligible[room.speakerIndex]) return null;
    advanceSpeaker(room, now);
    return room;
  }

  function castVote({ roomCode, voterId, targetId }) {
    const room = requireRoom(roomCode);
    if (room.phase !== "voting") throw new GameError("当前不是投票阶段");

    const voter = requirePlayer(room, voterId);
    const target = requirePlayer(room, targetId);
    if (voter.eliminated) throw new GameError("已淘汰玩家不能投票");
    if (target.eliminated) throw new GameError("不能投给已淘汰玩家");

    room.votes[voter.id] = target.id;
    return room;
  }

  function resolveVote({ roomCode, hostId, requireHostRole = true } = {}) {
    const room = requireRoom(roomCode);
    if (requireHostRole) requireHost(room, hostId);
    if (room.phase !== "voting") throw new GameError("当前不能结算投票");

    const activePlayers = getActivePlayers(room).filter((player) => !player.eliminated);
    if (activePlayers.some((player) => !room.votes[player.id])) {
      throw new GameError("还有玩家没有提交投票");
    }
    const summary = tallyVotes(room, activePlayers);
    room.lastVoteSummary = summary;

    if (!summary.winnerId || summary.tied) {
      room.messages.push(makeSystemMessage({
        text: `本轮平票，没有人淘汰，所有人再发言一轮`,
        now
      }));
      room.phase = "speaking";
      room.round += 1;
      room.speechStageStartRound = room.round;
      room.speechRoundsInStage = EXTRA_SPEECH_ROUNDS_AFTER_MISS;
      room.speakerIndex = 0;
      room.votes = {};
      room.currentSpeakerStartedAt = now();
      return room;
    }

    if (summary.winnerId === room.undercoverId) {
      room.phase = "ended";
      room.result = {
        winner: "civilians",
        reason: "卧底被投出，平民获胜",
        votedOutId: summary.winnerId,
        scoreChanges: scoreChangesFor(room, "civilians")
      };
      applyScores(room);
      return room;
    }

    if (room.voteRule === "undercoverWinsOnMiss" || room.missCount >= 1) {
      room.phase = "ended";
      room.result = {
        winner: "undercover",
        reason: room.voteRule === "oneRetryOnMiss" ? "第二次仍未投中卧底，卧底获胜" : "没有投中卧底，卧底获胜",
        votedOutId: summary.winnerId,
        scoreChanges: scoreChangesFor(room, "undercover")
      };
      applyScores(room);
      return room;
    }

    const votedOut = requirePlayer(room, summary.winnerId);
    votedOut.eliminated = true;
    room.missCount += 1;
    room.messages.push(makeSystemMessage({
      text: `${votedOut.nickname} 被投出，但不是卧底，剩余玩家再发言一轮`,
      now
    }));
    const remainingCivilians = activePlayers.filter((player) => player.id !== room.undercoverId && player.id !== votedOut.id).length;
    const undercoverAlive = !requirePlayer(room, room.undercoverId).eliminated;
    if (undercoverAlive && remainingCivilians <= 1) {
      room.phase = "ended";
      room.result = {
        winner: "undercover",
        reason: "平民人数过少，卧底获胜",
        votedOutId: summary.winnerId,
        scoreChanges: scoreChangesFor(room, "undercover")
      };
      applyScores(room);
      return room;
    }

    room.phase = "speaking";
    room.round += 1;
    room.speechStageStartRound = room.round;
    room.speechRoundsInStage = EXTRA_SPEECH_ROUNDS_AFTER_MISS;
    room.speakerIndex = 0;
    room.votes = {};
    room.currentSpeakerStartedAt = now();
    return room;
  }

  function resolveVoteIfReady({ roomCode }) {
    const room = requireRoom(roomCode);
    if (room.phase !== "voting") return room;
    const activePlayers = getActivePlayers(room).filter((player) => !player.eliminated);
    if (activePlayers.some((player) => !room.votes[player.id])) return room;
    return resolveVote({ roomCode, requireHostRole: false });
  }

  function remindVoters({ roomCode, hostId }) {
    const room = requireRoom(roomCode);
    requireHost(room, hostId);
    if (room.phase !== "voting") throw new GameError("当前不是投票阶段");
    const missing = getActivePlayers(room)
      .filter((player) => !player.eliminated && !room.votes[player.id])
      .map((player) => player.nickname);
    if (missing.length === 0) throw new GameError("所有人都已经提交了");
    room.messages.push({
      id: crypto.randomUUID(),
      playerId: hostId,
      kind: "system",
      text: `请 ${missing.join("、")} 尽快提交投票`,
      audio: "",
      createdAt: now()
    });
    return room;
  }

  function restartGame({ roomCode, hostId }) {
    const room = requireRoom(roomCode);
    requireHost(room, hostId);
    if (room.phase !== "ended") throw new GameError("本局结束后才能继续下一把");
    room.phase = "lobby";
    room.wordPair = null;
    room.undercoverId = null;
    room.round = 1;
    room.speechStageStartRound = 1;
    room.speechRoundsInStage = SPEECH_ROUNDS_BEFORE_VOTE;
    room.speakerIndex = 0;
    room.votes = {};
    room.result = null;
    room.lastVoteSummary = null;
    room.messages = [];
    room.currentSpeakerStartedAt = null;
    room.missCount = 0;
    for (const player of room.players) {
      player.eliminated = false;
      player.ready = false;
    }
    return room;
  }

  function markConnected({ roomCode, playerId, connected }) {
    const room = rooms.get(normalizeRoomCode(roomCode));
    if (!room) return null;
    const player = room.players.find((item) => item.id === playerId);
    if (!player) return room;
    player.connected = connected;
    player.lastSeenAt = now();
    if (!connected && room.hostId === playerId) transferHost(room);
    return room;
  }

  function getRoom(roomCode) {
    return rooms.get(normalizeRoomCode(roomCode)) || null;
  }

  return {
    rooms,
    createRoom,
    joinRoom,
    startGame,
    setReady,
    nextSpeaker,
    submitSpeech,
    expireCurrentSpeaker,
    castVote,
    resolveVote,
    resolveVoteIfReady,
    remindVoters,
    markConnected,
    restartGame,
    getRoom
  };
}

export function publicRoomState(room, viewerId) {
  const speakingPlayers = getSpeakingPlayers(room);
  const currentSpeaker = room.phase === "speaking" ? speakingPlayers[room.speakerIndex] || null : null;
  const viewer = room.players.find((player) => player.id === viewerId);
  const isUndercover = viewer?.id === room.undercoverId;
  const showSecret = room.phase !== "lobby" && room.wordPair && viewer;

  return {
    code: room.code,
    serverNow: Date.now(),
    hostId: room.hostId,
    phase: room.phase,
    voteRule: room.voteRule,
    missCount: room.missCount,
    round: room.round,
    speechStageStartRound: room.speechStageStartRound,
    speechRoundsInStage: room.speechRoundsInStage,
    gameNumber: room.gameNumber,
    speakerIndex: room.speakerIndex,
    currentSpeakerId: currentSpeaker?.id || null,
    currentSpeakerStartedAt: room.currentSpeakerStartedAt,
    speechSeconds: SPEECH_SECONDS,
    speechRoundsBeforeVote: room.speechRoundsInStage,
    allSpoken: room.phase === "speaking" && speakingPlayers.length > 0 && room.speakerIndex >= speakingPlayers.length,
    players: room.players.map((player) => ({
      id: player.id,
      nickname: player.nickname,
      color: player.color,
      score: player.score,
      ready: player.ready,
      connected: player.connected,
      eliminated: player.eliminated,
      isHost: player.id === room.hostId,
      hasVoted: Boolean(room.votes[player.id])
    })),
    messages: room.messages.map((message) => ({
      ...message,
      nickname: room.players.find((player) => player.id === message.playerId)?.nickname || "玩家",
      color: room.players.find((player) => player.id === message.playerId)?.color || COLORS[0]
    })),
    votes: room.phase === "voting" ? [] : publicVotes(room),
    voteCounts: room.phase === "voting" ? {} : publicVoteCounts(room),
    lastVoteSummary: room.lastVoteSummary,
    result: room.result,
    secret: showSecret
      ? {
          word: isUndercover ? room.wordPair.undercoverWord : room.wordPair.civilianWord,
          category: room.wordPair.category,
          difficulty: room.wordPair.difficulty
        }
      : null,
    reveal:
      room.phase === "ended" && room.wordPair
        ? {
            undercoverId: room.undercoverId,
            undercoverName: room.players.find((player) => player.id === room.undercoverId)?.nickname || "未知",
            undercoverColor: room.players.find((player) => player.id === room.undercoverId)?.color || COLORS[0],
            votedOutId: room.result?.votedOutId || null,
            votedOutName: room.players.find((player) => player.id === room.result?.votedOutId)?.nickname || "",
            scoreChanges: room.result?.scoreChanges || {},
            civilianWord: room.wordPair.civilianWord,
            undercoverWord: room.wordPair.undercoverWord
          }
        : null
  };
}

export class GameError extends Error {
  constructor(message) {
    super(message);
    this.name = "GameError";
  }
}

function makePlayer({ playerId, nickname, color, now }) {
  return {
    id: playerId || crypto.randomUUID(),
    nickname: cleanNickname(nickname) || "玩家",
    color,
    connected: true,
    eliminated: false,
    score: 0,
    ready: false,
    joinedAt: now(),
    lastSeenAt: now()
  };
}

function makeMessage({ playerId, kind, text, audio, now }) {
  const normalizedKind = kind === "audio" ? "audio" : "text";
  const cleanText = String(text || "").trim().slice(0, 180);
  const cleanAudio = String(audio || "");

  if (normalizedKind === "text" && !cleanText) throw new GameError("发言不能为空");
  if (normalizedKind === "audio" && !cleanAudio.startsWith("data:audio/")) throw new GameError("语音内容无效");
  if (cleanAudio.length > 1_500_000) throw new GameError("语音太长了，请控制在 30 秒内");

  return {
    id: crypto.randomUUID(),
    playerId,
    kind: normalizedKind,
    text: cleanText,
    audio: normalizedKind === "audio" ? cleanAudio : "",
    round: null,
    createdAt: now()
  };
}

function makeSystemMessage({ text, now }) {
  return {
    id: crypto.randomUUID(),
    playerId: "",
    kind: "system",
    text,
    audio: "",
    createdAt: now()
  };
}

function makeSpeechMessage({ room, playerId, kind, text, audio, now }) {
  return {
    ...makeMessage({ playerId, kind, text, audio, now }),
    round: room.round
  };
}

function advanceSpeaker(room, now) {
  const eligible = getSpeakingPlayers(room);
  if (eligible.length === 0) throw new GameError("没有可发言玩家");

  room.speakerIndex = Math.min(room.speakerIndex + 1, eligible.length);
  if (room.speakerIndex < eligible.length) {
    room.currentSpeakerStartedAt = now();
    return;
  }

  const stageEndRound = room.speechStageStartRound + room.speechRoundsInStage - 1;
  if (room.round < stageEndRound) {
    room.round += 1;
    room.speakerIndex = 0;
    room.currentSpeakerStartedAt = now();
    return;
  }

  room.phase = "voting";
  room.votes = {};
  room.currentSpeakerStartedAt = null;
}

function applyScores(room) {
  const undercoverWon = room.result?.winner === "undercover";
  for (const player of room.players) {
    const won = undercoverWon ? player.id === room.undercoverId : player.id !== room.undercoverId;
    player.score += won ? 5 : -5;
  }
}

function scoreChangesFor(room, winner) {
  const undercoverWon = winner === "undercover";
  return Object.fromEntries(room.players.map((player) => {
    const won = undercoverWon ? player.id === room.undercoverId : player.id !== room.undercoverId;
    return [player.id, won ? 5 : -5];
  }));
}

function cleanNickname(nickname) {
  return String(nickname || "").trim().slice(0, 12);
}

function normalizeRoomCode(roomCode) {
  return String(roomCode || "").trim().toUpperCase();
}

function requirePlayer(room, playerId) {
  const player = room.players.find((item) => item.id === playerId);
  if (!player) throw new GameError("玩家不存在");
  return player;
}

function requireHost(room, playerId) {
  if (room.hostId !== playerId) throw new GameError("只有房主可以操作");
}

function getActivePlayers(room) {
  return room.players.filter((player) => player.connected || room.phase !== "lobby");
}

function getSpeakingPlayers(room) {
  return getActivePlayers(room).filter((player) => !player.eliminated);
}

function tallyVotes(room, activePlayers) {
  const counts = {};
  for (const targetId of Object.values(room.votes)) {
    if (activePlayers.some((player) => player.id === targetId)) {
      counts[targetId] = (counts[targetId] || 0) + 1;
    }
  }

  let top = 0;
  let leaders = [];
  for (const player of activePlayers) {
    const count = counts[player.id] || 0;
    if (count > top) {
      top = count;
      leaders = [player.id];
    } else if (count === top && count > 0) {
      leaders.push(player.id);
    }
  }

  return {
    counts,
    winnerId: leaders.length === 1 ? leaders[0] : null,
    tied: leaders.length !== 1,
    topVotes: top
  };
}

function publicVotes(room) {
  return Object.entries(room.votes).map(([voterId, targetId]) => ({ voterId, targetId }));
}

function publicVoteCounts(room) {
  return tallyVotes(room, getActivePlayers(room).filter((player) => !player.eliminated)).counts;
}

function transferHost(room) {
  const nextHost = room.players.find((player) => player.connected && !player.eliminated) || room.players.find((player) => player.connected);
  if (nextHost) room.hostId = nextHost.id;
}
