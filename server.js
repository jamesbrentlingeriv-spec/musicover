require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const SITE_URL = process.env.SITE_URL || process.env.VERCEL_URL || 'http://localhost:3000';
const SITE_NAME = process.env.SITE_NAME || 'Musicovery';

// ---------- API ROUTES (defined BEFORE static middleware) ----------

// Let the frontend know if a server-side API key is already configured
app.get('/api/key-status', (req, res) => {
  const hasKey = !!(OPENROUTER_API_KEY && OPENROUTER_API_KEY.trim() !== '' && OPENROUTER_API_KEY !== 'your-openrouter-api-key-here');
  res.json({ serverKeyConfigured: hasKey });
});

app.post('/api/recommend', async (req, res) => {
  console.log('>>> POST /api/recommend received');

  const { query, popularityBias, apiKey } = req.body;

  // Use apiKey from request body, fall back to env variable
  const effectiveApiKey = (apiKey && apiKey.trim()) || OPENROUTER_API_KEY || '';

  if (!effectiveApiKey || effectiveApiKey === 'your-openrouter-api-key-here') {
    return res.status(400).json({ error: 'Please enter your OpenRouter API key. Get one free at https://openrouter.ai/keys' });
  }

  if (!query || query.trim().length === 0) {
    return res.status(400).json({ error: 'Please enter a song or artist.' });
  }

  const popBias = Math.max(0, Math.min(100, parseInt(popularityBias) || 50));
  const indieBias = 100 - popBias;

  let popularityGuidance = '';
  if (popBias <= 20) {
    popularityGuidance = '80-90% of recommendations MUST be underground/indie/obscure. Avoid mainstream entirely.';
  } else if (popBias <= 40) {
    popularityGuidance = '60-70% indie/underground, 30-40% somewhat known. Prioritize hidden gems.';
  } else if (popBias <= 60) {
    popularityGuidance = '50/50 mix of indie/underground and mainstream/popular.';
  } else if (popBias <= 80) {
    popularityGuidance = '60-70% mainstream/popular, 30-40% indie/underground. Favor well-known names.';
  } else {
    popularityGuidance = '80-90% mainstream/popular/chart-topping. Only very well-known acts.';
  }

  const systemPrompt = `You are a music recommendation engine. ${popularityGuidance}

CRITICAL: You must FIRST detect what the user is searching for:
- If the query mentions a specific SONG (e.g. "Bohemian Rhapsody by Queen", "Blinding Lights", "song: Hotel California"), then ALL 10 recommendations MUST be specific SONGS similar to that song. Each "name" field should be the song title, and the search queries should be "song+title+artist+name" format.
- If the query is just an ARTIST name (e.g. "Radiohead", "Taylor Swift", "artist: Kendrick Lamar"), then ALL 10 recommendations MUST be similar ARTISTS. Each "name" field should be the artist name.

For SONG queries, each recommendation object must have:
- "name": the SONG title (e.g. "Stairway to Heaven")
- "type": "song"
- For Spotify/YouTube/Bandcamp/SoundCloud queries, include BOTH the song title AND artist name (e.g. "stairway+to+heaven+led+zeppelin")

For ARTIST queries, each recommendation object must have:
- "name": the ARTIST name
- "type": "artist"
- Search queries can just be the artist name

Respond with ONLY valid JSON, no markdown, no extra text:
{
  "query_type": "song" or "artist",
  "query_name": "the song or artist name",
  "recommendations": [
    {
      "name": "Song Title or Artist Name",
      "type": "song" or "artist",
      "genre": "genre",
      "year": "approx year or null",
      "description": "1 sentence why this matches the vibe/sound/style",
      "popularityLevel": "underground|indie|mid|mainstream|superstar",
      "spotifyQuery": "url-encoded search query",
      "youtubeQuery": "url-encoded search query",
      "bandcampQuery": "url-encoded search query",
      "soundcloudQuery": "url-encoded search query"
    }
  ]
}
Rules: exactly 10 recommendations, NEVER include the original query, be sonically/style similar, use real searchable query strings.`;

  const userPrompt = `Find music similar to: "${query}". The user wants ${popBias}% mainstream / ${indieBias}% indie bias. First, determine if this is a SONG or an ARTIST query. If it's a specific song, return 10 similar SONGS (each with artist name in search queries). If it's just an artist, return 10 similar ARTISTS. Be specific and accurate.`;

  try {
    const response = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${effectiveApiKey}`,
        'HTTP-Referer': SITE_URL,
        'X-Title': SITE_NAME
      },
      body: JSON.stringify({
        model: 'openai/gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.8,
        max_tokens: 2000
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('OpenRouter error:', response.status, errText.slice(0, 200));
      return res.status(502).json({ error: 'AI service error. Please try again.', details: errText.slice(0, 200) });
    }

    const data = await response.json();
    let content = data.choices[0].message.content.trim();

    // Strip markdown fences
    content = content.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?\s*```$/i, '');

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      const match = content.match(/\{[\s\S]*\}/);
      if (match) {
        parsed = JSON.parse(match[0]);
      } else {
        console.error('Parse failed. Content:', content.slice(0, 400));
        return res.status(500).json({ error: 'AI response parse error. Try again.' });
      }
    }

    if (!parsed.recommendations || !Array.isArray(parsed.recommendations)) {
      return res.status(500).json({ error: 'AI response missing recommendations. Try again.' });
    }

    console.log(`>>> Returning ${parsed.recommendations.length} recommendations`);
    res.json(parsed);

  } catch (err) {
    console.error('Server error:', err.message);
    res.status(500).json({ error: 'Server error. Please try again.', details: err.message });
  }
});

// ---------- STATIC FILES (MUST come AFTER API routes) ----------
app.use(express.static('public'));

// Export for Vercel serverless
module.exports = app;

// Only listen when running locally (not on Vercel)
if (process.env.VERCEL !== '1') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Musicovery server running at http://localhost:${PORT}`);
    console.log(`Endpoints: POST /api/recommend, GET / (index.html)`);
    if (!OPENROUTER_API_KEY || OPENROUTER_API_KEY === 'your-openrouter-api-key-here') {
      console.log('WARNING: No valid OPENROUTER_API_KEY found. Set it in .env file.');
    }
  });
}
