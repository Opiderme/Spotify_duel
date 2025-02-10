// index.js
const express = require("express");
const axios = require("axios");
const fs = require("fs");
const querystring = require("querystring");
const dotenv = require("dotenv");
import("open").then((open) => open.default("http://localhost:8888/login"));

dotenv.config();
const app = express();
const PORT = 8888;
const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const REDIRECT_URI = "http://localhost:8888/callback";
const SCOPES = "user-library-read playlist-modify-private playlist-modify-public";

app.use(express.json());
app.use(express.static("public"));

const DB_FILE = "database.json";

function loadDatabase() {
  if (fs.existsSync(DB_FILE)) {
    return JSON.parse(fs.readFileSync(DB_FILE, "utf-8"));
  }
  return { duels: [], scores: {} };
}

function saveDatabase(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), "utf-8");
}

let { duels, scores } = loadDatabase();

app.get("/login", (req, res) => {
  const authUrl = `https://accounts.spotify.com/authorize?${querystring.stringify({
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
  })}`;
  res.redirect(authUrl);
});

app.get("/callback", async (req, res) => {
  const code = req.query.code || null;
  try {
    const response = await axios.post(
      "https://accounts.spotify.com/api/token",
      querystring.stringify({
        grant_type: "authorization_code",
        code: code,
        redirect_uri: REDIRECT_URI,
      }),
      {
        headers: {
          Authorization: "Basic " + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64"),
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );
    const { access_token } = response.data;
    res.redirect(`/duels.html?access_token=${access_token}`);
  } catch (error) {
    console.error("Erreur lors de l'authentification :", error.response.data);
    res.send("Erreur lors de l'authentification.");
  }
});

app.get("/generate-duels", async (req, res) => {
  const accessToken = req.query.access_token;
  
  // Charger la base de données
  let database = loadDatabase();
  if (database.duels && database.duels.length > 0) {
    duels = database.duels;
    scores = database.scores;
    return res.json({ message: "Duels chargés depuis la base de données", totalDuels: duels.length });
  }
  
  try {
    let allTracks = [];
    let nextUrl = "https://api.spotify.com/v1/me/tracks?limit=20";
    while (nextUrl) {
      const response = await axios.get(nextUrl, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const tracks = response.data.items.map((item) => ({
        id: item.track.id,
        title: item.track.name,
        artist: item.track.artists.map((artist) => artist.name).join(", "),
        image: item.track.album.images[0]?.url || "",
        link: item.track.external_urls.spotify,
      }));
      allTracks.push(...tracks);
      nextUrl = response.data.next;
    }
    
    // Initialiser les scores
    scores = {};
    allTracks.forEach(track => {
      scores[track.id] = 0;
    });
    
    // Générer les duels : chaque paire unique (i < j)
    duels = [];
    for (let i = 0; i < allTracks.length; i++) {
      for (let j = i + 1; j < allTracks.length; j++) {
        duels.push({
          id: `${allTracks[i].id}_${allTracks[j].id}`,
          track1: allTracks[i],
          track2: allTracks[j],
          voted: false,
          winner: null,
        });
      }
    }
    
    // Mélanger aléatoirement les duels (Fisher-Yates)
    for (let i = duels.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [duels[i], duels[j]] = [duels[j], duels[i]];
    }
    
    saveDatabase({ duels, scores });
    res.json({ message: "Duels générés", totalDuels: duels.length });
  } catch (error) {
    console.error("Erreur lors de la génération des duels :", error.response?.data || error.message);
    res.status(500).send("Erreur lors de la génération des duels.");
  }
});

app.get("/next-duel", (req, res) => {
  if (!duels || duels.length === 0) {
    return res.status(500).json({ error: "Aucun duel disponible. Vérifiez la génération des duels." });
  }
  const nextDuel = duels.find((duel) => !duel.voted);
  if (nextDuel) {
    res.json(nextDuel);
  } else {
    res.json({ message: "Tous les duels sont terminés." });
  }
});

app.get("/progress", (req, res) => {
  if (!duels) return res.status(500).json({ error: "Aucun duel disponible." });
  const total = duels.length;
  const completed = duels.filter((d) => d.voted).length;
  const progress = total > 0 ? (completed / total) * 100 : 0;
  res.json({ total, completed, progress: progress.toFixed(2) });
});

app.post("/vote", (req, res) => {
  const { duelId, winnerId } = req.body;
  const duel = duels.find((d) => d.id === duelId);
  if (!duel || duel.voted) {
    return res.status(400).json({ error: "Duel non trouvé ou déjà voté." });
  }
  duel.voted = true;
  duel.winner = winnerId;
  scores[winnerId] = (scores[winnerId] || 0) + 1;
  saveDatabase({ duels, scores });
  res.json({ message: "Vote enregistré" });
});

app.get("/ranking", (req, res) => {
  let trackMap = {};
  duels.forEach((duel) => {
    trackMap[duel.track1.id] = duel.track1;
    trackMap[duel.track2.id] = duel.track2;
  });
  const ranking = Object.keys(scores)
    .map(trackId => ({
      ...trackMap[trackId],
      score: scores[trackId]
    }))
    .sort((a, b) => b.score - a.score);
  res.json({ ranking });
});

app.post("/create-playlist", async (req, res) => {
  const accessToken = req.body.access_token;
  if (!accessToken) {
    return res.status(400).json({ error: "Access token manquant." });
  }
  try {
    // 1. Récupérer l'ID de l'utilisateur connecté
    const meResponse = await axios.get("https://api.spotify.com/v1/me", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const userId = meResponse.data.id;

    // 2. Recalculer le classement à partir de 'duels' et 'scores'
    let trackMap = {};
    duels.forEach(duel => {
      trackMap[duel.track1.id] = duel.track1;
      trackMap[duel.track2.id] = duel.track2;
    });
    const ranking = Object.keys(scores)
      .map(trackId => ({
        ...trackMap[trackId],
        score: scores[trackId]
      }))
      .sort((a, b) => b.score - a.score);

    // 3. Préparer la liste des URI dans l'ordre du classement
    const trackUris = ranking.map(track => `spotify:track:${track.id}`);

    // 4. Créer une nouvelle playlist
    const createPlaylistResponse = await axios.post(
      `https://api.spotify.com/v1/users/${userId}/playlists`,
      {
        name: "Playlist Triée par Duels",
        description: "Playlist générée automatiquement par mon app",
        public: false,
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );
    const playlistId = createPlaylistResponse.data.id;

    // 5. Ajouter les pistes à la playlist en plusieurs requêtes (100 par requête)
    const chunkSize = 50;
    for (let i = 0; i < trackUris.length; i += chunkSize) {
      const chunk = trackUris.slice(i, i + chunkSize);
      await axios.post(
        `https://api.spotify.com/v1/playlists/${playlistId}/tracks`,
        { uris: chunk },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
        }
      );
    }

    res.json({
      message: "Playlist créée avec succès !",
      playlistId,
      playlistUrl: createPlaylistResponse.data.external_urls.spotify,
    });
  } catch (error) {
    console.error("Erreur lors de la création de la playlist :", error.response ? error.response.data : error.message);
    res.status(500).json({ error: "Erreur lors de la création de la playlist" });
  }
});



app.listen(PORT, () => {
  console.log(`Serveur démarré sur http://localhost:${PORT}`);
});
