import assert from "node:assert/strict";
import test from "node:test";
import { createStore, MIN_PLAYERS, publicRoomState } from "../src/game.js";
import { WORD_PAIRS } from "../src/words.js";

function makeStartedRoom(playerCount = 3) {
  const game = createStore({ random: () => 0, now: () => 1 });
  const { room, player: host } = game.createRoom({ nickname: "房主", playerId: "p1" });
  for (let index = 2; index <= playerCount; index += 1) {
    game.joinRoom({ roomCode: room.code, nickname: `玩家${index}`, playerId: `p${index}` });
    game.setReady({ roomCode: room.code, playerId: `p${index}`, ready: true });
  }
  game.startGame({ roomCode: room.code, hostId: host.id });
  return { game, room, host };
}

function playThreeRounds(game, room) {
  for (let round = 1; round <= 3; round += 1) {
    const activeIds = room.players.filter((player) => !player.eliminated).map((player) => player.id);
    for (const playerId of activeIds) {
      game.submitSpeech({ roomCode: room.code, playerId, text: `${playerId} 发言` });
    }
  }
  assert.equal(room.phase, "voting");
}

function playOneRound(game, room) {
  const activeIds = room.players.filter((player) => !player.eliminated).map((player) => player.id);
  for (const playerId of activeIds) {
    game.submitSpeech({ roomCode: room.code, playerId, text: `${playerId} 加时发言` });
  }
  assert.equal(room.phase, "voting");
}

test("requires at least three players before starting", () => {
  const game = createStore({ random: () => 0 });
  const { room, player } = game.createRoom({ nickname: "房主", playerId: "p1" });
  game.joinRoom({ roomCode: room.code, nickname: "玩家二", playerId: "p2" });

  assert.throws(
    () => game.startGame({ roomCode: room.code, hostId: player.id }),
    new RegExp(`${MIN_PLAYERS} 人`)
  );
});

test("requires every non-host player to be ready before starting", () => {
  const game = createStore({ random: () => 0 });
  const { room, player } = game.createRoom({ nickname: "房主", playerId: "p1" });
  game.joinRoom({ roomCode: room.code, nickname: "玩家二", playerId: "p2" });
  game.joinRoom({ roomCode: room.code, nickname: "玩家三", playerId: "p3" });
  game.setReady({ roomCode: room.code, playerId: "p2", ready: true });

  assert.throws(
    () => game.startGame({ roomCode: room.code, hostId: player.id }),
    /没有准备好/
  );

  game.setReady({ roomCode: room.code, playerId: "p3", ready: true });
  game.startGame({ roomCode: room.code, hostId: player.id });
  assert.equal(room.phase, "speaking");
});

test("joining by room code creates the invited player before they can ready", () => {
  const game = createStore({ random: () => 0 });
  const { room } = game.createRoom({ nickname: "房主", playerId: "p1" });

  assert.throws(
    () => game.setReady({ roomCode: room.code, playerId: "guest", ready: true }),
    /玩家不存在/
  );

  game.joinRoom({ roomCode: room.code, nickname: "朋友", playerId: "guest" });
  game.setReady({ roomCode: room.code, playerId: "guest", ready: true });

  assert.equal(room.players.find((player) => player.id === "guest").ready, true);
});

test("assigns exactly one undercover and keeps each player's word private without revealing role", () => {
  const { room } = makeStartedRoom();
  const pair = WORD_PAIRS[0];
  const undercoverState = publicRoomState(room, "p1");
  const civilianState = publicRoomState(room, "p2");

  assert.equal(room.undercoverId, "p1");
  assert.equal(undercoverState.secret.word, pair.undercoverWord);
  assert.equal(civilianState.secret.word, pair.civilianWord);
  assert.equal("role" in undercoverState.secret, false);
  assert.equal(civilianState.reveal, null);
});

test("speech submission appears on the public screen and advances the speaker", () => {
  const { game, room } = makeStartedRoom();

  assert.equal(publicRoomState(room, "p1").currentSpeakerId, "p1");
  game.submitSpeech({ roomCode: room.code, playerId: "p1", text: "我这个词每天都能见到" });

  const state = publicRoomState(room, "p2");
  assert.equal(state.messages.length, 1);
  assert.equal(state.messages[0].text, "我这个词每天都能见到");
  assert.equal(state.messages[0].round, 1);
  assert.equal(state.currentSpeakerId, "p2");
  assert.equal(typeof state.currentSpeakerStartedAt, "number");
});

test("three full speaking rounds automatically move to voting", () => {
  const { game, room } = makeStartedRoom();

  playThreeRounds(game, room);

  assert.equal(room.round, 3);
  assert.equal(room.phase, "voting");
});

test("civilians win when the undercover is voted out", () => {
  const { game, room, host } = makeStartedRoom();

  playThreeRounds(game, room);
  game.castVote({ roomCode: room.code, voterId: "p1", targetId: "p1" });
  game.castVote({ roomCode: room.code, voterId: "p2", targetId: "p1" });
  game.castVote({ roomCode: room.code, voterId: "p3", targetId: "p1" });
  game.resolveVote({ roomCode: room.code, hostId: host.id });

  assert.equal(room.phase, "ended");
  assert.equal(room.result.winner, "civilians");
  const state = publicRoomState(room, "p2");
  assert.equal(state.reveal.undercoverName, "房主");
  assert.equal(state.reveal.votedOutName, "房主");
  assert.equal(state.reveal.scoreChanges.p1, -5);
  assert.equal(state.reveal.scoreChanges.p2, 5);
  assert.equal(room.players.find((player) => player.id === "p1").score, -5);
  assert.equal(room.players.find((player) => player.id === "p2").score, 5);
});

test("vote cannot resolve until every active player has submitted", () => {
  const { game, room, host } = makeStartedRoom();

  playThreeRounds(game, room);
  game.castVote({ roomCode: room.code, voterId: "p1", targetId: "p1" });
  game.castVote({ roomCode: room.code, voterId: "p2", targetId: "p1" });

  assert.throws(
    () => game.resolveVote({ roomCode: room.code, hostId: host.id }),
    /没有提交投票/
  );
});

test("vote resolves automatically once every active player submits", () => {
  const { game, room } = makeStartedRoom();

  playThreeRounds(game, room);
  game.castVote({ roomCode: room.code, voterId: "p1", targetId: "p1" });
  game.resolveVoteIfReady({ roomCode: room.code });
  assert.equal(room.phase, "voting");
  game.castVote({ roomCode: room.code, voterId: "p2", targetId: "p1" });
  game.resolveVoteIfReady({ roomCode: room.code });
  assert.equal(room.phase, "voting");
  game.castVote({ roomCode: room.code, voterId: "p3", targetId: "p1" });
  game.resolveVoteIfReady({ roomCode: room.code });

  assert.equal(room.phase, "ended");
  assert.equal(room.result.winner, "civilians");
});

test("host can remind players who have not submitted votes", () => {
  const { game, room, host } = makeStartedRoom();

  playThreeRounds(game, room);
  game.castVote({ roomCode: room.code, voterId: "p1", targetId: "p1" });
  game.remindVoters({ roomCode: room.code, hostId: host.id });

  assert.equal(room.messages.at(-1).kind, "system");
  assert.match(room.messages.at(-1).text, /玩家2/);
  assert.match(room.messages.at(-1).text, /玩家3/);
});

test("undercover wins immediately on a missed vote in quick mode", () => {
  const { game, room, host } = makeStartedRoom();

  assert.equal(room.voteRule, "undercoverWinsOnMiss");
  playThreeRounds(game, room);
  game.castVote({ roomCode: room.code, voterId: "p1", targetId: "p2" });
  game.castVote({ roomCode: room.code, voterId: "p2", targetId: "p2" });
  game.castVote({ roomCode: room.code, voterId: "p3", targetId: "p2" });
  game.resolveVote({ roomCode: room.code, hostId: host.id });

  assert.equal(room.phase, "ended");
  assert.equal(room.result.winner, "undercover");
  assert.equal(room.players.find((player) => player.id === "p1").score, 5);
  assert.equal(room.players.find((player) => player.id === "p2").score, -5);
});

test("six or more players get one extra speaking round after the first missed vote", () => {
  const { game, room, host } = makeStartedRoom(6);

  assert.equal(room.voteRule, "oneRetryOnMiss");
  playThreeRounds(game, room);
  game.castVote({ roomCode: room.code, voterId: "p1", targetId: "p2" });
  game.castVote({ roomCode: room.code, voterId: "p2", targetId: "p2" });
  game.castVote({ roomCode: room.code, voterId: "p3", targetId: "p2" });
  game.castVote({ roomCode: room.code, voterId: "p4", targetId: "p2" });
  game.castVote({ roomCode: room.code, voterId: "p5", targetId: "p3" });
  game.castVote({ roomCode: room.code, voterId: "p6", targetId: "p4" });
  game.resolveVote({ roomCode: room.code, hostId: host.id });

  assert.equal(room.phase, "speaking");
  assert.equal(room.round, 4);
  assert.equal(room.speechStageStartRound, 4);
  assert.equal(room.speechRoundsInStage, 1);
  assert.equal(room.missCount, 1);
  assert.equal(room.players.find((player) => player.id === "p2").eliminated, true);
  assert.equal(room.messages.at(-1).kind, "system");
  assert.match(room.messages.at(-1).text, /不是卧底/);

  playOneRound(game, room);
  game.castVote({ roomCode: room.code, voterId: "p1", targetId: "p3" });
  game.castVote({ roomCode: room.code, voterId: "p3", targetId: "p3" });
  game.castVote({ roomCode: room.code, voterId: "p4", targetId: "p3" });
  game.castVote({ roomCode: room.code, voterId: "p5", targetId: "p4" });
  game.castVote({ roomCode: room.code, voterId: "p6", targetId: "p5" });
  game.resolveVote({ roomCode: room.code, hostId: host.id });

  assert.equal(room.phase, "ended");
  assert.equal(room.result.winner, "undercover");
});

test("a tied vote returns to speaking without eliminating anyone", () => {
  const { game, room, host } = makeStartedRoom();

  playThreeRounds(game, room);
  game.castVote({ roomCode: room.code, voterId: "p1", targetId: "p2" });
  game.castVote({ roomCode: room.code, voterId: "p2", targetId: "p3" });
  game.castVote({ roomCode: room.code, voterId: "p3", targetId: "p1" });
  game.resolveVote({ roomCode: room.code, hostId: host.id });

  assert.equal(room.phase, "speaking");
  assert.equal(room.round, 4);
  assert.equal(room.speechRoundsInStage, 1);
  assert.equal(room.players.some((player) => player.eliminated), false);
  assert.equal(room.messages.at(-1).kind, "system");
  assert.match(room.messages.at(-1).text, /平票/);
});

test("host transfers to the earliest connected player when host disconnects", () => {
  const game = createStore();
  const { room } = game.createRoom({ nickname: "房主", playerId: "p1" });
  game.joinRoom({ roomCode: room.code, nickname: "玩家二", playerId: "p2" });
  game.joinRoom({ roomCode: room.code, nickname: "玩家三", playerId: "p3" });

  game.markConnected({ roomCode: room.code, playerId: "p1", connected: false });

  assert.equal(room.hostId, "p2");
});

test("restarting keeps players and accumulated scores in the same room", () => {
  const { game, room, host } = makeStartedRoom();

  playThreeRounds(game, room);
  game.castVote({ roomCode: room.code, voterId: "p1", targetId: "p1" });
  game.castVote({ roomCode: room.code, voterId: "p2", targetId: "p1" });
  game.castVote({ roomCode: room.code, voterId: "p3", targetId: "p1" });
  game.resolveVote({ roomCode: room.code, hostId: host.id });
  game.restartGame({ roomCode: room.code, hostId: host.id });

  assert.equal(room.phase, "lobby");
  assert.equal(room.players.length, 3);
  assert.equal(room.players.find((player) => player.id === "p2").score, 5);
  assert.equal(room.gameNumber, 1);
});
