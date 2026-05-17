import dns from "dns";
import mongoose from "mongoose";

// Force IPv4 + reliable DNS servers
dns.setServers(["8.8.8.8", "1.1.1.1"]);
dns.setDefaultResultOrder("ipv4first");

function normalizeMongoUri(raw) {
  const s = (raw ?? "").trim();
  if (!s) return "";

  const srvIdx = s.indexOf("mongodb+srv://");
  if (srvIdx >= 0) return s.slice(srvIdx);

  const stdIdx = s.indexOf("mongodb://");
  if (stdIdx >= 0) return s.slice(stdIdx);

  return s;
}

export async function connectMongo() {
  try {
    const mongoUri = normalizeMongoUri(process.env.MONGODB_URI);

    if (!mongoUri) {
      throw new Error(
        'Missing MONGODB_URI. Put it in back/.env'
      );
    }

    // Already connected
    if (mongoose.connection.readyState === 1) {
      console.log("✅ MongoDB already connected");
      return mongoose;
    }

    const dbName = process.env.MONGODB_DB?.trim();

    await mongoose.connect(mongoUri, {
      dbName: dbName || undefined,
      serverSelectionTimeoutMS: 10000,
      family: 4, // Force IPv4
    });

    console.log("✅ MongoDB Connected Successfully");

    return mongoose;
  } catch (err) {
    console.error("❌ MongoDB Connection Error:");
    console.error(err);

    process.exit(1);
  }
}