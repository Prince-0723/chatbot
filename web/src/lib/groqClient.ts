import Groq from "groq-sdk";

function assertEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name} in environment`);
  return value;
}

export const groq = new Groq({ apiKey: assertEnv("GROQ_API_KEY") });

