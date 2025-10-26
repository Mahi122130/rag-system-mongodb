import fetch from 'node-fetch';

// Test with your current key
const API_KEY = "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";

async function testOpenAI() {
  try {
    console.log('🔑 Testing OpenAI API Key...');
    
    const response = await fetch("https://api.openai.com/v1/models", {
      headers: {
        "Authorization": `Bearer ${API_KEY}`
      }
    });

    console.log('Status:', response.status);
    
    if (!response.ok) {
      const error = await response.text();
      console.log('❌ API Key Invalid:', error);
      console.log('\n💡 Solution: Get a new API key from https://platform.openai.com/api-keys');
    } else {
      const data = await response.json();
      console.log('✅ API Key Valid! Available models:', data.data.length);
    }
  } catch (error) {
    console.log('❌ Network Error:', error.message);
  }
}

testOpenAI();