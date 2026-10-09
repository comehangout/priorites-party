const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;
app.use(express.static(path.join(__dirname, "public")));

// Render persistent disk: set DATA_DIR=/var/data. Without a persistent disk,
// this file still protects state during the lifetime of the running instance,
// but the host may erase it when the service restarts.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "rooms.json");
const rooms = new Map();
const clean = (s, max = 40) => String(s || "").trim().replace(/\s+/g, " ").slice(0, max);
const roomCode = () => crypto.randomBytes(3).toString("hex").toUpperCase();
const token = () => crypto.randomBytes(24).toString("hex");

function encodeRoom(r) {
  return {
    ...r,
    players: [...r.players.entries()],
    proposals: r.proposals,
    ranks: [...r.ranks.entries()],
    rankings: r.rankings,
    guesses: [...r.guesses.entries()],
    history: r.history,
    roundParticipants: [...r.roundParticipants]
  };
}
function decodeRoom(r) {
  return {
    ...r,
    players: new Map(r.players || []),
    ranks: new Map(r.ranks || []),
    guesses: new Map(r.guesses || []),
    roundParticipants: new Set(r.roundParticipants || []),
    proposals: r.proposals || [], rankings: r.rankings || [], history: r.history || []
  };
}
function saveRooms() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DATA_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify([...rooms.values()].map(encodeRoom)), "utf8");
    fs.renameSync(tmp, DATA_FILE);
  } catch (err) {
    console.error("Impossible de sauvegarder les salons :", err.message);
  }
}
try {
  if (fs.existsSync(DATA_FILE)) {
    const saved = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    for (const raw of saved) {
      const r = decodeRoom(raw);
      for (const p of r.players.values()) p.connected = false;
      rooms.set(r.code, r);
    }
    console.log(`${rooms.size} salon(s) restauré(s) depuis le stockage local.`);
  }
} catch (err) {
  console.error("Lecture des salons sauvegardés impossible :", err.message);
}

function roomFor(socket) {
  const c = socket.data.room;
  return c && rooms.get(c);
}
function playerFor(room, socket) {
  return room && room.players.get(socket.data.playerId);
}
function connectedIds(room) {
  return [...room.players.values()].filter(p => p.connected).map(p => p.id);
}
function publicRoom(room) {
  return {
    code: room.code, hostId: room.hostId, phase: room.phase, round: room.round,
    totalRounds: room.totalRounds,
    players: [...room.players.values()].map(p => ({ id: p.id, name: p.name, score: p.score, connected: p.connected })),
    proposals: ["rank", "reveal", "guess", "results", "final"].includes(room.phase) ? room.proposals : [],
    rankings: ["guess", "results", "final"].includes(room.phase) ? room.rankings.map(r => ({ items: r.items })) : [],
    guesses: ["results", "final"].includes(room.phase) ? Object.fromEntries(room.guesses) : {},
    results: ["results", "final"].includes(room.phase) ? room.results : null,
    history: room.history,
    progress: { connected: connectedIds(room).length, proposals: room.proposals.length, rankings: room.ranks.size, guesses: room.guesses.size },
    message: room.message || ""
  };
}
function privateState(room, playerId) {
  return {
    playerId,
    hasProposal: room.proposals.some(p => p.playerId === playerId),
    hasRank: room.ranks.has(playerId),
    hasGuesses: room.guesses.has(playerId),
    ownRank: room.ranks.get(playerId) || null,
    ownGuesses: room.guesses.get(playerId) || null
  };
}
function emitRoom(room) {
  io.to(room.code).emit("state", publicRoom(room));
  for (const p of room.players.values()) {
    if (!p.connected || !p.socketId) continue;
    io.to(p.socketId).emit("privateState", privateState(room, p.id));
  }
  saveRooms();
}
function tell(socket, message) { socket.emit("errorMessage", message); }
function resetRound(room) {
  room.proposals = [];
  room.ranks = new Map();
  room.rankings = [];
  room.guesses = new Map();
  room.results = null;
  room.roundParticipants = new Set(connectedIds(room));
  room.message = "";
}
function calculateResults(room) {
  const roundPoints = {};
  for (const id of room.players.keys()) roundPoints[id] = 0;
  for (const [guesserId, answers] of room.guesses.entries()) {
    for (const [rankingIndex, guessedPlayerId] of Object.entries(answers)) {
      const actualPlayerId = room.rankings[Number(rankingIndex)]?.playerId;
      if (actualPlayerId && guessedPlayerId === actualPlayerId) roundPoints[guesserId] = (roundPoints[guesserId] || 0) + 1;
    }
  }
  for (const [id, p] of room.players) p.score += roundPoints[id] || 0;
  room.results = {
    roundPoints,
    rankings: room.rankings.map((r, index) => ({
      index, authorId: r.playerId, authorName: room.players.get(r.playerId)?.name || "Joueur",
      items: r.items
    })),
    guesses: Object.fromEntries(room.guesses.entries()),
    scores: [...room.players.values()].map(p => ({ id: p.id, name: p.name, score: p.score, roundPoints: roundPoints[p.id] || 0 }))
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
  };
  room.history.push({ round: room.round, results: room.results });
  room.phase = "results";
}
function nextPhase(room) {
  if (room.phase === "propose") {
    room.proposals = [...room.proposals].sort((a, b) => a.playerId.localeCompare(b.playerId));
    room.phase = "rank";
  } else if (room.phase === "rank") {
    room.rankings = [...room.ranks.entries()].map(([playerId, items]) => ({ playerId, items }));
    for (let i = room.rankings.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [room.rankings[i], room.rankings[j]] = [room.rankings[j], room.rankings[i]];
    }
    room.phase = "guess";
  } else if (room.phase === "guess") {
    calculateResults(room);
  }
  emitRoom(room);
}
// A disconnected player who has not submitted cannot freeze the current phase for everybody else.
function phaseSubmitted(room, field) {
  const ids = connectedIds(room);
  if (!ids.length) return false;
  if (field === "proposalIds") return ids.every(id => room.proposals.some(p => p.playerId === id));
  return ids.every(id => room[field].has(id));
}
function checkAdvance(room) {
  if (room.phase === "propose" && phaseSubmitted(room, "proposalIds")) nextPhase(room);
  else if (room.phase === "rank" && phaseSubmitted(room, "ranks")) nextPhase(room);
  else if (room.phase === "guess" && phaseSubmitted(room, "guesses")) nextPhase(room);
}
function attachPlayer(socket, room, player, resumeToken) {
  player.connected = true;
  player.socketId = socket.id;
  player.resumeToken = resumeToken || player.resumeToken || token();
  socket.join(room.code);
  socket.data.room = room.code;
  socket.data.playerId = player.id;
  socket.emit("joined", { code: room.code, playerId: player.id, resumeToken: player.resumeToken, name: player.name, phase: room.phase });
  emitRoom(room);
}
function makeRoom(name, totalRounds, socket) {
  let c;
  do { c = roomCode(); } while (rooms.has(c));
  const id = crypto.randomUUID();
  const resumeToken = token();
  const player = { id, name, score: 0, connected: true, socketId: socket.id, resumeToken };
  const room = {
    code: c, hostId: id, phase: "lobby", round: 0, totalRounds,
    players: new Map([[id, player]]), proposals: [], ranks: new Map(), rankings: [], guesses: new Map(),
    results: null, history: [], roundParticipants: new Set([id]), message: ""
  };
  rooms.set(c, room);
  socket.join(c); socket.data.room = c; socket.data.playerId = id;
  socket.emit("joined", { code: c, playerId: id, resumeToken, name, phase: room.phase });
  emitRoom(room);
}
io.on("connection", socket => {
  socket.on("createRoom", ({ name, totalRounds }) => {
    name = clean(name);
    totalRounds = Math.max(1, Math.min(10, Number(totalRounds) || 3));
    if (!name) return tell(socket, "Choisis un pseudo.");
    makeRoom(name, totalRounds, socket);
  });
  socket.on("joinRoom", ({ name, roomCode: rawCode }) => {
    name = clean(name); const c = clean(rawCode, 6).toUpperCase(); const room = rooms.get(c);
    if (!name) return tell(socket, "Choisis un pseudo.");
    if (!room) return tell(socket, "Code de partie introuvable. Si le serveur a redémarré, le salon peut avoir expiré.");
    const old = [...room.players.values()].find(p => p.name.toLowerCase() === name.toLowerCase());
    if (old) {
      if (old.connected) return tell(socket, "Ce pseudo est déjà connecté dans cette partie.");
      // Code + exact pseudo allows recovery when the browser's saved token was lost.
      return attachPlayer(socket, room, old, old.resumeToken);
    }
    if (room.phase !== "lobby") return tell(socket, "La partie a déjà commencé. Pour la rejoindre, utilise le même pseudo qu'avant.");
    const id = crypto.randomUUID(); const resumeToken = token();
    const p = { id, name, score: 0, connected: true, socketId: socket.id, resumeToken };
    room.players.set(id, p); socket.join(room.code); socket.data.room = room.code; socket.data.playerId = id;
    socket.emit("joined", { code: room.code, playerId: id, resumeToken, name, phase: room.phase }); emitRoom(room);
  });
  socket.on("resumeRoom", ({ roomCode: rawCode, resumeToken }) => {
    const c = clean(rawCode, 6).toUpperCase(); const room = rooms.get(c);
    if (!room || !resumeToken) return socket.emit("resumeFailed", { message: "Impossible de retrouver ce salon. Utilise le code et ton pseudo pour essayer de revenir." });
    const player = [...room.players.values()].find(p => p.resumeToken === resumeToken);
    if (!player) return socket.emit("resumeFailed", { message: "La session enregistrée n'est plus valide. Rejoins avec le code et le même pseudo." });
    attachPlayer(socket, room, player, resumeToken);
    checkAdvance(room);
  });
  socket.on("startGame", () => {
    const room = roomFor(socket); if (!room) return;
    if (socket.data.playerId !== room.hostId) return tell(socket, "Seul le créateur peut lancer la partie.");
    if (room.phase !== "lobby") return;
    if (connectedIds(room).length < 2) return tell(socket, "Il faut au moins 2 joueurs connectés pour commencer.");
    room.round = 1; resetRound(room); room.phase = "propose"; emitRoom(room);
  });
  socket.on("submitProposal", ({ text }) => {
    const room = roomFor(socket); const p = playerFor(room, socket); if (!room || !p || room.phase !== "propose") return;
    text = clean(text, 100); if (!text) return tell(socket, "Écris une proposition avant de valider.");
    if (room.proposals.some(x => x.playerId === p.id)) return tell(socket, "Ta proposition est déjà validée.");
    if (room.proposals.some(x => x.text.toLowerCase() === text.toLowerCase())) return tell(socket, "Cette proposition existe déjà : choisis-en une autre.");
    room.proposals.push({ playerId: p.id, text }); checkAdvance(room);
    if (room.phase === "propose") emitRoom(room);
  });
  socket.on("submitRanking", ({ items }) => {
    const room = roomFor(socket); const p = playerFor(room, socket); if (!room || !p || room.phase !== "rank") return;
    if (room.ranks.has(p.id)) return tell(socket, "Ton classement est déjà validé et conservé.");
    if (!Array.isArray(items) || items.length !== room.proposals.length || new Set(items).size !== items.length || items.some(x => !room.proposals.some(pr => pr.text === x))) return tell(socket, "Classement invalide, recommence.");
    room.ranks.set(p.id, items); checkAdvance(room); if (room.phase === "rank") emitRoom(room);
  });
  socket.on("submitGuesses", ({ assignments }) => {
    const room = roomFor(socket); const p = playerFor(room, socket); if (!room || !p || room.phase !== "guess") return;
    if (room.guesses.has(p.id)) return tell(socket, "Tes associations sont déjà validées et conservées.");
    if (!assignments || typeof assignments !== "object") return tell(socket, "Associations invalides.");
    const keys = Object.keys(assignments);
    if (keys.length !== room.rankings.length || new Set(Object.values(assignments)).size !== room.rankings.length || keys.some(k => !room.rankings[Number(k)]) || Object.values(assignments).some(id => !room.players.has(id))) return tell(socket, "Associe chaque classement à un joueur différent.");
    room.guesses.set(p.id, assignments); checkAdvance(room); if (room.phase === "guess") emitRoom(room);
  });
  socket.on("nextRound", () => {
    const room = roomFor(socket); if (!room || socket.data.playerId !== room.hostId || room.phase !== "results") return;
    if (room.round >= room.totalRounds) { room.phase = "final"; emitRoom(room); return; }
    room.round++; resetRound(room); room.phase = "propose"; emitRoom(room);
  });
  socket.on("showFinal", () => {
    const room = roomFor(socket); if (!room || socket.data.playerId !== room.hostId) return;
    if (room.phase === "results" && room.round >= room.totalRounds) { room.phase = "final"; emitRoom(room); }
  });
  socket.on("disconnect", () => {
    const room = roomFor(socket); if (!room) return;
    const p = room.players.get(socket.data.playerId);
    if (p && p.socketId === socket.id) { p.connected = false; p.socketId = null; }
    // The game continues when all remaining connected players have submitted.
    if (room.hostId === socket.data.playerId) {
      const nextHost = [...room.players.values()].find(x => x.connected);
      if (nextHost) room.hostId = nextHost.id;
    }
    emitRoom(room); checkAdvance(room);
  });
});
server.listen(PORT, () => console.log(`Priorités Party prêt sur le port ${PORT}`));
