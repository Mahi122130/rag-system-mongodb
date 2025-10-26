import { MongoClient } from "mongodb";
import dotenv from "dotenv";
dotenv.config();

const client = new MongoClient(process.env.MONGO_URI);

async function test() {
  try {
    await client.connect();
    const db = client.db("rag");
    const coll = db.collection("documents");
    console.log("✅ Connected to MongoDB Atlas!");
    console.log("Existing collections:", await db.listCollections().toArray());
  } catch (e) {
    console.error("❌ Connection error:", e);
  } finally {
    await client.close();
  }
}

test();
