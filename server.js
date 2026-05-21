const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const path = require('path');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Initialize Firebase Admin with environment variable support
let serviceAccount;
try {
  // Try to load from file first (local development)
  serviceAccount = require('./serviceAccountKey.json');
} catch (error) {
  // For production on Render, use environment variable
  if (process.env.FIREBASE_CONFIG) {
    serviceAccount = JSON.parse(process.env.FIREBASE_CONFIG);
  } else {
    console.error('ERROR: No Firebase configuration found!');
    process.exit(1);
  }
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

console.log('✅ Firebase Admin initialized successfully');

// ============ API ROUTES ============

// Save game score
app.post('/api/scores', async (req, res) => {
  try {
    const { playerName, score, level, userId } = req.body;
    
    if (!playerName || score === undefined) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    const scoreData = {
      playerName,
      score: Number(score),
      level: level || 1,
      userId: userId || null,
      date: new Date().toISOString(),
      timestamp: Date.now()
    };
    
    const docRef = await db.collection('scores').add(scoreData);
    res.status(201).json({ id: docRef.id, ...scoreData });
  } catch (error) {
    console.error('Error saving score:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get top scores
app.get('/api/scores/top', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const topScores = await db.collection('scores')
      .orderBy('score', 'desc')
      .limit(Math.min(limit, 50))
      .get();
    
    const scores = [];
    topScores.forEach(doc => {
      scores.push({ id: doc.id, ...doc.data() });
    });
    
    res.json({ success: true, scores });
  } catch (error) {
    console.error('Error getting top scores:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get player's best score
app.get('/api/scores/player/:name', async (req, res) => {
  try {
    const playerName = decodeURIComponent(req.params.name);
    const playerScores = await db.collection('scores')
      .where('playerName', '==', playerName)
      .orderBy('score', 'desc')
      .limit(1)
      .get();
    
    let bestScore = null;
    playerScores.forEach(doc => {
      bestScore = { id: doc.id, ...doc.data() };
    });
    
    res.json(bestScore || { success: true, message: 'No scores found' });
  } catch (error) {
    console.error('Error getting player score:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get user stats (for your game)
app.get('/api/user/:userId/stats', async (req, res) => {
  try {
    const { userId } = req.params;
    
    // Get user's scores
    const userScores = await db.collection('scores')
      .where('userId', '==', userId)
      .orderBy('score', 'desc')
      .limit(10)
      .get();
    
    const scores = [];
    userScores.forEach(doc => {
      scores.push({ id: doc.id, ...doc.data() });
    });
    
    // Calculate stats
    const totalGames = scores.length;
    const bestScore = scores.length > 0 ? scores[0].score : 0;
    const averageScore = totalGames > 0 
      ? Math.round(scores.reduce((sum, s) => sum + s.score, 0) / totalGames) 
      : 0;
    
    res.json({
      success: true,
      stats: {
        totalGames,
        bestScore,
        averageScore,
        recentScores: scores.slice(0, 5)
      }
    });
  } catch (error) {
    console.error('Error getting user stats:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get global leaderboard with pagination
app.get('/api/leaderboard', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;
    
    // Get total count
    const totalSnapshot = await db.collection('scores').count().get();
    const total = totalSnapshot.data().count;
    
    // Get paginated scores
    const scoresQuery = await db.collection('scores')
      .orderBy('score', 'desc')
      .limit(limit)
      .get();
    
    const scores = [];
    scoresQuery.forEach(doc => {
      scores.push({ rank: scores.length + 1 + offset, id: doc.id, ...doc.data() });
    });
    
    res.json({
      success: true,
      data: scores,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Error getting leaderboard:', error);
    res.status(500).json({ error: error.message });
  }
});

// Submit game result (combined endpoint)
app.post('/api/game/result', async (req, res) => {
  try {
    const { playerName, score, gameType, userId, metadata } = req.body;
    
    const gameResult = {
      playerName,
      score: Number(score),
      gameType: gameType || 'casino_shuffle',
      userId: userId || null,
      metadata: metadata || {},
      date: new Date().toISOString(),
      timestamp: Date.now()
    };
    
    const docRef = await db.collection('gameResults').add(gameResult);
    
    // Check if this is a high score
    const isHighScore = await checkIfHighScore(playerName, score);
    
    res.status(201).json({ 
      success: true, 
      id: docRef.id, 
      isHighScore,
      message: isHighScore ? '🎉 New High Score!' : 'Score saved successfully'
    });
  } catch (error) {
    console.error('Error saving game result:', error);
    res.status(500).json({ error: error.message });
  }
});

// Helper function to check high scores
async function checkIfHighScore(playerName, score) {
  try {
    const playerBest = await db.collection('scores')
      .where('playerName', '==', playerName)
      .orderBy('score', 'desc')
      .limit(1)
      .get();
    
    let currentBest = 0;
    playerBest.forEach(doc => {
      currentBest = doc.data().score;
    });
    
    return score > currentBest;
  } catch (error) {
    console.error('Error checking high score:', error);
    return false;
  }
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    name: 'Flappy777 Game Backend',
    version: '1.0.0',
    status: 'running',
    endpoints: [
      'GET  /health',
      'GET  /',
      'POST /api/scores',
      'GET  /api/scores/top',
      'GET  /api/scores/player/:name',
      'GET  /api/user/:userId/stats',
      'GET  /api/leaderboard',
      'POST /api/game/result'
    ]
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: `Cannot ${req.method} ${req.url}` });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 Health check: http://localhost:${PORT}/health`);
  console.log(`🎮 API ready: http://localhost:${PORT}/api`);
});