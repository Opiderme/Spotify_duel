// index.js - version multi-utilisateur avec Elo
const express = require("express");
const axios = require("axios");
const fs = require("fs");
const querystring = require("querystring");
const dotenv = require("dotenv");
dotenv.config();
const app = express();
const PORT = 8888;
const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const REDIRECT_URI = "https://spotify-duel.onrender.com/callback";
const SCOPES = [
  "user-library-read",
  "streaming",
  "user-read-email",
  "user-read-private",
  "user-modify-playback-state",
  "user-read-playback-state"
].join(" ");

app.use(express.json());
app.use(express.static("public"));

const TOKEN_FILE = "tokens.json";
let userTokens = {}; // En mémoire
let accessToken = process.env.ACCESS_TOKEN || "";
let refreshToken = process.env.REFRESH_TOKEN || "";
console.log("🧪 accessToken =", accessToken);
console.log("🧪 accessToken =", accessToken);



// Elo update
function updateElo(winner, loser, k = 32) {
  const ratingA = winner.elo;
  const ratingB = loser.elo;
  const expectedA = 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
  const expectedB = 1 / (1 + Math.pow(10, (ratingA - ratingB) / 400));
  winner.elo = Math.round(ratingA + k * (1 - expectedA));
  loser.elo = Math.round(ratingB + k * (0 - expectedB));
}

// Utilitaires fichiers par utilisateur
function getDbFile(userId) {
  return `database_${userId}.json`;
}

function loadUserData(userId) {
  const file = getDbFile(userId);
  if (fs.existsSync(file)) {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  }
  return { tracks: [], duelHistory: [] };
}

function saveUserData(userId, data) {
  fs.writeFileSync(getDbFile(userId), JSON.stringify(data, null, 2), "utf-8");
}

// Auth
app.get("/login", (req, res) => {
  const authUrl = `https://accounts.spotify.com/authorize?${querystring.stringify({
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
  })}`;
  res.redirect(authUrl);
  refreshAccessToken(); // Appel initial pour obtenir le token d'accès
});

app.get("/callback", async (req, res) => {
  const code = req.query.code || null;

  const tokenRes = await axios.post("https://accounts.spotify.com/api/token",
    new URLSearchParams({
      grant_type: "authorization_code",
      code: code,
      redirect_uri: REDIRECT_URI
    }),
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`,
      },
    }
  );

  const { access_token, refresh_token } = tokenRes.data;

  const meRes = await axios.get("https://api.spotify.com/v1/me", {
    headers: { Authorization: `Bearer ${access_token}` },
  });
  const userId = meRes.data.id;
  userTokens[userId] = { access_token, refresh_token };

  saveTokens(userTokens);
  res.redirect(`/duels.html?access_token=${access_token}&user_id=${userId}`);
});

app.get("/generate-duels", async (req, res) => {
  // Utilise le token global, pas celui passé en query
  try {
    let allTracks = [];
    let nextUrl = "https://api.spotify.com/v1/me/tracks?limit=50";
    while (nextUrl) {
      const response = await axios.get(nextUrl, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const pageTracks = response.data.items.map((item) => ({
        id: item.track.id,
        title: item.track.name,
        artist: item.track.artists.map(a => a.name).join(", "),
        image: item.track.album.images[0]?.url || "",
        link: item.track.external_urls.spotify,
        elo: 1000
      }));
      allTracks.push(...pageTracks);
      nextUrl = response.data.next;
    }
    const data = { tracks: allTracks, duelHistory: [] };
    saveDatabase({ duels: [], scores: {} });
    res.json({ message: "Musiques chargées", total: allTracks.length });
  } catch (err) {
    console.error("Erreur /generate-duels :", err.response?.data || err.message);
    res.status(500).json({ error: "Erreur lors du chargement des morceaux" });
  }
});

app.get("/next-duel", (req, res) => {
  const userId = req.query.user_id;
  const data = loadUserData(userId);
  const { tracks, duelHistory } = data;
  if (tracks.length < 2) return res.json({ message: "Pas assez de morceaux" });

  let i, j, duelId;
  let attempts = 0;
  do {
    i = Math.floor(Math.random() * tracks.length);
    j = Math.floor(Math.random() * tracks.length);
    duelId = `${tracks[i].id}_${tracks[j].id}`;
    attempts++;
  } while ((i === j || duelHistory.find(d => d.duelId === duelId)) && attempts < 100);

  if (attempts >= 100) {
    return res.json({ message: "Tous les duels possibles ont été faits." });
  }

  res.json({
    duelId,
    track1: tracks[i],
    track2: tracks[j],
  });
});

app.post("/vote", (req, res) => {
  const { winnerId, duelId, user_id } = req.body;
  const data = loadUserData(user_id);
  const { tracks, duelHistory } = data;

  const winner = tracks.find(t => t.id === winnerId);
  const [id1, id2] = duelId.split("_");
  const loser = tracks.find(t => t.id !== winnerId && (t.id === id1 || t.id === id2));

  if (!winner || !loser) return res.status(400).json({ error: "Morceau non trouvé." });

  updateElo(winner, loser);
  duelHistory.push({ duelId, winnerId, loserId: loser.id, timestamp: Date.now() });

  saveUserData(user_id, { tracks, duelHistory });
  res.json({ message: "Vote enregistré." });
});

app.get("/ranking", (req, res) => {
  const userId = req.query.user_id;
  const data = loadUserData(userId);
  const ranking = [...data.tracks].sort((a, b) => b.elo - a.elo).map((track, index) => ({
    ...track,
    rank: index + 1
  }));
  res.json({ ranking });
});

function saveTokens(tokens) {
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2), "utf-8");
}

function loadTokens() {
  if (fs.existsSync(TOKEN_FILE)) {
    return JSON.parse(fs.readFileSync(TOKEN_FILE, "utf-8"));
  }
  return {};
}

function saveDatabase(data) {
  try {
    fs.writeFileSync(database, JSON.stringify(data, null, 2), "utf-8");
    console.log("💾 Base de données sauvegardée.");
  } catch (err) {
    console.error("❌ Erreur lors de la sauvegarde de la base de données :", err.message);
  }
}


// =======================
// 🔁 Rafraîchissement auto du token
// =======================
async function refreshAccessToken() {
  console.log("🔁 Tentative de rafraîchissement du token...");
  try {
    const response = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`,
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    });

    const data = await response.json();

    if (data.access_token) {
      accessToken = data.access_token;
      console.log("✅ Nouveau token d'accès rafraîchi !");
    } else {
      console.error("❌ Échec du rafraîchissement :", data);
    }
  } catch (err) {
    console.error("❌ Erreur lors du refresh :", err.message);
  }
}

// ⏱ Rafraîchir toutes les 55 minutes
setInterval(refreshAccessToken, 55 * 60 * 1000);


userTokens = loadTokens();

app.listen(PORT, () => {
  console.log(`Serveur ❤️ en ligne sur http://localhost:${PORT}`);
});
