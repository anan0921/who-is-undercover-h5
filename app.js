const socket = io();
const state = {
  playerId: localStorage.getItem("undercover.playerId") || crypto.randomUUID(),
  nickname: localStorage.getItem("undercover.nickname") || "",
  roomCode: currentRoomFromPath(),
  room: null,
  clockOffset: 0,
  pendingVoteTargetId: "",
  pendingVoteTargetIds: [],
  timerId: null,
  audioCtx: null,
  musicAudio: null,
  musicTimer: null,
  soundEnabled: localStorage.getItem("undercover.soundEnabled") !== "false",
  audioUnlocked: false,
  timeoutSignalKey: "",
  reviewSeenFor: "",
  barrageTargetId: "",
  lastTickSecond: null,
  lastSpeakerNoticeKey: "",
  seenBarrageIds: new Set(),
  optimisticBarrages: [],
  recorder: null,
  chunks: [],
  recordingStartedAt: 0
};

const $ = (id) => document.getElementById(id);
const refs = {
  home: $("homeView"),
  footer: $("homeFooter"),
  nickname: $("nicknameInput"),
  roomCodeInput: $("roomCodeInput"),
  create: $("createRoomButton"),
  join: $("joinRoomButton"),
  rulesButton: $("rulesButton"),
  roomRulesButton: $("roomRulesButton"),
  rulesModal: $("rulesModal"),
  closeRules: $("closeRulesButton"),
  roomHeader: $("roomHeader"),
  roomCodeText: $("roomCodeText"),
  copyLink: $("copyLinkButton"),
  share: $("shareButton"),
  sound: $("soundButton"),
  secret: $("secretCard"),
  roleText: $("roleText"),
  wordText: $("wordText"),
  wordMeta: $("wordMeta"),
  status: $("statusCard"),
  phaseText: $("phaseText"),
  statusTitle: $("statusTitle"),
  statusDetail: $("statusDetail"),
  timer: $("timer"),
  speakPanel: $("speakPanel"),
  speechInput: $("speechInput"),
  sendSpeech: $("sendSpeechButton"),
  skipSpeech: $("skipSpeechButton"),
  record: $("recordButton"),
  recordHint: $("recordHint"),
  controls: $("hostControls"),
  messagesPanel: $("messagesPanel"),
  messageList: $("messageList"),
  messageCount: $("messageCount"),
  chatPanel: $("chatPanel"),
  chatTitle: $("chatTitle"),
  chatList: $("chatList"),
  chatCount: $("chatCount"),
  chatInput: $("chatInput"),
  sendChat: $("sendChatButton"),
  barragePanel: $("barragePanel"),
  barrageTitle: $("barrageTitle"),
  closeBarrage: $("closeBarrageButton"),
  barrageStage: $("barrageStage"),
  barrageInput: $("barrageInput"),
  sendBarrage: $("sendBarrageButton"),
  openBarrage: $("openBarrageButton"),
  speakerNotice: $("speakerNotice"),
  votePanel: $("votePanel"),
  voteHint: $("voteHint"),
  voteCallout: $("voteCallout"),
  voteGrid: $("voteGrid"),
  confirmVote: $("confirmVoteButton"),
  playersPanel: $("playersPanel"),
  playerPanelTitle: $("playerPanelTitle"),
  playerList: $("playerList"),
  playerCount: $("playerCount"),
  reviewModal: $("reviewModal"),
  closeReview: $("closeReviewButton"),
  reviewResult: $("reviewResult"),
  reviewChatList: $("reviewChatList"),
  reviewChatCount: $("reviewChatCount"),
  reviewChatInput: $("reviewChatInput"),
  sendReviewChat: $("sendReviewChatButton"),
  toast: $("toast")
};

refs.nickname.value = state.nickname;
if (state.roomCode) refs.roomCodeInput.value = state.roomCode;

refs.create.addEventListener("click", createRoom);
refs.join.addEventListener("click", joinRoom);
refs.rulesButton.addEventListener("click", () => refs.rulesModal.classList.remove("hidden"));
refs.roomRulesButton.addEventListener("click", () => refs.rulesModal.classList.remove("hidden"));
refs.closeRules.addEventListener("click", () => refs.rulesModal.classList.add("hidden"));
refs.copyLink.addEventListener("click", copyLink);
refs.share.addEventListener("click", shareRoom);
refs.sound.addEventListener("click", toggleSound);
refs.sendSpeech.addEventListener("click", sendTextSpeech);
refs.skipSpeech.addEventListener("click", skipSpeech);
refs.record.addEventListener("click", toggleRecording);
refs.confirmVote.addEventListener("click", confirmVote);
refs.sendChat.addEventListener("click", sendChat);
refs.chatInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") sendChat();
});
refs.sendBarrage.addEventListener("click", () => sendBarrage(refs.barrageInput.value));
refs.openBarrage.addEventListener("click", () => openBarrageMenu(null));
refs.barrageInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") sendBarrage(refs.barrageInput.value);
});
refs.closeBarrage.addEventListener("click", closeBarrageMenu);
refs.closeReview.addEventListener("click", () => refs.reviewModal.classList.add("hidden"));
refs.statusDetail.addEventListener("click", (event) => {
  if (event.target?.id === "openReviewButton") refs.reviewModal.classList.remove("hidden");
});
refs.sendReviewChat.addEventListener("click", sendReviewChat);
refs.reviewChatInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") sendReviewChat();
});
document.querySelectorAll("[data-barrage]").forEach((button) => {
  button.addEventListener("click", () => sendBarrage(button.dataset.barrage, button.dataset.effect || "text"));
});
refs.speakerNotice.addEventListener("animationend", () => refs.speakerNotice.classList.add("hidden"));
document.addEventListener("pointerdown", unlockAudio);
document.addEventListener("touchstart", unlockAudio, { passive: true });
document.addEventListener("click", unlockAudio);

socket.on("connect", () => {
  if (!state.roomCode) return;

  if (state.nickname) {
    request("room:join", {
      roomCode: state.roomCode,
      nickname: state.nickname,
      playerId: state.playerId
    }).then((response) => {
      if (!response?.ok) {
        toast(response?.message || "加入房间失败");
        showHome();
      }
    });
  } else {
    showHome();
    refs.nickname.focus();
  }
});

socket.on("room:state", (room) => {
  state.room = room;
  state.clockOffset = Date.now() - room.serverNow;
  state.roomCode = room.code;
  localStorage.setItem("undercover.playerId", state.playerId);
  if (state.nickname) localStorage.setItem("undercover.nickname", state.nickname);
  history.replaceState(null, "", `/room/${room.code}`);
  render();
});

socket.on("room:error", ({ message }) => toast(message));

socket.on("room:kicked", ({ message }) => {
  toast(message || "你已被移出房间");
  state.room = null;
  state.roomCode = "";
  history.replaceState(null, "", "/");
  showHome();
});

async function createRoom() {
  if (!captureNickname()) return;
  const response = await request("room:create", {
    nickname: state.nickname,
    playerId: state.playerId
  });
  if (!response.ok) return toast(response.message);
  state.roomCode = response.roomCode;
  state.playerId = response.playerId;
}

async function joinRoom() {
  if (!captureNickname()) return;
  const roomCode = refs.roomCodeInput.value.trim().toUpperCase();
  if (!roomCode) return toast("请输入房间码");
  const response = await request("room:join", {
    roomCode,
    nickname: state.nickname,
    playerId: state.playerId
  });
  if (!response.ok) return toast(response.message);
  state.roomCode = response.roomCode;
  state.playerId = response.playerId;
}

function captureNickname() {
  const nickname = refs.nickname.value.trim();
  if (!nickname) {
    toast("先起个昵称");
    refs.nickname.focus();
    return false;
  }
  state.nickname = nickname.slice(0, 12);
  localStorage.setItem("undercover.nickname", state.nickname);
  return true;
}

function render() {
  const room = state.room;
  if (!room) return showHome();
  const me = room.players.find((player) => player.id === state.playerId);
  const isHost = room.hostId === state.playerId;
  const isMyTurn = room.phase === "speaking" && room.currentSpeakerId === state.playerId;

  refs.home.classList.add("hidden");
  refs.footer.classList.add("hidden");
  refs.roomHeader.classList.remove("hidden");
  refs.status.classList.remove("hidden");
  refs.playersPanel.classList.remove("hidden");
  refs.roomCodeText.textContent = room.code;
  refs.playerCount.textContent = `${room.players.length} 人`;

  renderSecret(room);
  renderStatus(room, me);
  renderPlayers(room);
  renderControls(room, isHost, me);
  renderMessages(room);
  renderChat(room);
  renderBarrages(room);
  renderSpeechComposer(room, isMyTurn, me);
  renderVotes(room, me);
  renderReview(room);
  renderSpeakerNotice(room, isMyTurn);
  startTimer(room);
  startBackgroundMusic(room);
  updateSoundButton();
}

function renderSecret(room) {
  refs.secret.classList.toggle("hidden", !room.secret && room.phase !== "lobby");
  if (!room.secret) {
    refs.roleText.textContent = "你的词";
    refs.wordText.textContent = "等待开局";
    refs.wordMeta.textContent = "游戏开始后 每个人会看到自己的词";
    return;
  }
  refs.roleText.textContent = "你的词";
  refs.wordText.textContent = room.secret.word;
  refs.wordMeta.textContent = `${room.secret.category} · ${difficultyText(room.secret.difficulty)} · 自己判断阵营`;
}

function renderStatus(room, me) {
  const phaseMap = {
    lobby: "大厅",
    speaking: `第 ${room.round} 轮发言`,
    voting: "投票",
    ended: "结算"
  };
  refs.phaseText.textContent = phaseMap[room.phase] || "房间";
  refs.status.dataset.phase = room.phase;

  if (room.phase === "lobby") {
    refs.statusTitle.textContent = room.players.length < 3 ? "再邀请几位朋友" : "人数够了，房主可以开局";
    refs.statusDetail.textContent = "1-5 人 1 个卧底，超过 5 人 2 个卧底。两轮发言后投票。";
  } else if (room.phase === "speaking") {
    const speaker = room.players.find((player) => player.id === room.currentSpeakerId);
    const stageRound = room.round - (room.speechStageStartRound || 1) + 1;
    const totalRounds = room.speechRoundsInStage || room.speechRoundsBeforeVote;
    refs.phaseText.textContent = totalRounds === 1 && room.round > 3
      ? `加时 ${stageRound}/${totalRounds} 轮`
      : `第 ${stageRound}/${totalRounds} 轮`;
    if (room.isRoundPause) {
      refs.statusTitle.textContent = "本轮发言结束";
      refs.statusDetail.textContent = "本轮内容保留 5 秒，稍后进入下一轮或投票。";
    } else {
      refs.statusTitle.textContent = `${speaker?.nickname || "下一位"} 发言`;
      refs.statusDetail.textContent = `第 ${room.seriesGameNumber}/${room.gamesPerSeries} 局 · 每人 60 秒，可提前发送或自己跳过。`;
    }
  } else if (room.phase === "voting") {
    const submitted = room.players.filter((player) => !player.eliminated && player.hasVoted).length;
    const total = room.players.filter((player) => !player.eliminated).length;
    refs.statusTitle.textContent = me?.hasVoted ? "投票已提交，等待公布" : "现在开始投票";
    const missing = room.players.filter((player) => !player.eliminated && !player.hasVoted).map((player) => player.nickname);
    refs.statusDetail.innerHTML = `
      <span class="vote-progress"><span style="width:${Math.round((submitted / total) * 100)}%"></span></span>
      <span class="progress-line">投票进度 ${submitted}/${total}${missing.length ? ` · 未提交：${escapeHtml(missing.join("、"))}` : " · 正在公布"}</span>
    `;
  } else if (room.phase === "ended") {
    refs.statusTitle.textContent = room.isSeriesFinal ? "三局结束，查看总分" : room.result?.winner === "civilians" ? "平民获胜" : "卧底获胜";
    refs.statusDetail.innerHTML = `
      <span>${room.isSeriesFinal
        ? "本大轮已结束，赛后嘴硬区里可以看总分排名和本局答案。"
        : "答案已公布，赛后嘴硬区里可以看卧底、词语和分数变化。"}</span>
      <button class="plain-button reopen-review" id="openReviewButton" type="button">打开复盘</button>
    `;
  }
}

function renderPlayers(room) {
  refs.playerList.innerHTML = "";
  const isHost = room.hostId === state.playerId;
  refs.playerPanelTitle.textContent = room.phase === "lobby" ? "玩家" : "互动";
  refs.playersPanel.classList.toggle("compact", room.phase !== "lobby");
  refs.openBarrage.classList.toggle("hidden", room.phase === "lobby");
  refs.openBarrage.disabled = room.phase === "lobby";
  const visiblePlayers = room.phase === "lobby" ? room.players : compactBarragePlayers(room);
  for (const player of visiblePlayers) {
    const item = document.createElement("div");
    item.className = `player ${player.id === room.currentSpeakerId ? "current" : ""} ${player.id === state.playerId ? "self" : ""}`;
    const label = player.compactRole ? `<span class="badge host">${player.compactRole}</span>` : "";
    const badges = [
      label,
      player.isHost ? `<span class="badge host">房主</span>` : "",
      player.ready && room.phase === "lobby" ? `<span class="badge ready">已准备</span>` : "",
      player.id === state.playerId ? `<span class="badge">你</span>` : "",
      player.id === room.currentSpeakerId ? `<span class="badge host">发言中</span>` : "",
      player.eliminated ? `<span class="badge out">淘汰</span>` : "",
      !player.connected ? `<span class="badge offline">离线</span>` : "",
      player.hasVoted && room.phase === "voting" ? `<span class="badge">已投</span>` : "",
      room.reveal?.undercoverIds?.includes(player.id) ? `<span class="badge host">卧底</span>` : ""
    ].join("");
    const scoreClass = player.score > 0 ? "positive" : player.score < 0 ? "negative" : "";
    const kickButton = isHost && room.phase === "lobby" && player.id !== state.playerId
      ? `<button class="kick-player" type="button">踢出</button>`
      : "";
    item.innerHTML = `
      <button class="avatar avatar-button" type="button" style="background:${player.color}" aria-label="给 ${escapeHtml(player.nickname)} 发弹幕">${escapeHtml(player.nickname[0] || "玩")}</button>
      <div>
        <div class="name">${escapeHtml(player.nickname)}</div>
        <div class="badges">${badges}</div>
      </div>
      ${kickButton || `<div class="score ${scoreClass}">${formatScore(player.score)}</div>`}
    `;
    item.querySelector(".avatar-button").addEventListener("click", () => openBarrageMenu(player));
    item.querySelector(".kick-player")?.addEventListener("click", () => kickPlayer(player));
    refs.playerList.appendChild(item);
  }
}

function compactBarragePlayers(room) {
  const me = room.players.find((player) => player.id === state.playerId);
  const speaker = room.players.find((player) => player.id === room.currentSpeakerId)
    || room.players.find((player) => !player.eliminated && player.id !== state.playerId)
    || me
    || room.players[0];
  const left = speaker ? { ...speaker, compactRole: "" } : null;
  const right = me ? { ...me, compactRole: "自己" } : null;
  if (left && right) return [left, right];
  return [left || right].filter(Boolean);
}

function renderControls(room, isHost, me) {
  refs.controls.innerHTML = "";
  if (renderReadyControl(room, me, isHost)) return;
  refs.controls.classList.toggle("hidden", !isHost);
  if (!isHost) return;

  if (room.phase === "lobby") {
    const readyPlayers = room.players.filter((player) => player.connected);
    const readyToStart = readyPlayers.length >= 3 && readyPlayers.every((player) => player.isHost || player.ready);
    addControl(readyToStart ? "开始游戏" : "等待玩家准备", "wide", () => emit("game:start"), !readyToStart);
    addControl("退出房间", "wide secondary", leaveRoom);
  } else if (room.phase === "speaking") {
    refs.controls.classList.add("hidden");
  } else if (room.phase === "voting") {
    const activePlayers = room.players.filter((player) => !player.eliminated);
    const allVoted = activePlayers.every((player) => player.hasVoted);
    addControl(allVoted ? "即将公布" : "催促未提交", "wide secondary", () => emit("vote:remind"), allVoted);
  } else if (room.phase === "ended") {
    addControl(room.isSeriesFinal ? "开启新大轮" : "继续下一把", "wide", () => emit("game:restart"));
    addControl("退出房间", "wide secondary", leaveRoom);
  }
}

function addControl(label, className, action, disabled = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.className = className;
  button.disabled = disabled;
  button.addEventListener("click", action);
  refs.controls.appendChild(button);
}

function renderMessages(room) {
  refs.messagesPanel.classList.toggle("hidden", room.phase === "lobby");
  refs.messageCount.textContent = `${room.messages.length} 条`;
  refs.messageList.innerHTML = "";
  if (room.messages.length === 0) {
    refs.messageList.innerHTML = `<p class="empty">发言会显示在这里。</p>`;
    return;
  }

  const groups = groupMessages(room.messages);
  for (const group of groups) {
    const details = document.createElement("details");
    details.className = "round-group";
    details.open = group.round === room.round || group.round === "system";
    details.innerHTML = `<summary>${group.title}<span>${group.messages.length} 条</span></summary>`;
    const body = document.createElement("div");
    body.className = "round-messages";
    for (const message of group.messages) {
      const item = document.createElement("div");
      item.className = `message ${message.kind === "system" ? "system" : ""}`;
      if (message.kind === "system") {
        item.textContent = message.text;
        body.appendChild(item);
        continue;
      }
      item.innerHTML = `
        <div class="avatar small" style="background:${message.color}">${escapeHtml(message.nickname[0] || "玩")}</div>
        <div>
          <strong>${escapeHtml(message.nickname)}</strong>
          ${message.kind === "audio"
            ? `<audio controls src="${message.audio}"></audio>`
            : `<p>${escapeHtml(message.text)}</p>`}
        </div>
      `;
      body.appendChild(item);
    }
    details.appendChild(body);
    refs.messageList.appendChild(details);
  }
  refs.messageList.scrollTop = refs.messageList.scrollHeight;
}

function renderChat(room) {
  refs.chatPanel.classList.toggle("hidden", !room || !state.roomCode || room.phase !== "lobby");
  refs.roomRulesButton.classList.toggle("hidden", !room || !state.roomCode || room.phase !== "lobby");
  refs.chatTitle.textContent = "房间聊天";
  renderChatList(room.chatMessages || [], refs.chatList, refs.chatCount, "开局前先聊两句，催准备也可以。");
}

function renderChatList(messages, listEl, countEl, emptyText) {
  countEl.textContent = `${messages.length} 条`;
  listEl.innerHTML = "";
  if (!messages.length) {
    listEl.innerHTML = `<p class="empty">${escapeHtml(emptyText)}</p>`;
    return;
  }
  for (const message of messages) {
    const item = document.createElement("div");
    item.className = `chat-message ${message.kind === "system" ? "system" : ""}`;
    item.innerHTML = message.kind === "system"
      ? `<span>${escapeHtml(message.text)}</span>`
      : `<strong style="color:${message.color}">${escapeHtml(message.nickname)}</strong><span>${escapeHtml(message.text)}</span>`;
    listEl.appendChild(item);
  }
  listEl.scrollTop = listEl.scrollHeight;
}

function renderBarrages(room) {
  const barrages = room.barrages || [];
  for (const barrage of barrages) {
    if (state.seenBarrageIds.has(barrage.id)) continue;
    if (wasOptimisticBarrage(barrage)) {
      state.seenBarrageIds.add(barrage.id);
      continue;
    }
    state.seenBarrageIds.add(barrage.id);
    spawnBarrage(barrage);
  }
  if (state.seenBarrageIds.size > 120) {
    state.seenBarrageIds = new Set([...state.seenBarrageIds].slice(-60));
  }
}

function spawnBarrage(barrage) {
  const item = document.createElement("div");
  item.className = "barrage";
  const target = barrage.targetName ? ` -> ${barrage.targetName}` : "";
  item.textContent = `${barrage.nickname}${target}：${barrage.text}`;
  item.style.top = `${38 + Math.random() * 18}%`;
  refs.barrageStage.appendChild(item);
  playEffect("pop");
  item.addEventListener("animationend", () => item.remove(), { once: true });
}

function renderSpeechComposer(room, isMyTurn, me) {
  refs.speakPanel.classList.toggle("hidden", !isMyTurn || Boolean(me?.eliminated) || Boolean(room.isRoundPause));
  refs.sendSpeech.disabled = !isMyTurn;
  refs.skipSpeech.disabled = !isMyTurn;
  refs.record.disabled = !isMyTurn;
  if (!isMyTurn) {
    refs.speechInput.value = "";
    stopRecording(false);
  }
}

function renderVotes(room, me) {
  refs.votePanel.classList.toggle("hidden", room.phase !== "voting");
  refs.voteGrid.innerHTML = "";
  if (room.phase !== "voting") {
    state.pendingVoteTargetId = "";
    state.pendingVoteTargetIds = [];
    refs.confirmVote.disabled = false;
    return;
  }

  const quota = room.voteQuota || Math.max(1, room.remainingUndercoverCount || 1);
  const myVotes = room.votes.filter((vote) => vote.voterId === state.playerId).map((vote) => vote.targetId);
  if (myVotes.length) state.pendingVoteTargetIds = myVotes.slice(0, quota);
  state.pendingVoteTargetIds = state.pendingVoteTargetIds.filter((id) => room.players.some((player) => player.id === id && !player.eliminated)).slice(0, quota);
  state.pendingVoteTargetId = state.pendingVoteTargetIds[0] || "";
  refs.voteHint.textContent = myVotes.length ? "已提交，可在公布前改票" : "选完后记得点确定提交";
  refs.voteCallout.textContent = me?.hasVoted
    ? "你已经提交了，等其他人投完会自动公布。"
    : `本轮需要选择 ${quota} 名玩家，点确定提交才算完成。`;
  refs.confirmVote.disabled = Boolean(me?.eliminated) || state.pendingVoteTargetIds.length !== quota;
  refs.confirmVote.textContent = myVotes.length ? `修改并提交（${state.pendingVoteTargetIds.length}/${quota}）` : `确定提交（${state.pendingVoteTargetIds.length}/${quota}）`;
  for (const player of room.players.filter((item) => !item.eliminated)) {
    const selectedIndex = state.pendingVoteTargetIds.indexOf(player.id);
    const button = document.createElement("button");
    button.type = "button";
    button.className = `vote-card ${selectedIndex >= 0 ? "selected" : ""}`;
    button.disabled = me?.eliminated;
    button.innerHTML = `
      <div class="avatar" style="background:${player.color}">${escapeHtml(player.nickname[0] || "玩")}</div>
      <div>
        <strong>${escapeHtml(player.nickname)}</strong>
        <small>${quota > 1 ? `请选择 ${quota} 人，不能重复投同一个人` : player.id === state.playerId ? "你自己也可以被选择" : "候选玩家"}</small>
      </div>
      <span class="vote-status ${selectedIndex >= 0 ? "done" : ""}">${selectedIndex >= 0 ? `第 ${selectedIndex + 1} 票` : "选择"}</span>
    `;
    button.addEventListener("click", () => {
      toggleVoteTarget(player.id, quota);
      renderVotes(room, me);
    });
    refs.voteGrid.appendChild(button);
  }
}

function confirmVote() {
  const quota = state.room?.voteQuota || 1;
  if (state.pendingVoteTargetIds.length !== quota) return toast(`请选择 ${quota} 名玩家`);
  refs.confirmVote.disabled = true;
  emit("vote:cast", { targetId: state.pendingVoteTargetIds[0] || "", targetIds: state.pendingVoteTargetIds }, (response) => {
    if (!response?.ok) {
      refs.confirmVote.disabled = false;
      return toast(response?.message || "投票提交失败");
    }
    toast("投票已提交");
  });
}

function toggleVoteTarget(playerId, quota) {
  const index = state.pendingVoteTargetIds.indexOf(playerId);
  if (index >= 0) {
    state.pendingVoteTargetIds.splice(index, 1);
    return;
  }
  if (state.pendingVoteTargetIds.length >= quota) {
    state.pendingVoteTargetIds.shift();
  }
  state.pendingVoteTargetIds.push(playerId);
}

function resultHtml(room) {
  const reveal = room.reveal || {};
  const undercovers = reveal.undercovers?.length
    ? reveal.undercovers
    : [{ id: reveal.undercoverId, name: reveal.undercoverName, color: reveal.undercoverColor }];
  const votedOutIds = reveal.votedOutIds?.length ? reveal.votedOutIds : [reveal.votedOutId].filter(Boolean);
  const votedOutNames = votedOutIds.map((id) => room.players.find((player) => player.id === id)?.nickname).filter(Boolean);
  const undercoverIds = new Set(undercovers.map((player) => player.id));
  const civilians = room.players.filter((player) => !undercoverIds.has(player.id));
  const scoreItems = room.players.map((player) => {
    const change = reveal.scoreChanges?.[player.id] || 0;
    const className = change >= 0 ? "positive" : "negative";
    return `<span class="result-chip"><i style="background:${player.color}">${escapeHtml(player.nickname[0] || "玩")}</i>${escapeHtml(player.nickname)} <b class="${className}">${formatScore(change)}</b></span>`;
  }).join("");

  const podium = leaderboardHtml(room);
  return `
    <div class="result-stage">
      <div class="winner-banner">${room.result?.winner === "civilians" ? "平民阵营胜利" : "卧底胜利"}</div>
      <p class="result-reason">${escapeHtml(room.result?.reason || "")}</p>
      ${podium}
      <div class="result-teams">
        <div class="team-card undercover">
          <span>卧底</span>
          <div class="mini-avatars">${undercovers.map((player) => `<i style="background:${player.color || reveal.undercoverColor}">${escapeHtml((player.name || "卧")[0])}</i>`).join("")}</div>
          <strong>${undercovers.map((player) => `${escapeHtml(player.name || "未知")}${player.eliminated ? "（出局）" : ""}`).join("、")}</strong>
          <em>${escapeHtml(reveal.undercoverWord || "")}</em>
        </div>
        <div class="team-card civilians">
          <span>平民</span>
          <div class="mini-avatars">${civilians.map((player) => `<i style="background:${player.color}">${escapeHtml(player.nickname[0] || "玩")}</i>`).join("")}</div>
          <strong>${civilians.map((player) => escapeHtml(player.nickname)).join("、")}</strong>
          <em>${escapeHtml(reveal.civilianWord || "")}</em>
        </div>
      </div>
      <div class="result-line"><span>被投出</span><strong>${escapeHtml(votedOutNames.join("、") || reveal.votedOutName || "无")}</strong></div>
      <div class="score-row">${scoreItems}</div>
    </div>
  `;
}

function groupMessages(messages) {
  const roundGroups = new Map();
  const system = [];
  for (const message of messages) {
    if (message.kind === "system") {
      system.push(message);
      continue;
    }
    const key = message.round || 1;
    if (!roundGroups.has(key)) roundGroups.set(key, []);
    roundGroups.get(key).push(message);
  }
  const groups = [...roundGroups.entries()].map(([round, items]) => ({
    round,
    title: `第 ${round} 轮发言`,
    messages: items
  }));
  if (system.length) groups.push({ round: "system", title: "系统提示", messages: system });
  return groups;
}

function renderReadyControl(room, me, isHost) {
  if (room.phase !== "lobby" || isHost) return false;
  refs.controls.classList.remove("hidden");
  refs.controls.innerHTML = "";
  addControl(me?.ready ? "取消准备" : "准备好了", "wide", () => emit("player:ready", { ready: !me?.ready }));
  addControl("退出房间", "wide secondary", leaveRoom);
  return true;
}

function startTimer(room) {
  clearInterval(state.timerId);
  refs.timer.classList.add("hidden");
  refs.timer.classList.remove("danger");
  state.lastTickSecond = null;

  if (room.phase !== "speaking" || !room.currentSpeakerStartedAt || room.allSpoken || room.isRoundPause) return;

  const tick = () => {
    const serverNow = Date.now() - state.clockOffset;
    const elapsed = Math.floor((serverNow - room.currentSpeakerStartedAt) / 1000);
    const remaining = Math.max(0, room.speechSeconds - elapsed);
    refs.timer.textContent = String(remaining);
    refs.timer.classList.remove("hidden");
    refs.timer.classList.toggle("danger", remaining <= 5);
    if (remaining <= 5 && remaining > 0 && state.lastTickSecond !== remaining) {
      state.lastTickSecond = remaining;
      playEffect("tick");
    }
    if (remaining === 0) {
      const key = `${room.code}:${room.currentSpeakerStartedAt}:${room.currentSpeakerId}`;
      if (state.timeoutSignalKey !== key) {
        state.timeoutSignalKey = key;
        emit("speech:expire", { startedAt: room.currentSpeakerStartedAt });
      }
    }
  };

  tick();
  state.timerId = setInterval(tick, 250);
}

function sendTextSpeech() {
  const text = refs.speechInput.value.trim();
  if (!text) return toast("先输入发言");
  emit("speech:submit", { kind: "text", text });
  refs.speechInput.value = "";
}

function skipSpeech() {
  emit("speech:skip");
  refs.speechInput.value = "";
}

function sendChat() {
  const text = refs.chatInput.value.trim();
  if (!text) return toast("先输入聊天内容");
  emit("message:send", { text });
  refs.chatInput.value = "";
}

function sendBarrage(text, effect = "text") {
  const value = String(text || "").trim();
  if (!value) return toast("先输入弹幕");
  const room = state.room;
  const me = room?.players.find((player) => player.id === state.playerId);
  const target = room?.players.find((player) => player.id === state.barrageTargetId);
  const optimistic = {
    id: `local-${crypto.randomUUID()}`,
    playerId: state.playerId,
    nickname: me?.nickname || state.nickname || "我",
    targetId: target?.id || "",
    targetName: target?.nickname || "",
    color: me?.color || "#67d7ff",
    text: value,
    effect: "text",
    createdAt: Date.now()
  };
  state.optimisticBarrages.push(optimistic);
  state.optimisticBarrages = state.optimisticBarrages.slice(-8);
  spawnBarrage(optimistic);
  emit("barrage:send", { text: value, effect: "text", targetId: state.barrageTargetId });
  refs.barrageInput.value = "";
  closeBarrageMenu();
}

function sendReviewChat() {
  const text = refs.reviewChatInput.value.trim();
  if (!text) return toast("先输入复盘内容");
  emit("message:send", { text });
  refs.reviewChatInput.value = "";
}

function openBarrageMenu(player) {
  if (!state.room || state.room.phase === "lobby") return;
  state.barrageTargetId = player?.id || "";
  refs.barrageTitle.textContent = player ? `对 ${player.nickname} 发弹幕` : "发给全员";
  refs.barragePanel.classList.remove("hidden");
  refs.barrageInput.focus();
}

function closeBarrageMenu() {
  refs.barragePanel.classList.add("hidden");
  state.barrageTargetId = "";
}

function renderSpeakerNotice(room, isMyTurn) {
  if (!isMyTurn) {
    refs.speakerNotice.classList.add("hidden");
    return;
  }
  const key = `${room.code}:${room.currentSpeakerStartedAt}:${room.currentSpeakerId}`;
  if (state.lastSpeakerNoticeKey === key) return;
  state.lastSpeakerNoticeKey = key;
  refs.speakerNotice.classList.add("hidden");
  void refs.speakerNotice.offsetWidth;
  refs.speakerNotice.classList.remove("hidden");
  navigator.vibrate?.(120);
}

function renderReview(room) {
  const shouldShow = room.phase === "ended";
  if (!shouldShow) {
    refs.reviewModal.classList.add("hidden");
    state.reviewSeenFor = "";
    return;
  }

  refs.reviewResult.innerHTML = resultHtml(room);
  renderChatList(room.chatMessages || [], refs.reviewChatList, refs.reviewChatCount, "复盘还没开始，先来一句。");
  const reviewKey = `${room.code}:${room.gameNumber}:${room.result?.winner || ""}:${room.result?.votedOutId || ""}`;
  if (state.reviewSeenFor !== reviewKey) {
    state.reviewSeenFor = reviewKey;
    refs.reviewModal.classList.remove("hidden");
  }
}

function leaveRoom() {
  emit("room:leave", {}, (response) => {
    if (!response?.ok) return toast(response?.message || "退出失败");
    state.room = null;
    state.roomCode = "";
    history.replaceState(null, "", "/");
    showHome();
  });
}

function kickPlayer(player) {
  if (!player || player.id === state.playerId) return;
  const ok = window.confirm(`确定把 ${player.nickname} 移出房间吗？`);
  if (!ok) return;
  emit("player:kick", { targetId: player.id }, (response) => {
    if (!response?.ok) return toast(response?.message || "踢出失败");
    toast(`已移出 ${player.nickname}`);
  });
}

async function toggleRecording() {
  if (state.recorder?.state === "recording") {
    stopRecording(true);
    return;
  }

  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    toast("当前浏览器不支持录音");
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    state.chunks = [];
    state.recorder = new MediaRecorder(stream);
    state.recordingStartedAt = Date.now();
    state.recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) state.chunks.push(event.data);
    });
    state.recorder.addEventListener("stop", async () => {
      stream.getTracks().forEach((track) => track.stop());
      const blob = new Blob(state.chunks, { type: state.recorder.mimeType || "audio/webm" });
      if (blob.size === 0) return;
      const audio = await blobToDataUrl(blob);
      emit("speech:submit", { kind: "audio", audio });
    }, { once: true });
    state.recorder.start();
    refs.record.textContent = "结束录音";
    refs.record.classList.add("recording");
    refs.recordHint.textContent = "正在录音，点击结束发送。";
    setTimeout(() => stopRecording(true), 60_000);
  } catch {
    toast("没有麦克风权限");
  }
}

function stopRecording(send) {
  if (state.recorder?.state === "recording") {
    if (send) state.recorder.stop();
    else {
      state.recorder.stream?.getTracks().forEach((track) => track.stop());
      state.recorder = null;
    }
  }
  refs.record.textContent = "按下录音";
  refs.record.classList.remove("recording");
  refs.recordHint.textContent = "语音会作为音频发到公屏。";
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function resumeAudioContext() {
  if (!state.soundEnabled) return null;
  if (!state.audioCtx) {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return null;
    state.audioCtx = new AudioContext();
  }
  if (state.audioCtx.state === "suspended") await state.audioCtx.resume().catch(() => {});
  state.audioUnlocked = state.audioCtx.state === "running";
  return state.audioCtx;
}

function getAudioContext() {
  if (!state.soundEnabled) return null;
  if (!state.audioCtx) {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return null;
    state.audioCtx = new AudioContext();
  }
  if (state.audioCtx.state === "suspended") state.audioCtx.resume().catch(() => {});
  state.audioUnlocked = state.audioCtx.state === "running";
  return state.audioCtx;
}

function playTone({ frequency = 440, duration = 0.08, type = "sine", gain = 0.04 } = {}) {
  const ctx = getAudioContext();
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const volume = ctx.createGain();
  osc.type = type;
  osc.frequency.value = frequency;
  volume.gain.setValueAtTime(gain, ctx.currentTime);
  volume.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
  osc.connect(volume);
  volume.connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + duration);
}

function playEffect(type) {
  if (type === "tick") {
    duckBackgroundMusic(220);
    playTone({ frequency: 980, duration: 0.11, type: "square", gain: 0.18 });
    setTimeout(() => playTone({ frequency: 1320, duration: 0.06, type: "square", gain: 0.11 }), 46);
  } else if (type === "bomb") {
    playTone({ frequency: 120, duration: 0.14, type: "sawtooth", gain: 0.07 });
    setTimeout(() => playTone({ frequency: 80, duration: 0.18, type: "square", gain: 0.05 }), 70);
  } else {
    playTone({ frequency: 620, duration: 0.06, type: "triangle", gain: 0.025 });
  }
}

function duckBackgroundMusic(duration = 180) {
  const audio = state.musicAudio;
  if (!audio || audio.paused || !state.soundEnabled) return;
  audio.volume = 0.22;
  clearTimeout(duckBackgroundMusic.timer);
  duckBackgroundMusic.timer = setTimeout(() => {
    if (state.musicAudio && state.soundEnabled && !state.musicAudio.paused) {
      state.musicAudio.volume = 1;
    }
  }, duration);
}

function startBackgroundMusic(room) {
  const audio = ensureMusicAudio();
  if (!audio) return;
  audio.volume = 1;
  if (!state.soundEnabled) {
    audio.pause();
    return;
  }
  audio.play().catch(() => {});
}

function ensureMusicAudio() {
  if (state.musicAudio) return state.musicAudio;
  const audio = new Audio("/background-music.wav");
  audio.loop = true;
  audio.preload = "auto";
  audio.volume = 1;
  audio.setAttribute("playsinline", "");
  state.musicAudio = audio;
  return audio;
}

async function unlockAudio() {
  if (!state.soundEnabled) return;
  const ctx = await resumeAudioContext();
  const audio = ensureMusicAudio();
  if (audio) await audio.play().catch(() => {});
  if (ctx && state.audioUnlocked) playTone({ frequency: 523, duration: 0.04, type: "sine", gain: 0.006 });
  updateSoundButton();
}

function toggleSound() {
  state.soundEnabled = !state.soundEnabled;
  localStorage.setItem("undercover.soundEnabled", String(state.soundEnabled));
  if (!state.soundEnabled) {
    state.musicAudio?.pause();
    toast("已关闭声音");
  } else {
    unlockAudio();
    toast("已开启声音");
    startBackgroundMusic(state.room);
  }
  updateSoundButton();
}

function updateSoundButton() {
  refs.sound.textContent = state.soundEnabled ? "♪" : "×";
  refs.sound.title = state.soundEnabled ? "关闭声音" : "开启声音";
  refs.sound.setAttribute("aria-label", refs.sound.title);
  refs.sound.classList.toggle("muted", !state.soundEnabled);
}

function emit(event, payload = {}, reply) {
  socket.emit(event, { roomCode: state.roomCode, playerId: state.playerId, ...payload }, reply);
}

function request(event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

function showHome() {
  state.room = null;
  if (state.roomCode) refs.roomCodeInput.value = state.roomCode;
  refs.home.classList.remove("hidden");
  refs.footer.classList.remove("hidden");
  refs.roomHeader.classList.add("hidden");
  refs.secret.classList.add("hidden");
  refs.status.classList.add("hidden");
  refs.speakPanel.classList.add("hidden");
  refs.controls.classList.add("hidden");
  refs.messagesPanel.classList.add("hidden");
  refs.chatPanel.classList.add("hidden");
  refs.roomRulesButton.classList.add("hidden");
  refs.barragePanel.classList.add("hidden");
  refs.rulesModal.classList.add("hidden");
  refs.reviewModal.classList.add("hidden");
  refs.votePanel.classList.add("hidden");
  refs.playersPanel.classList.add("hidden");
  startBackgroundMusic(null);
}

function currentRoomFromPath() {
  const match = location.pathname.match(/\/room\/([A-Z0-9]+)/i);
  return match?.[1]?.toUpperCase() || "";
}

async function copyLink() {
  const link = roomLink();
  await navigator.clipboard?.writeText(link);
  toast("房间链接已复制");
}

async function shareRoom() {
  if (!state.roomCode) return toast("先创建或加入房间");
  const data = { title: "谁是卧底", text: "来加入我的谁是卧底房间", url: roomLink() };
  if (navigator.share) {
    await navigator.share(data).catch(() => {});
  } else {
    await copyLink();
  }
}

function roomLink() {
  return `${location.origin}/room/${state.roomCode}`;
}

function toast(message) {
  refs.toast.textContent = message;
  refs.toast.classList.remove("hidden");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => refs.toast.classList.add("hidden"), 2400);
}

function difficultyText(difficulty) {
  return { easy: "轻松", medium: "有点像", hard: "很迷惑" }[difficulty] || difficulty;
}

function formatScore(score) {
  if (score > 0) return `+${score}`;
  return String(score);
}

function leaderboardHtml(room) {
  if (!room.isSeriesFinal) return "";
  const leaders = room.leaderboard || [];
  const rows = leaders.map((player) => {
    const scoreClass = player.score > 0 ? "positive" : player.score < 0 ? "negative" : "";
    return `
      <div class="rank-row">
        <span class="rank-no">${player.rank}</span>
        <i style="background:${player.color}">${escapeHtml(player.nickname[0] || "玩")}</i>
        <strong>${escapeHtml(player.nickname)}</strong>
        <b class="${scoreClass}">${formatScore(player.score)}</b>
      </div>
    `;
  }).join("");
  return `
    <div class="leaderboard">
      <div class="leaderboard-title">三局总分排名</div>
      ${rows}
    </div>
  `;
}

function wasOptimisticBarrage(barrage) {
  const now = Date.now();
  state.optimisticBarrages = state.optimisticBarrages.filter((item) => now - item.createdAt < 3500);
  return state.optimisticBarrages.some((item) => (
    item.playerId === barrage.playerId
    && item.text === barrage.text
    && item.effect === barrage.effect
    && item.targetId === (barrage.targetId || "")
  ));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[char]);
}

showHome();
startBackgroundMusic(null);
