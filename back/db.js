import mongoose from "mongoose";

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
  const mongoUri = normalizeMongoUri(process.env.MONGODB_URI);
  if (!mongoUri) {
    throw new Error(
      'Missing MONGODB_URI. Put it in back/.env (example: MONGODB_URI="mongodb+srv://...").'
    );
  }

  if (mongoose.connection.readyState === 1) return mongoose;

  const dbName = process.env.MONGODB_DB?.trim();
  await mongoose.connect(mongoUri, {
    dbName: dbName || undefined,
    serverSelectionTimeoutMS: 10_000,
  });

  return mongoose;
}

