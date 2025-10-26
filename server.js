import express from 'express';
import { MongoClient } from 'mongodb';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

// Serve the main HTML page
app.get('/', (req, res) => {
  const htmlPath = join(__dirname, 'public', 'index.html');
  try {
    const html = readFileSync(htmlPath, 'utf8');
    res.send(html);
  } catch (error) {
    res.json({ 
      message: 'RAG System - MongoDB Storage',
      status: 'Server is running!'
    });
  }
});

// Health check
app.get('/health', async (req, res) => {
  try {
    const client = new MongoClient(process.env.MONGO_URI);
    await client.connect();
    await client.db('admin').command({ ping: 1 });
    
    const db = client.db('rag');
    const collection = db.collection('documents');
    const count = await collection.countDocuments();
    
    await client.close();
    
    res.json({ 
      status: 'healthy',
      database: 'connected',
      documents_in_db: count
    });
  } catch (error) {
    res.status(500).json({ 
      status: 'unhealthy', 
      error: 'Cannot connect to MongoDB'
    });
  }
});

// Get embeddings from Voyage AI
async function getEmbeddings(texts) {
  if (!Array.isArray(texts)) {
    texts = [texts];
  }

  try {
    const response = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.VOYAGE_API_KEY}`
      },
      body: JSON.stringify({
        input: texts,
        model: 'voyage-2',
        input_type: 'document'
      })
    });

    if (!response.ok) {
      throw new Error(`Voyage AI API error: ${response.status}`);
    }

    const data = await response.json();
    return data.data.map(item => item.embedding);
  } catch (error) {
    console.error('Embedding error:', error);
    throw error;
  }
}

// Chunk text for better processing
function chunkText(text, chunkSize = 400) {
  if (!text || typeof text !== 'string') return [];
  
  const cleanText = text.replace(/\s+/g, ' ').trim();
  if (cleanText.length <= chunkSize) {
    return [cleanText];
  }
  
  const chunks = [];
  let start = 0;
  
  while (start < cleanText.length) {
    let end = start + chunkSize;
    
    // Try to break at sentence end
    if (end < cleanText.length) {
      const sentenceEnd = cleanText.lastIndexOf('.', end);
      if (sentenceEnd > start + chunkSize * 0.6) {
        end = sentenceEnd + 1;
      }
    }
    
    const chunk = cleanText.slice(start, end).trim();
    if (chunk.length > 0) {
      chunks.push(chunk);
    }
    
    start = end;
  }
  
  return chunks;
}

// Calculate similarity between vectors
function cosineSimilarity(vecA, vecB) {
  if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
  
  const dotProduct = vecA.reduce((sum, val, i) => sum + val * vecB[i], 0);
  const magnitudeA = Math.sqrt(vecA.reduce((sum, val) => sum + val * val, 0));
  const magnitudeB = Math.sqrt(vecB.reduce((sum, val) => sum + val * val, 0));
  
  if (magnitudeA === 0 || magnitudeB === 0) return 0;
  return dotProduct / (magnitudeA * magnitudeB);
}

// Connect to MongoDB
async function connectToMongo() {
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  return client;
}

// Add document to MongoDB
app.post('/ingest', async (req, res) => {
  let client;
  try {
    const { docId, text, metadata = {} } = req.body;
    
    if (!docId || !text) {
      return res.status(400).json({ 
        success: false,
        error: "Document ID and text are required" 
      });
    }

    console.log(`Adding document to MongoDB: ${docId}`);
    
    // Create chunks
    const chunks = chunkText(text);
    if (chunks.length === 0) {
      return res.status(400).json({
        success: false,
        error: "No valid text found"
      });
    }

    // Generate embeddings
    const embeddings = await getEmbeddings(chunks);

    // Store in MongoDB
    client = await connectToMongo();
    const db = client.db('rag');
    const collection = db.collection('documents');

    // Remove existing document
    await collection.deleteMany({ docId });

    // Prepare documents for MongoDB
    const documents = chunks.map((chunkText, idx) => ({
      docId,
      chunkIndex: idx,
      text: chunkText,
      embedding: embeddings[idx],
      metadata: {
        title: metadata.title || docId,
        category: metadata.category || 'general',
        totalChunks: chunks.length
      },
      createdAt: new Date()
    }));

    // Insert into MongoDB
    const result = await collection.insertMany(documents);

    res.json({ 
      success: true, 
      message: "Document stored in MongoDB successfully!",
      docId,
      chunks: chunks.length
    });
    
  } catch (error) {
    console.error("Error adding document:", error);
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  } finally {
    if (client) {
      await client.close();
    }
  }
});

// Ask question - Search only from MongoDB - FIXED ANSWER GENERATION
app.post('/query', async (req, res) => {
  let client;
  try {
    const { q } = req.body;
    
    if (!q) {
      return res.status(400).json({ 
        success: false,
        error: "Question is required" 
      });
    }

    console.log(`Searching MongoDB for: "${q}"`);

    // Generate query embedding
    const [queryEmbedding] = await getEmbeddings([q]);

    // Get all documents from MongoDB
    client = await connectToMongo();
    const db = client.db('rag');
    const collection = db.collection('documents');

    const allDocs = await collection.find({}).toArray();

    if (allDocs.length === 0) {
      return res.json({
        success: true,
        answer: "I don't have any information in my database yet. Please add some documents first.",
        confidence: 0
      });
    }

    // Calculate similarities
    const scoredDocs = allDocs.map(doc => ({
      ...doc,
      score: cosineSimilarity(queryEmbedding, doc.embedding || [])
    }));

    // Sort by relevance
    scoredDocs.sort((a, b) => b.score - a.score);
    const topDocs = scoredDocs.slice(0, 3); // Top 3 most relevant

    console.log(`Best match score: ${topDocs[0]?.score?.toFixed(3)}`);

    // FIXED: Only answer if we have STRONG matches
    let answer = "I'm sorry, but I don't have information about that in my knowledge base. Please ask me something about the documents you've provided.";
    let confidence = 0;

    // Only provide answer if we have VERY good matches (strict threshold)
    if (topDocs.length > 0 && topDocs[0].score > 0.7) {
      const bestMatch = topDocs[0];
      confidence = bestMatch.score;
      answer = bestMatch.text;
    } else if (topDocs.length > 0 && topDocs[0].score > 0.6) {
      // High confidence but not perfect
      const bestMatch = topDocs[0];
      confidence = bestMatch.score;
      answer = `Based on my knowledge: ${bestMatch.text}`;
    }
    // For scores below 0.6, we use the default "I don't know" answer

    res.json({
      success: true,
      answer: answer,
      confidence: Math.round(confidence * 100)
    });
    
  } catch (error) {
    console.error("Search error:", error);
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  } finally {
    if (client) {
      await client.close();
    }
  }
});

// Get document count from MongoDB
app.get('/documents', async (req, res) => {
  let client;
  try {
    client = await connectToMongo();
    const db = client.db('rag');
    const collection = db.collection('documents');

    const count = await collection.countDocuments();

    res.json({
      success: true,
      count: count,
      message: `MongoDB has ${count} document chunks`
    });
    
  } catch (error) {
    console.error("Error counting documents:", error);
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  } finally {
    if (client) {
      await client.close();
    }
  }
});

// Clear MongoDB documents
app.delete('/documents', async (req, res) => {
  let client;
  try {
    client = await connectToMongo();
    const db = client.db('rag');
    const collection = db.collection('documents');

    const result = await collection.deleteMany({});

    res.json({
      success: true,
      message: `Cleared ${result.deletedCount} documents from MongoDB`
    });
    
  } catch (error) {
    console.error("Error clearing documents:", error);
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  } finally {
    if (client) {
      await client.close();
    }
  }
});

// Load your specific data into MongoDB
app.post('/load-my-data', async (req, res) => {
  let client;
  try {
    const myData = [
      {
        docId: "csec-lab-1",
        text: "csec-lab is good environment",
        metadata: { title: "CSEC Lab Environment", category: "academic" }
      },
      {
        docId: "csec-lab-2", 
        text: "csec-lab contains around 400 students",
        metadata: { title: "CSEC Lab Student Count", category: "academic" }
      },
      {
        docId: "csec-astu-1",
        text: "csec-astu has 4 division", 
        metadata: { title: "CSEC ASTU Divisions", category: "academic" }
      },
      {
        docId: "csec-dev-1",
        text: "csec-dev has around 50 members",
        metadata: { title: "CSEC Dev Members", category: "academic" }
      },
      {
        docId: "general-1",
        text: "sky is blue",
        metadata: { title: "General Fact", category: "general" }
      },
      {
        docId: "personal-1",
        text: "abebe eats beso",
        metadata: { title: "Personal Habit", category: "personal" }
      },
      {
        docId: "location-1",
        text: "astu is found in adama",
        metadata: { title: "ASTU Location", category: "location" }
      },
      {
        docId: "location-2",
        text: "adama is a beautiful city",
        metadata: { title: "Adama City", category: "location" }
      },
      {
        docId: "location-3", 
        text: "addis abeba is different from adama",
        metadata: { title: "City Comparison", category: "location" }
      },
      {
        docId: "csec-lab-3",
        text: "csec-lab has been created since 2023",
        metadata: { title: "CSEC Lab Creation", category: "academic" }
      }
    ];

    let totalChunks = 0;

    client = await connectToMongo();
    const db = client.db('rag');
    const collection = db.collection('documents');

    // Clear existing data
    await collection.deleteMany({});

    // Add all documents to MongoDB
    for (const doc of myData) {
      const chunks = chunkText(doc.text);
      if (chunks.length === 0) continue;
      
      const embeddings = await getEmbeddings(chunks);
      
      const documents = chunks.map((chunkText, idx) => ({
        docId: doc.docId,
        chunkIndex: idx,
        text: chunkText,
        embedding: embeddings[idx],
        metadata: doc.metadata,
        createdAt: new Date()
      }));

      await collection.insertMany(documents);
      totalChunks += chunks.length;
    }

    res.json({
      success: true,
      message: "Your data loaded into MongoDB successfully!",
      documents_added: myData.length,
      chunks_created: totalChunks
    });
    
  } catch (error) {
    console.error("Error loading data:", error);
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  } finally {
    if (client) {
      await client.close();
    }
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 MongoDB RAG Server running on http://localhost:${PORT}`);
  console.log('💾 All data stored in MongoDB Atlas');
  console.log('❓ Ask questions to search from MongoDB');
});