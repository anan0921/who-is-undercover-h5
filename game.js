import crypto from "node:crypto";
import { WORD_PAIRS } from "./words.js";

export const MIN_PLAYERS = 3;
export const SPEECH_SECONDS = 60;
export const SPEECH_ROUNDS_BEFORE_VOTE = 2;
export const EXTRA_SPEECH_ROUNDS_AFTER_MISS = 1;
export const GAMES_PER_SERIES = 3;
export const ROUND_PAUSE_MS = 5000;
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

const SKIP_TEASES = [
  "你不会是卧底吧？",
  "心虚了吗？",
  "不敢发言了？",
  "这沉默很有故事。",
  "大家记一下这个可疑动作。",
  "跳过也是一种发言。"
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
      undercoverIds: [],
      round: 1,
      speechStageStartRound: 1,
      speechRoundsInStage: SPEECH_ROUNDS_BEFORE_VOTE,
      speakerOrder: [],
      speakerIndex: 0,
      votes: {},
      result: null,
      lastVoteSummary: null,
      messages: [],
      chatMessages: [],
      barrages: [],
      currentSpeakerStartedAt: null,
      roundPauseUntil: null,
      gameNumber: 0,
      seriesNumber: 1
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

    if (room.phase === "lobby" && room.gameNumber > 0 && room.gameNumber % GAMES_PER_SERIES === 0) {
      for (const player of room.players) player.score = 0;
      room.seriesNumber += 1;
      room.chatMessages.push(makeSystemMessage({
        text: `第 ${room.seriesNumber} 大轮开始，分数已重新计`,
        now
      }));
    }

    const undercoverIds = pickUndercoverIds(activePlayers, random);
    const wordPair = WORD_PAIRS[Math.floor(random() * WORD_PAIRS.length)];
    room.wordPair = wordPair;
    room.undercoverIds = undercoverIds;
    room.undercoverId = undercoverIds[0];
    room.voteRule = activePlayers.length > 5 ? "oneRetryOnMiss" : "undercoverWinsOnMiss";
    room.missCount = 0;
    room.phase = "speaking";
    room.round = 1;
    room.speechStageStartRound = 1;
    room.speechRoundsInStage = SPEECH_ROUNDS_BEFORE_VOTE;
    room.speakerOrder = shuffleIds(activePlayers, random);
    room.speakerIndex = 0;
    room.votes = {};
    room.result = null;
    room.lastVoteSummary = null;
    room.messages = [];
    room.chatMessages.push(makeSystemMessage({
      text: `第 ${seriesGameNumber(room.gameNumber + 1)} / ${GAMES_PER_SERIES} 局开始，发言顺序已随机打乱`,
      now
    }));
    room.currentSpeakerStartedAt = now();
    room.roundPauseUntil = null;
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

  function kickPlayer({ roomCode, hostId, targetId }) {
    const room = requireRoom(roomCode);
    requireHost(room, hostId);
    if (room.phase !== "lobby") throw new GameError("只有开局前可以踢人");
    if (targetId === hostId) throw new GameError("房主不能踢自己");
    const player = requirePlayer(room, targetId);
    room.players = room.players.filter((item) => item.id !== player.id);
    room.chatMessages.push(makeSystemMessage({ text: `${player.nickname} 被房主移出了房间`, now }));
    return room;
  }

  function nextSpeaker({ roomCode, hostId }) {
    const room = requireRoom(roomCode);
    requirePlayer(room, hostId);
    throw new GameError("只能由当前发言者发送、录音或跳过");
  }

  function skipSpeech({ roomCode, playerId }) {
    const room = requireRoom(roomCode);
    if (room.phase !== "speaking") throw new GameError("当前不是发言阶段");

    const eligible = getSpeakingPlayers(room);
    const currentSpeaker = eligible[room.speakerIndex];
    if (!currentSpeaker) throw new GameError("这一轮已经发言完了");
    if (currentSpeaker.id !== playerId) throw new GameError("还没轮到你发言");

    const tease = SKIP_TEASES[Math.floor(random() * SKIP_TEASES.length)];
    room.messages.push(makeSystemMessage({
      text: `${currentSpeaker.nickname} 跳过了发言。${tease}`,
      now
    }));
    room.barrages.push({
      id: crypto.randomUUID(),
      playerId,
      kind: "barrage",
      effect: "text",
      text: tease,
      createdAt: now()
    });
    room.barrages = room.barrages.slice(-40);
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

  function castVote({ roomCode, voterId, targetId, targetIds }) {
    const room = requireRoom(roomCode);
    if (room.phase !== "voting") throw new GameError("当前不是投票阶段");

    const voter = requirePlayer(room, voterId);
    if (voter.eliminated) throw new GameError("已淘汰玩家不能投票");

    const quota = voteQuota(room);
    const ids = Array.isArray(targetIds) ? targetIds : [targetId];
    const cleanIds = ids.map((id) => String(id || "")).filter(Boolean);
    const uniqueIds = [...new Set(cleanIds)];
    if (uniqueIds.length !== cleanIds.length) throw new GameError("不能把多票投给同一个人");
    if (uniqueIds.length !== quota) throw new GameError(`本轮需要选择 ${quota} 名玩家`);
    for (const id of uniqueIds) {
      const target = requirePlayer(room, id);
      if (target.eliminated) throw new GameError("不能投给已淘汰玩家");
    }

    room.votes[voter.id] = uniqueIds;
    return room;
  }

  function resolveVote({ roomCode, hostId, requireHostRole = true } = {}) {
    const room = requireRoom(roomCode);
    if (requireHostRole) requireHost(room, hostId);
    if (room.phase !== "voting") throw new GameError("当前不能结算投票");

    const activePlayers = getActivePlayers(room).filter((player) => !player.eliminated);
    const quota = voteQuota(room);
    if (activePlayers.some((player) => !hasSubmittedVote(room, player.id, quota))) {
      throw new GameError("还有玩家没有提交投票");
    }
    const summary = tallyVotes(room, activePlayers);
    room.lastVoteSummary = summary;

    if (!summary.winnerIds.length || summary.tied) {
      room.messages.push(makeSystemMessage({
        text: `本轮关键名次平票，没有人淘汰，所有人再发言一轮`,
        now
      }));
      room.phase = "speaking";
      room.round += 1;
      room.speechStageStartRound = room.round;
      room.speechRoundsInStage = EXTRA_SPEECH_ROUNDS_AFTER_MISS;
      room.speakerOrder = shuffleIds(getSpeakingPlayers(room), random);
      room.speakerIndex = 0;
      room.votes = {};
      room.currentSpeakerStartedAt = now();
      room.roundPauseUntil = null;
      return room;
    }

    const votedOutPlayers = summary.winnerIds.map((id) => requirePlayer(room, id));
    for (const player of votedOutPlayers) player.eliminated = true;
    const caughtUndercovers = votedOutPlayers.filter((player) => isUndercover(room, player.id));
    const missedAll = caughtUndercovers.length === 0;

    if (caughtUndercovers.length > 0) {
      const remainingUndercoverIds = getRemainingUndercoverIds(room);
      if (remainingUndercoverIds.length === 0) {
        room.phase = "ended";
        room.result = {
          winner: "civilians",
          reason: "所有卧底被投出，平民获胜",
          votedOutId: summary.winnerIds[0],
          votedOutIds: summary.winnerIds,
          scoreChanges: scoreChangesFor(room, "civilians")
        };
        applyScores(room);
        return room;
      }
      room.messages.push(makeSystemMessage({
        text: `${caughtUndercovers.map((player) => player.nickname).join("、")} 是卧底，已出局！还有 ${remainingUndercoverIds.length} 名卧底藏在人群中，继续发言一轮`,
        now
      }));
      room.phase = "speaking";
      room.round += 1;
      room.speechStageStartRound = room.round;
      room.speechRoundsInStage = EXTRA_SPEECH_ROUNDS_AFTER_MISS;
      room.speakerOrder = shuffleIds(getSpeakingPlayers(room), random);
      room.speakerIndex = 0;
      room.votes = {};
      room.currentSpeakerStartedAt = now();
      room.roundPauseUntil = null;
      return room;
    }

    if (missedAll && (room.voteRule === "undercoverWinsOnMiss" || room.missCount >= 1)) {
      room.phase = "ended";
      room.result = {
        winner: "undercover",
        reason: room.voteRule === "oneRetryOnMiss" ? "第二次仍未投中卧底，卧底获胜" : "没有投中卧底，卧底获胜",
        votedOutId: summary.winnerIds[0],
        votedOutIds: summary.winnerIds,
        scoreChanges: scoreChangesFor(room, "undercover")
      };
      applyScores(room);
      return room;
    }

    room.missCount += 1;
    room.messages.push(makeSystemMessage({
      text: `${votedOutPlayers.map((player) => player.nickname).join("、")} 被投出，但都不是卧底，剩余玩家再发言一轮`,
      now
    }));
    room.phase = "speaking";
    room.round += 1;
    room.speechStageStartRound = room.round;
    room.speechRoundsInStage = EXTRA_SPEECH_ROUNDS_AFTER_MISS;
    room.speakerOrder = shuffleIds(getSpeakingPlayers(room), random);
    room.speakerIndex = 0;
    room.votes = {};
    room.currentSpeakerStartedAt = now();
    room.roundPauseUntil = null;
    return room;
  }

  function resolveVoteIfReady({ roomCode }) {
    const room = requireRoom(roomCode);
    if (room.phase !== "voting") return room;
    const activePlayers = getActivePlayers(room).filter((player) => !player.eliminated);
    const quota = voteQuota(room);
    if (activePlayers.some((player) => !hasSubmittedVote(room, player.id, quota))) return room;
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

  function sendChat({ roomCode, playerId, text }) {
    const room = requireRoom(roomCode);
    const player = requirePlayer(room, playerId);
    const cleanText = String(text || "").trim().slice(0, 120);
    if (!cleanText) throw new GameError("聊天内容不能为空");
    room.chatMessages.push({
      id: crypto.randomUUID(),
      playerId: player.id,
      kind: "chat",
      text: cleanText,
      createdAt: now()
    });
    room.chatMessages = room.chatMessages.slice(-80);
    return room;
  }

  function sendBarrage({ roomCode, playerId, text, effect = "text", targetId = "" }) {
    const room = requireRoom(roomCode);
    const player = requirePlayer(room, playerId);
    const target = targetId ? room.players.find((item) => item.id === targetId) : null;
    const cleanText = String(text || "").trim().slice(0, 40);
    if (!cleanText) throw new GameError("弹幕内容不能为空");
    const cleanEffect = "text";
    room.barrages.push({
      id: crypto.randomUUID(),
      playerId: player.id,
      targetId: target?.id || "",
      kind: "barrage",
      effect: cleanEffect,
      text: cleanText,
      createdAt: now()
    });
    room.barrages = room.barrages.slice(-40);
    return room;
  }

  function finishRoundPause({ roomCode }) {
    const room = requireRoom(roomCode);
    if (room.phase !== "speaking" || !room.roundPauseUntil) return room;

    const stageEndRound = room.speechStageStartRound + room.speechRoundsInStage - 1;
    room.roundPauseUntil = null;
    if (room.round < stageEndRound) {
      room.round += 1;
      room.speakerIndex = 0;
      room.currentSpeakerStartedAt = now();
      return room;
    }

    room.phase = "voting";
    room.votes = {};
    room.currentSpeakerStartedAt = null;
    return room;
  }

  function restartGame({ roomCode, hostId }) {
    const room = requireRoom(roomCode);
    requireHost(room, hostId);
    if (room.phase !== "ended") throw new GameError("本局结束后才能继续下一把");
    room.phase = "lobby";
    room.wordPair = null;
    room.undercoverId = null;
    room.undercoverIds = [];
    room.round = 1;
    room.speechStageStartRound = 1;
    room.speechRoundsInStage = SPEECH_ROUNDS_BEFORE_VOTE;
    room.speakerOrder = [];
    room.speakerIndex = 0;
    room.votes = {};
    room.result = null;
    room.lastVoteSummary = null;
    room.messages = [];
    room.currentSpeakerStartedAt = null;
    room.roundPauseUntil = null;
    room.missCount = 0;
    for (const player of room.players) {
      player.eliminated = false;
      player.ready = false;
    }
    return room;
  }

  function leaveRoom({ roomCode, playerId }) {
    const room = requireRoom(roomCode);
    if (!["lobby", "ended"].includes(room.phase)) throw new GameError("本局进行中，结束后才能退出");
    const player = requirePlayer(room, playerId);
    room.players = room.players.filter((item) => item.id !== player.id);
    room.chatMessages.push(makeSystemMessage({ text: `${player.nickname} 离开了房间`, now }));
    if (room.hostId === player.id) transferHost(room);
    if (room.players.length === 0) rooms.delete(room.code);
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
    kickPlayer,
    nextSpeaker,
    submitSpeech,
    skipSpeech,
    expireCurrentSpeaker,
    castVote,
    resolveVote,
    resolveVoteIfReady,
    remindVoters,
    sendChat,
    sendBarrage,
    finishRoundPause,
    markConnected,
    restartGame,
    leaveRoom,
    getRoom
  };
}

export function publicRoomState(room, viewerId) {
  const speakingPlayers = getSpeakingPlayers(room);
  const currentSpeaker = room.phase === "speaking" ? speakingPlayers[room.speakerIndex] || null : null;
  const viewer = room.players.find((player) => player.id === viewerId);
  const isUndercoverPlayer = isUndercover(room, viewer?.id);
  const showSecret = room.phase !== "lobby" && room.wordPair && viewer;

  return {
    code: room.code,
    serverNow: Date.now(),
    hostId: room.hostId,
    phase: room.phase,
    voteRule: room.voteRule,
    missCount: room.missCount,
    undercoverCount: getUndercoverCount(room.players.length),
    remainingUndercoverCount: getRemainingUndercoverIds(room).length,
    voteQuota: voteQuota(room),
    round: room.round,
    speechStageStartRound: room.speechStageStartRound,
    speechRoundsInStage: room.speechRoundsInStage,
    gameNumber: room.gameNumber,
    seriesNumber: room.seriesNumber,
    seriesGameNumber: seriesGameNumber(room.gameNumber || 1),
    gamesPerSeries: GAMES_PER_SERIES,
    isSeriesFinal: room.phase === "ended" && room.gameNumber > 0 && room.gameNumber % GAMES_PER_SERIES === 0,
    leaderboard: leaderboard(room),
    speakerIndex: room.speakerIndex,
    currentSpeakerId: currentSpeaker?.id || null,
    currentSpeakerStartedAt: room.currentSpeakerStartedAt,
    roundPauseUntil: room.roundPauseUntil,
    isRoundPause: room.phase === "speaking" && Boolean(room.roundPauseUntil),
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
      hasVoted: hasSubmittedVote(room, player.id, voteQuota(room))
    })),
    messages: room.messages.map((message) => ({
      ...message,
      nickname: room.players.find((player) => player.id === message.playerId)?.nickname || "玩家",
      color: room.players.find((player) => player.id === message.playerId)?.color || COLORS[0]
    })),
    chatMessages: room.chatMessages.map((message) => ({
      ...message,
      nickname: room.players.find((player) => player.id === message.playerId)?.nickname || "系统",
      color: room.players.find((player) => player.id === message.playerId)?.color || COLORS[0]
    })),
    barrages: room.barrages.map((message) => ({
      ...message,
      nickname: room.players.find((player) => player.id === message.playerId)?.nickname || "玩家",
      targetName: room.players.find((player) => player.id === message.targetId)?.nickname || "",
      color: room.players.find((player) => player.id === message.playerId)?.color || COLORS[0]
    })),
    votes: room.phase === "voting" ? publicOwnVotes(room, viewerId) : publicVotes(room),
    voteCounts: room.phase === "voting" ? {} : publicVoteCounts(room),
    lastVoteSummary: room.lastVoteSummary,
    result: room.result,
    secret: showSecret
      ? {
          word: isUndercoverPlayer ? room.wordPair.undercoverWord : room.wordPair.civilianWord,
          category: room.wordPair.category,
          difficulty: room.wordPair.difficulty
        }
      : null,
    reveal:
      room.phase === "ended" && room.wordPair
        ? {
            undercoverId: room.undercoverId,
            undercoverIds: room.undercoverIds,
            undercovers: room.undercoverIds.map((id) => {
              const player = room.players.find((item) => item.id === id);
              return {
                id,
                name: player?.nickname || "未知",
                color: player?.color || COLORS[0],
                eliminated: Boolean(player?.eliminated)
              };
            }),
            undercoverName: room.players.find((player) => player.id === room.undercoverId)?.nickname || "未知",
            undercoverColor: room.players.find((player) => player.id === room.undercoverId)?.color || COLORS[0],
            votedOutId: room.result?.votedOutId || null,
            votedOutIds: room.result?.votedOutIds || (room.result?.votedOutId ? [room.result.votedOutId] : []),
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
  if (cleanAudio.length > 3_000_000) throw new GameError("语音太长了，请控制在 60 秒内");

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

  room.currentSpeakerStartedAt = null;
  room.roundPauseUntil = now() + ROUND_PAUSE_MS;
}

function applyScores(room) {
  const undercoverWon = room.result?.winner === "undercover";
  for (const player of room.players) {
    const won = undercoverWon ? isUndercover(room, player.id) : !isUndercover(room, player.id);
    player.score += won ? 5 : -5;
  }
}

function scoreChangesFor(room, winner) {
  const undercoverWon = winner === "undercover";
  return Object.fromEntries(room.players.map((player) => {
    const won = undercoverWon ? isUndercover(room, player.id) : !isUndercover(room, player.id);
    return [player.id, won ? 5 : -5];
  }));
}

function seriesGameNumber(gameNumber) {
  const normalized = Math.max(1, Number(gameNumber) || 1);
  return ((normalized - 1) % GAMES_PER_SERIES) + 1;
}

function leaderboard(room) {
  return [...room.players]
    .sort((a, b) => b.score - a.score || a.joinedAt - b.joinedAt)
    .map((player, index) => ({
      id: player.id,
      nickname: player.nickname,
      color: player.color,
      score: player.score,
      rank: index + 1
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
  const players = getActivePlayers(room).filter((player) => !player.eliminated);
  if (!room.speakerOrder?.length) return players;
  const byId = new Map(players.map((player) => [player.id, player]));
  const ordered = room.speakerOrder.map((id) => byId.get(id)).filter(Boolean);
  const remaining = players.filter((player) => !room.speakerOrder.includes(player.id));
  return [...ordered, ...remaining];
}

function getUndercoverCount(playerCount) {
  if (playerCount > 5) return 2;
  return 1;
}

function pickUndercoverIds(players, random) {
  const count = Math.min(getUndercoverCount(players.length), Math.max(1, players.length - 1));
  return shuffleIds(players, random).slice(0, count);
}

function shuffleIds(players, random) {
  const ids = players.map((player) => player.id);
  for (let index = ids.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [ids[index], ids[swapIndex]] = [ids[swapIndex], ids[index]];
  }
  return ids;
}

function isUndercover(room, playerId) {
  return Boolean(playerId && (room.undercoverIds?.length ? room.undercoverIds.includes(playerId) : room.undercoverId === playerId));
}

function getRemainingUndercoverIds(room) {
  return (room.undercoverIds || [room.undercoverId]).filter((id) => {
    const player = room.players.find((item) => item.id === id);
    return player && !player.eliminated;
  });
}

function voteQuota(room) {
  return Math.max(1, getRemainingUndercoverIds(room).length || getUndercoverCount(getActivePlayers(room).length));
}

function hasSubmittedVote(room, voterId, quota = voteQuota(room)) {
  return Array.isArray(room.votes[voterId]) && room.votes[voterId].length === quota;
}

function tallyVotes(room, activePlayers) {
  const counts = {};
  for (const targetIds of Object.values(room.votes)) {
    for (const targetId of Array.isArray(targetIds) ? targetIds : [targetIds]) {
      if (activePlayers.some((player) => player.id === targetId)) {
        counts[targetId] = (counts[targetId] || 0) + 1;
      }
    }
  }

  const quota = voteQuota(room);
  const ranked = activePlayers
    .map((player) => ({ id: player.id, count: counts[player.id] || 0 }))
    .sort((a, b) => b.count - a.count);
  const cutoff = ranked[Math.min(quota, ranked.length) - 1]?.count || 0;
  const aboveCutoff = ranked.filter((item) => item.count > cutoff);
  const atCutoff = ranked.filter((item) => item.count === cutoff && item.count > 0);
  const tiedAtCutoff = cutoff === 0 || (aboveCutoff.length < quota && atCutoff.length > quota - aboveCutoff.length);
  const winnerIds = tiedAtCutoff ? [] : ranked.slice(0, quota).filter((item) => item.count > 0).map((item) => item.id);

  return {
    counts,
    winnerId: winnerIds[0] || null,
    winnerIds,
    tied: tiedAtCutoff,
    topVotes: ranked[0]?.count || 0,
    quota
  };
}

function publicVotes(room) {
  return Object.entries(room.votes).flatMap(([voterId, targetIds]) => {
    const ids = Array.isArray(targetIds) ? targetIds : [targetIds];
    return ids.map((targetId) => ({ voterId, targetId }));
  });
}

function publicOwnVotes(room, viewerId) {
  const targetIds = room.votes[viewerId] || [];
  return (Array.isArray(targetIds) ? targetIds : [targetIds]).map((targetId) => ({ voterId: viewerId, targetId }));
}

function publicVoteCounts(room) {
  return tallyVotes(room, getActivePlayers(room).filter((player) => !player.eliminated)).counts;
}

function transferHost(room) {
  const nextHost = room.players.find((player) => player.connected && !player.eliminated) || room.players.find((player) => player.connected);
  if (nextHost) room.hostId = nextHost.id;
}
