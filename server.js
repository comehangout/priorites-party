const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;
app.use(express.static("public"));

const rooms = new Map();
const clean = (s, max=40) => String(s || "").trim().replace(/\s+/g, " ").slice(0,max);
const code = () => crypto.randomBytes(3).toString("hex").toUpperCase();

function roomFor(socket) {
  const code = socket.data.room;
  return code && rooms.get(code);
}
function publicRoom(room) {
  return {
    code: room.code, hostId: room.hostId, phase: room.phase, round: room.round,
    totalRounds: room.totalRounds, players: [...room.players.values()].map(p => ({
      id:p.id, name:p.name, score:p.score, connected:p.connected
    })),
    proposals: room.phase === "rank" || room.phase === "reveal" || room.phase === "guess" || room.phase === "results" ? room.proposals : [],
    rankings: ["reveal","guess","results"].includes(room.phase) ? room.rankings.map((r,i)=>({id:i, items:r.items})) : [],
    guesses: room.phase === "results" ? Object.fromEntries([...room.guesses.entries()]) : {},
    results: room.phase === "results" ? room.results : null,
    history: room.history,
    message: room.message || ""
  };
}
function emitRoom(room) { io.to(room.code).emit("state", publicRoom(room)); }
function tell(socket, message) { socket.emit("errorMessage", message); }
function allSubmitted(room, field) {
  return [...room.players.keys()].every(id => room[field].has(id));
}
function resetRound(room) {
  room.proposals = [];
  room.ranks = new Map();
  room.rankings = [];
  room.guesses = new Map();
  room.results = null;
  room.message = "";
}
function nextPhase(room) {
  if (room.phase === "propose") {
    room.proposals = [...room.proposals].sort((a,b)=>a.playerId.localeCompare(b.playerId));
    room.phase = "rank";
  } else if (room.phase === "rank") {
    room.rankings = [...room.ranks.entries()].map(([playerId,items]) => ({playerId,items}));
    // Shuffle order so the ranking order doesn't reveal its author.
    for (let i=room.rankings.length-1;i>0;i--) {
      const j=Math.floor(Math.random()*(i+1));
      [room.rankings[i],room.rankings[j]]=[room.rankings[j],room.rankings[i]];
    }
    room.phase = "guess";
  } else if (room.phase === "guess") {
    const players = [...room.players.keys()];
    const roundPoints = {};
    for (const id of players) roundPoints[id] = 0;
    // Each player receives one point for each anonymous ranking they correctly identify.
    for (const guesserId of players) {
      const answers = room.guesses.get(guesserId) || {};
      for (const [rankingIndex, guessedPlayerId] of Object.entries(answers)) {
        const actualPlayerId = room.rankings[Number(rankingIndex)]?.playerId;
        if (actualPlayerId && guessedPlayerId === actualPlayerId) roundPoints[guesserId] += 1;
      }
    }
    for (const [id,p] of room.players) p.score += roundPoints[id] || 0;
    room.results = {
      roundPoints,
      rankings: room.rankings.map((r,index)=>({
        index, authorId:r.playerId, authorName:room.players.get(r.playerId)?.name || "Joueur",
        items:r.items
      })),
      guesses: Object.fromEntries([...room.guesses.entries()]),
      scores: [...room.players.values()].map(p=>({id:p.id,name:p.name,score:p.score,roundPoints:roundPoints[p.id]||0}))
        .sort((a,b)=>b.score-a.score || a.name.localeCompare(b.name))
    };
    room.history.push({round:room.round, results:room.results});
    room.phase = "results";
  }
  emitRoom(room);
}
io.on("connection", socket => {
  socket.on("createRoom", ({name,totalRounds}) => {
    name = clean(name);
    totalRounds = Math.max(1, Math.min(10, Number(totalRounds)||3));
    if (!name) return tell(socket,"Choisis un pseudo.");
    let c; do { c=code(); } while(rooms.has(c));
    const room = {code:c,hostId:socket.id,phase:"lobby",round:0,totalRounds,
      players:new Map(),proposals:[],ranks:new Map(),rankings:[],guesses:new Map(),
      results:null,history:[],message:""};
    room.players.set(socket.id,{id:socket.id,name,score:0,connected:true});
    rooms.set(c,room); socket.join(c); socket.data.room=c;
    socket.emit("joined",{code:c,playerId:socket.id}); emitRoom(room);
  });
  socket.on("joinRoom", ({name,roomCode}) => {
    name=clean(name); roomCode=clean(roomCode,6).toUpperCase();
    const room=rooms.get(roomCode);
    if (!name) return tell(socket,"Choisis un pseudo.");
    if (!room) return tell(socket,"Code de partie introuvable.");
    if (room.phase!=="lobby") return tell(socket,"La partie a déjà commencé.");
    if ([...room.players.values()].some(p=>p.name.toLowerCase()===name.toLowerCase())) return tell(socket,"Ce pseudo est déjà utilisé dans cette partie.");
    room.players.set(socket.id,{id:socket.id,name,score:0,connected:true});
    socket.join(room.code); socket.data.room=room.code;
    socket.emit("joined",{code:room.code,playerId:socket.id}); emitRoom(room);
  });
  socket.on("startGame", () => {
    const room=roomFor(socket); if(!room) return;
    if(socket.id!==room.hostId) return tell(socket,"Seul le créateur peut lancer la partie.");
    if(room.phase!=="lobby") return;
    if(room.players.size<2) return tell(socket,"Il faut au moins 2 joueurs pour commencer.");
    room.round=1; resetRound(room); room.phase="propose"; emitRoom(room);
  });
  socket.on("submitProposal", ({text}) => {
    const room=roomFor(socket); if(!room || room.phase!=="propose") return;
    text=clean(text,100);
    if(!text) return tell(socket,"Écris une proposition avant de valider.");
    if(room.proposals.some(p=>p.playerId===socket.id)) return tell(socket,"Ta proposition est déjà validée.");
    if(room.proposals.some(p=>p.text.toLowerCase()===text.toLowerCase())) return tell(socket,"Cette proposition existe déjà : choisis-en une autre.");
    room.proposals.push({playerId:socket.id,text});
    if(room.proposals.length===room.players.size) nextPhase(room); else emitRoom(room);
  });
  socket.on("submitRanking", ({items}) => {
    const room=roomFor(socket); if(!room || room.phase!=="rank") return;
    if(room.ranks.has(socket.id)) return tell(socket,"Ton classement est déjà validé.");
    if(!Array.isArray(items) || items.length!==room.proposals.length ||
       new Set(items).size!==items.length || items.some(x=>!room.proposals.some(p=>p.text===x))) return tell(socket,"Classement invalide, recommence.");
    room.ranks.set(socket.id,items);
    if(allSubmitted(room,"ranks")) nextPhase(room); else emitRoom(room);
  });
  socket.on("submitGuesses", ({assignments}) => {
    const room=roomFor(socket); if(!room || room.phase!=="guess") return;
    if(room.guesses.has(socket.id)) return tell(socket,"Tes associations sont déjà validées.");
    if(!assignments || typeof assignments!=="object") return tell(socket,"Associations invalides.");
    const keys=Object.keys(assignments);
    if(keys.length!==room.rankings.length || new Set(Object.values(assignments)).size!==room.rankings.length ||
      keys.some(k=>!room.rankings[Number(k)]) ||
      Object.values(assignments).some(id=>!room.players.has(id))) return tell(socket,"Associe chaque classement à un joueur différent.");
    room.guesses.set(socket.id,assignments);
    if(allSubmitted(room,"guesses")) nextPhase(room); else emitRoom(room);
  });
  socket.on("nextRound", () => {
    const room=roomFor(socket); if(!room || socket.id!==room.hostId || room.phase!=="results") return;
    if(room.round>=room.totalRounds) { room.phase="final"; emitRoom(room); return; }
    room.round++; resetRound(room); room.phase="propose"; emitRoom(room);
  });
  socket.on("showFinal", () => {
    const room=roomFor(socket); if(!room || socket.id!==room.hostId) return;
    if(room.phase==="results" && room.round>=room.totalRounds) {room.phase="final";emitRoom(room);}
  });
  socket.on("disconnect", () => {
    const room=roomFor(socket); if(!room) return;
    const p=room.players.get(socket.id); if(p) p.connected=false;
    // A disconnected participant is retained to avoid losing the round; game owner can restart if needed.
    emitRoom(room);
    setTimeout(()=>{
      const r=rooms.get(room.code);
      if(r && r.phase==="lobby" && r.players.get(socket.id)?.connected===false) {
        r.players.delete(socket.id);
        if(r.hostId===socket.id) r.hostId=r.players.keys().next().value || null;
        if(r.players.size===0) rooms.delete(r.code); else emitRoom(r);
      }
    },60000);
  });
});
server.listen(PORT,()=>console.log(`Priorités Party prêt sur le port ${PORT}`));
