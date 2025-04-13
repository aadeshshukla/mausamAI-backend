const express = require('express');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// POST /chat
app.post('/chat', async (req, res) => {
  const { message } = req.body;

  try {
    const response = await axios.post(
      'https://api.together.xyz/v1/chat/completions',
      {
        model: 'meta-llama/Llama-3-8b-chat-hf',
        messages: [{ role: 'user', content: message }],
        temperature: 0.7,
        max_tokens: 250,
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.TOGETHER_API_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const reply = response.data.choices[0].message.content;
    res.json({ reply });
  } catch (error) {
    console.error('Together.ai Error:', error?.response?.data || error.message);
    res.status(500).json({ error: 'Something went wrong with LLaMA 3.3 API' });
  }
});

// Start server
app.listen(5000, () => {
  console.log('✅ mausamAI backend is live on http://localhost:5000');
});



