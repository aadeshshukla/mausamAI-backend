const express = require('express');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

app.post('/chat', async (req, res) => {
  const { message } = req.body;

  try {
    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        // Llama 4 Scout is highly optimized for speed and quality in 2026
        model: "meta-llama/llama-4-scout-17b-16e-instruct", 
        messages: [
          { 
            role: "system", 
            content: "You are mausamAI, a helpful assistant developed by Aadesh Shukla." 
          },
          { role: "user", content: message }
        ],
        temperature: 0.7,
        max_tokens: 1024,
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const reply = response.data.choices[0].message.content;
    res.json({ reply });

  } catch (error) {
    console.error('Groq API Error:', error?.response?.data || error.message);
    res.status(500).json({ error: 'mausamAI is temporarily unavailable' });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'mausamAI backend is running on Groq' });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`mausamAI backend running on http://localhost:${PORT}`);
});
