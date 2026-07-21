const socket = io();
const state = {
  playerId: localStorage.getItem("undercover.playerId") || crypto.randomUUID(),
  nickname: localStorage.getItem("undercover.nickname") || "",
  roomCode: currentRoomFromPath(),
  room: null,
  clockOffset: 0,
  pendingVoteTargetId: "",
  timerId: null,
  recorder: null,
  chunks: [],
  recordingStartedAt: 0
};

const $ = (id) => document.getElementById(id);
const refs = {
  home: $("homeView"),
  nickname: $("nicknameInput"),
  roomCodeInput: $("roomCodeInput"),
  create: $("createRoomButton"),
  join: $("joinRoomButton"),
  roomHeader: $("roomHeader"),
  roomCodeText: $("roomCodeText"),
  copyLink: $("copyLinkButton"),
  share: $("shareButton"),
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
  record: $("recordButton"),
  recordHint: $("recordHint"),
  controls: $("hostControls"),
  messagesPanel: $("messagesPanel"),
  messageList: $("messageList"),
  messageCount: $("messageCount"),
  votePanel: $("votePanel"),
  voteGrid: $("voteGrid"),
  confirmVote: $("confirmVoteButton"),
  playersPanel: $("playersPanel"),
  playerList: $("playerList"),
  playerCount: $("playerCount"),
  toast: $("toast")
};

refs.nickname.value = state.nickname;
if (state.roomCode) refs.roomCodeInput.value = state.roomCode;

refs.create.addEventListener("click", createRoom);
refs.join.addEventListener("click", joinRoom);
refs.copyLink.addEventListener("click", copyLink);
refs.share.addEventListener("click", shareRoom);
refs.sendSpeech.addEventListener("click", sendTextSpeech);
refs.record.addEventListener("click", toggleRecording);
refs.confirmVote.addEventListener("click", confirmVote);

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
  renderSpeechComposer(room, isMyTurn, me);
  renderVotes(room, me);
  startTimer(room);
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

  if (room.phase === "lobby") {
    refs.statusTitle.textContent = room.players.length < 3 ? "再邀请几位朋友" : "人数够了，房主可以开局";
    refs.statusDetail.textContent = "其他玩家准备好后，房主开始游戏。3-5 人投错卧底直接胜；6 人及以上第一次投错会淘汰被投玩家，每人再发言一次，第二次仍没投中则卧底胜。投中卧底则平民胜。";
  } else if (room.phase === "speaking") {
    const speaker = room.players.find((player) => player.id === room.currentSpeakerId);
    const stageRound = room.round - (room.speechStageStartRound || 1) + 1;
    const totalRounds = room.speechRoundsInStage || room.speechRoundsBeforeVote;
    refs.statusTitle.textContent = totalRounds === 1 && room.round > 3
      ? `加时发言：${speaker?.nickname || "下一位"} 发言`
      : `第 ${stageRound}/${totalRounds} 轮：${speaker?.nickname || "下一位"} 发言`;
    refs.statusDetail.textContent = "每人 30 秒，提前提交会自动轮到下一位。";
  } else if (room.phase === "voting") {
    const submitted = room.players.filter((player) => !player.eliminated && player.hasVoted).length;
    const total = room.players.filter((player) => !player.eliminated).length;
    refs.statusTitle.textContent = me?.hasVoted ? "等待其他人提交" : "选择你怀疑的人";
    const missing = room.players.filter((player) => !player.eliminated && !player.hasVoted).map((player) => player.nickname);
    refs.statusDetail.innerHTML = `
      <span class="vote-progress"><span style="width:${Math.round((submitted / total) * 100)}%"></span></span>
      <span class="progress-line">投票进度 ${submitted}/${total}${missing.length ? ` · 未提交：${escapeHtml(missing.join("、"))}` : " · 正在公布"}</span>
    `;
  } else if (room.phase === "ended") {
    refs.statusTitle.textContent = room.result?.winner === "civilians" ? "平民获胜" : "卧底获胜";
    refs.statusDetail.innerHTML = resultHtml(room);
  }
}

function renderPlayers(room) {
  refs.playerList.innerHTML = "";
  refs.playersPanel.classList.toggle("compact", room.phase !== "lobby");
  for (const player of room.players) {
    if (room.phase !== "lobby" && player.id !== state.playerId && player.id !== room.currentSpeakerId && !player.eliminated) {
      continue;
    }
    const item = document.createElement("div");
    item.className = "player";
    const badges = [
      player.isHost ? `<span class="badge host">房主</span>` : "",
      player.ready && room.phase === "lobby" ? `<span class="badge ready">已准备</span>` : "",
      player.id === state.playerId ? `<span class="badge">你</span>` : "",
      player.id === room.currentSpeakerId ? `<span class="badge host">发言中</span>` : "",
      player.eliminated ? `<span class="badge out">淘汰</span>` : "",
      !player.connected ? `<span class="badge offline">离线</span>` : "",
      player.hasVoted && room.phase === "voting" ? `<span class="badge">已投</span>` : "",
      room.reveal?.undercoverId === player.id ? `<span class="badge host">卧底</span>` : ""
    ].join("");
    const scoreClass = player.score > 0 ? "positive" : player.score < 0 ? "negative" : "";
    item.innerHTML = `
      <div class="avatar" style="background:${player.color}">${escapeHtml(player.nickname[0] || "玩")}</div>
      <div>
        <div class="name">${escapeHtml(player.nickname)}</div>
        <div class="badges">${badges}</div>
      </div>
      <div class="score ${scoreClass}">${formatScore(player.score)}</div>
    `;
    refs.playerList.appendChild(item);
  }
}

function renderControls(room, isHost, me) {
  refs.controls.innerHTML = "";
  if (renderReadyControl(room, me, isHost)) return;
  refs.controls.classList.toggle("hidden", !isHost);
  if (!isHost) return;

  if (room.phase === "lobby") {
    const readyToStart = room.players.length >= 3 && room.players.every((player) => player.isHost || player.ready);
    addControl(readyToStart ? "开始游戏" : "等待玩家准备", "wide", () => emit("game:start"), !readyToStart);
  } else if (room.phase === "speaking") {
    addControl("跳过当前发言", "wide secondary", () => emit("speech:next"));
  } else if (room.phase === "voting") {
    const activePlayers = room.players.filter((player) => !player.eliminated);
    const allVoted = activePlayers.every((player) => player.hasVoted);
    addControl(allVoted ? "即将公布" : "催促未提交", "wide secondary", () => emit("vote:remind"), allVoted);
  } else if (room.phase === "ended") {
    addControl("继续下一把", "wide", () => emit("game:restart"));
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
  refs.messagesPanel.classList.toggle("hidden", room.phase === "lobby" && room.messages.length === 0);
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

function renderSpeechComposer(room, isMyTurn, me) {
  refs.speakPanel.classList.toggle("hidden", !isMyTurn || Boolean(me?.eliminated));
  refs.sendSpeech.disabled = !isMyTurn;
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
    return;
  }

  const myVote = room.votes.find((vote) => vote.voterId === state.playerId)?.targetId;
  if (myVote) state.pendingVoteTargetId = myVote;
  refs.confirmVote.disabled = Boolean(me?.eliminated) || !state.pendingVoteTargetId;
  refs.confirmVote.textContent = myVote ? "修改并提交" : "确定提交";
  for (const player of room.players.filter((item) => !item.eliminated)) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `vote-card ${state.pendingVoteTargetId === player.id ? "selected" : ""}`;
    button.disabled = me?.eliminated;
    button.innerHTML = `
      <div class="avatar" style="background:${player.color}">${escapeHtml(player.nickname[0] || "玩")}</div>
      <div>
        <strong>${escapeHtml(player.nickname)}</strong>
        <small>${player.id === state.playerId ? "你自己也可以被选择" : "候选玩家"}</small>
      </div>
      <span class="vote-status ${player.hasVoted ? "done" : ""}">${player.hasVoted ? "已投" : "未投"}</span>
    `;
    button.addEventListener("click", () => {
      state.pendingVoteTargetId = player.id;
      renderVotes(room, me);
    });
    refs.voteGrid.appendChild(button);
  }
}

function confirmVote() {
  if (!state.pendingVoteTargetId) return toast("先选择一名玩家");
  emit("vote:cast", { targetId: state.pendingVoteTargetId });
}

function resultHtml(room) {
  const reveal = room.reveal || {};
  const undercover = room.players.find((player) => player.id === reveal.undercoverId);
  const votedOut = room.players.find((player) => player.id === reveal.votedOutId);
  const civilians = room.players.filter((player) => player.id !== reveal.undercoverId);
  const scoreItems = room.players.map((player) => {
    const change = reveal.scoreChanges?.[player.id] || 0;
    const className = change >= 0 ? "positive" : "negative";
    return `<span class="result-chip"><i style="background:${player.color}">${escapeHtml(player.nickname[0] || "玩")}</i>${escapeHtml(player.nickname)} <b class="${className}">${formatScore(change)}</b></span>`;
  }).join("");

  return `
    <div class="result-stage">
      <div class="winner-banner">${room.result?.winner === "civilians" ? "平民阵营胜利" : "卧底胜利"}</div>
      <p>${escapeHtml(room.result?.reason || "")}</p>
      <div class="result-teams">
        <div class="team-card undercover">
          <span>卧底</span>
          <div class="avatar" style="background:${undercover?.color || reveal.undercoverColor}">${escapeHtml((undercover?.nickname || reveal.undercoverName || "卧")[0])}</div>
          <strong>${escapeHtml(undercover?.nickname || reveal.undercoverName || "未知")}</strong>
          <em>${escapeHtml(reveal.undercoverWord || "")}</em>
        </div>
        <div class="team-card civilians">
          <span>平民</span>
          <div class="mini-avatars">${civilians.map((player) => `<i style="background:${player.color}">${escapeHtml(player.nickname[0] || "玩")}</i>`).join("")}</div>
          <strong>${civilians.map((player) => escapeHtml(player.nickname)).join("、")}</strong>
          <em>${escapeHtml(reveal.civilianWord || "")}</em>
        </div>
      </div>
      <div class="result-line"><span>被投出</span><strong>${escapeHtml(votedOut?.nickname || reveal.votedOutName || "无")}</strong></div>
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
  return true;
}

function startTimer(room) {
  clearInterval(state.timerId);
  refs.timer.classList.add("hidden");
  refs.timer.classList.remove("danger");

  if (room.phase !== "speaking" || !room.currentSpeakerStartedAt || room.allSpoken) return;

  const tick = () => {
    const serverNow = Date.now() - state.clockOffset;
    const elapsed = Math.floor((serverNow - room.currentSpeakerStartedAt) / 1000);
    const remaining = Math.max(0, room.speechSeconds - elapsed);
    refs.timer.textContent = String(remaining);
    refs.timer.classList.remove("hidden");
    refs.timer.classList.toggle("danger", remaining <= 5);
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
    setTimeout(() => stopRecording(true), 30_000);
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
  refs.roomHeader.classList.add("hidden");
  refs.secret.classList.add("hidden");
  refs.status.classList.add("hidden");
  refs.speakPanel.classList.add("hidden");
  refs.controls.classList.add("hidden");
  refs.messagesPanel.classList.add("hidden");
  refs.votePanel.classList.add("hidden");
  refs.playersPanel.classList.add("hidden");
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
